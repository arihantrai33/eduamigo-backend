/* eslint-disable no-console */
// One staged load test on this machine, end to end and self-contained:
//   node loadtests/stage.js --stage A                      (A is the default; B..F need only --stage; G, H, I also need --confirm-high)
//   node loadtests/stage.js --stage C --hold 1m --ramp 20s  (shorter run while developing)
//
// It starts a THROWAWAY in-memory MongoDB (database "<stage>_loadtest"), seeds synthetic schools into it, starts the API against it, runs
// k6 (loadtests/k6/journeys.js), samples CPU / memory / MongoDB while it runs, then checks the data (verify.js) and the school separation
// (isolation-check.js). It never reads MONGO_URI from .env, never talks to a real database, and blanks every external-service key.
// It runs ONE stage and stops: it never moves to the next one by itself.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : fallback; };
const stages = require('./stages.json');
const STAGE = String(arg('stage', 'A')).toUpperCase();
const cfg = stages[STAGE];
if (!cfg) { console.error(`Unknown stage "${STAGE}". Stages: ${Object.keys(stages).join(', ')}`); process.exit(2); }
const VUS = Number(arg('vus', cfg.vus));
const HOLD = String(arg('hold', cfg.hold));
const toSec = (d) => { const m = /^(\d+)(s|m|h)$/.exec(d); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]] : 0; };
const RAMP = String(arg('ramp', `${Math.max(30, Math.round(toSec(HOLD) * 0.2))}s`));
const COOL = String(arg('cool', '30s'));
const MIX = String(arg('mix', 'student:40,parent:25,teacher:20,admin:15'));
const PORT = Number(arg('port', 8101));
const MAX_SHARE = 5;                       // most virtual users that may sign in with one account (login limit is 10 per 15 min per account)
const MIN_FREE_GB = Number(arg('min-free-gb', 1.5));
const RUN = `${STAGE}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
const OUT = path.join(__dirname, 'results', RUN);
const SEED_FILE = path.join(__dirname, 'data/stage-seed.json');

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch (e) { return ''; } };
const GB = 1024 ** 3;

// ---- refuse anything that is not clearly local and approved
function refuse(msg) { console.error(`REFUSED: ${msg}`); process.exit(2); }
if (cfg.confirm && !arg('confirm-high', false)) refuse(`Stage ${STAGE} (${VUS} users) needs your explicit approval: add --confirm-high`);
if (STAGE === 'I') {
  const prev = path.join(__dirname, 'results', 'latest-H.json');
  if (!fs.existsSync(prev) || JSON.parse(fs.readFileSync(prev, 'utf8')).verdict !== 'PASS') refuse('Stage I only runs after Stage H passed (no passing results/latest-H.json)');
}
const total = MIX.split(',').reduce((t, p) => t + Number(p.split(':')[1]), 0);
const weight = (role) => Number((MIX.split(',').find((p) => p.startsWith(`${role}:`)) || `${role}:0`).split(':')[1]) / total;

// ---- how many schools and accounts the stage needs
const adminVUs = Math.ceil(VUS * weight('admin'));
const SCHOOLS = Math.max(3, Math.ceil(adminVUs / MAX_SHARE));
const studentVUs = Math.max(VUS * weight('student'), VUS * weight('parent'));
const PER_SCHOOL = Math.max(100, Math.ceil(studentVUs / MAX_SHARE / SCHOOLS / 20) * 20);

let children = [];
const kill = () => children.forEach((c) => { try { c.kill('SIGTERM'); } catch (e) { /* already gone */ } });
process.on('SIGINT', () => { kill(); process.exit(130); });
process.on('SIGTERM', () => { kill(); process.exit(143); });

function run(cmd, args, env, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(cmd, args, { env, stdio: ['ignore', out, out] });
  children.push(child);
  return child;
}
const done = (child) => new Promise((resolve) => child.on('exit', (code) => resolve(code)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function availableGB() {            // free + inactive + speculative pages: what macOS can hand out without swapping
  const vm = sh('vm_stat', []); if (!vm) return os.freemem() / GB;
  const page = Number((/page size of (\d+) bytes/.exec(vm) || [])[1] || 16384);
  const n = (label) => Number((new RegExp(`${label}:\\s+(\\d+)`).exec(vm) || [])[1] || 0);
  return ((n('Pages free') + n('Pages inactive') + n('Pages speculative')) * page) / GB;
}
function procStats(pids) {          // [{pid, cpu, rssMB}] from ps
  if (!pids.length) return [];
  return sh('ps', ['-o', 'pid=,%cpu=,rss=', '-p', pids.join(',')]).trim().split('\n').filter(Boolean).map((l) => { const [pid, cpu, rss] = l.trim().split(/\s+/); return { pid: Number(pid), cpu: Number(cpu), rssMB: Math.round(Number(rss) / 1024) }; });
}
const systemCpuPct = () => Math.min(100, sh('ps', ['-A', '-o', '%cpu=']).split('\n').reduce((t, v) => t + (Number(v) || 0), 0) / os.cpus().length);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)}  ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(OUT, 'run.log'), `${line}\n`); };
  log(`Stage ${STAGE}: ${VUS} users, hold ${HOLD}, ramp ${RAMP}, cool ${COOL}. Run ${RUN}. ${os.cpus().length} CPUs, ${(os.totalmem() / GB).toFixed(0)} GB, ${availableGB().toFixed(1)} GB available now.`);
  log(`Seed: ${SCHOOLS} schools x ${PER_SCHOOL} students (so no account is used by more than ${MAX_SHARE} users).`);
  if (availableGB() < MIN_FREE_GB + 1) refuse(`Only ${availableGB().toFixed(1)} GB of memory is available; close some apps first (need ${MIN_FREE_GB + 1} GB)`);

  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  const dbName = `stage${STAGE.toLowerCase()}_loadtest`;
  const uri = `${mongo.getUri()}${dbName}`;
  const host = new URL(uri.replace('mongodb://', 'http://')).hostname;
  if (!['127.0.0.1', 'localhost'].includes(host) || !dbName.endsWith('_loadtest')) { await mongo.stop(); refuse(`database ${host}/${dbName} is not a local throwaway test database`); }
  log(`Database: in-memory MongoDB on ${host}, database ${dbName} (thrown away when this ends).`);

  // Everything the child processes need is set here; nothing external is reachable.
  const env = {
    ...process.env, MONGO_URI: uri, NODE_ENV: 'development', PORT: String(PORT), DISABLE_JOBS: 'true', LOADTEST_SEED_OK: 'yes',
    JWT_SECRET: 'stage-loadtest-secret-that-is-long-enough-0123456789', CORS_ORIGINS: '',
    BCRYPT_ROUNDS: '10',                                                   // the production password cost, so sign-in is as expensive as in real life
    EMAIL_PROVIDER: 'log', PHOTO_STORAGE: 'local', SMS_PROVIDER: 'off',
    GEMINI_API_KEY: '', AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', AZURE_SPEECH_KEY: '', ASSISTANT_PROVIDERS: '',
    CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '',
    // One load generator looks like a single visitor, so the general per-address limits are raised on this test server only.
    // The sign-in limits stay at their production values (10 per 15 min per account), which is why accounts are not shared widely.
    API_ANON_PER_MINUTE: '100000000', API_USER_PER_MINUTE: '100000000', PUBLIC_LOOKUP_PER_MINUTE: '100000000', RATE_LIMIT_STORE: 'mongo',
  };
  const mongodPid = mongo.instanceInfo && mongo.instanceInfo.instance && mongo.instanceInfo.instance.mongodProcess ? mongo.instanceInfo.instance.mongodProcess.pid : undefined;

  try {
    // 1. seed
    const t0 = Date.now();
    const seeded = await done(run('node', [path.join(__dirname, 'seed.js'), '--schools', String(SCHOOLS), '--students', String(PER_SCHOOL), '--out', SEED_FILE], env, path.join(OUT, 'seed.log')));
    if (seeded !== 0) throw new Error(`seeding failed (see ${path.join(OUT, 'seed.log')})`);
    log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);

    // 2. server
    const lagFile = path.join(OUT, 'eventloop.json');
    const server = run('node', [path.join(__dirname, '../server.js')], { ...env, LAG_FILE: lagFile, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(__dirname, 'lagprobe.js')}`.trim() }, path.join(OUT, 'server.log'));
    const base = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 60; i += 1) { if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) break; if (i === 59) throw new Error('the server did not start'); await sleep(500); }
    log(`Server up on ${base} (pid ${server.pid}).`);

    // 3. database profiler (this throwaway database only)
    const mongoose = require('mongoose');
    const conn = await mongoose.createConnection(uri).asPromise();
    await conn.db.command({ profile: 1, slowms: 100 });

    // 4. k6 plus samplers
    const summaryFile = path.join(OUT, 'k6-summary.json');
    const k6 = run('k6', ['run', '--quiet', path.join(__dirname, 'k6/journeys.js')], {
      ...process.env, BASE_URL: base, SEED_FILE: SEED_FILE, VUS: String(VUS), HOLD, RAMP, COOL, MIX, RUN_ID: RUN, SUMMARY_FILE: summaryFile, PROBE_RATE: String(arg('probe-rate', '0.04')),
    }, path.join(OUT, 'k6.log'));
    const samples = []; let stopReason = ''; let lowMem = 0; const started = Date.now();
    const exited = done(k6);
    let k6Done = false; exited.then(() => { k6Done = true; });
    while (!k6Done) {
      await sleep(2000);
      const avail = availableGB(); const cpu = systemCpuPct();
      const [s] = procStats([server.pid]); const [g] = procStats([k6.pid]); const [m] = procStats(mongodPid ? [mongodPid] : []);
      let db = {}; try { const st = await conn.db.admin().command({ serverStatus: 1 }); db = { conns: st.connections.current, available: st.connections.available, ops: Object.values(st.opcounters).reduce((a, b) => a + b, 0) }; } catch (e) { db = { error: String(e.message).slice(0, 80) }; }
      samples.push({ t: Math.round((Date.now() - started) / 1000), availGB: Number(avail.toFixed(2)), sysCpu: Math.round(cpu), app: s, k6: g, mongod: m, db });
      if (avail < MIN_FREE_GB) lowMem += 1; else lowMem = 0;
      if (lowMem >= 2) { stopReason = `host memory low (${avail.toFixed(1)} GB available)`; }
      if (!s) stopReason = stopReason || 'the application process stopped';
      if (mongodPid && !m) stopReason = stopReason || 'MongoDB stopped';
      if (stopReason) { log(`STOPPING the stage: ${stopReason}`); k6.kill('SIGTERM'); await sleep(3000); break; }
    }
    const k6Code = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
    log(`k6 finished (exit code ${k6Code}).`);
    fs.writeFileSync(path.join(OUT, 'samples.json'), JSON.stringify(samples));
    await sleep(3000); // let the application settle

    // 5. what the database saw
    let lag = []; try { lag = JSON.parse(fs.readFileSync(lagFile, 'utf8')); } catch (e) { /* no probe output */ }
    const slow = await conn.db.collection('system.profile').aggregate([{ $match: { op: { $in: ['query', 'command', 'update', 'insert', 'remove', 'getmore'] }, ns: { $not: /system\.profile/ } } },
      { $group: { _id: { ns: '$ns', op: '$op', plan: '$planSummary' }, n: { $sum: 1 }, maxMs: { $max: '$millis' }, avgMs: { $avg: '$millis' }, docs: { $max: '$docsExamined' } } }, { $sort: { maxMs: -1 } }, { $limit: 10 }]).toArray().catch(() => []);
    const connsPeak = Math.max(0, ...samples.map((x) => (x.db && x.db.conns) || 0));
    await conn.close();

    // 6. data checks and school separation, then recovery check
    const verifyCode = await done(run('node', [path.join(__dirname, 'verify.js')], env, path.join(OUT, 'verify.log')));
    const isoCode = await done(run('node', [path.join(__dirname, 'isolation-check.js')], { ...env, BASE_URL: base, SEED_FILE }, path.join(OUT, 'isolation.log')));
    const healthy = !!(await fetch(`${base}/api/health`).catch(() => null))?.ok;
    log(`verify.js ${verifyCode === 0 ? 'PASS' : 'FAIL'}, isolation-check.js ${isoCode === 0 ? 'PASS' : 'FAIL'}, application healthy after the run: ${healthy}`);

    // 7. read k6's own numbers
    const sum = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : null;
    const M = (n) => (sum && sum.metrics[n] && sum.metrics[n].values) || {};
    const dur = M('http_req_duration'); const reqs = M('http_reqs'); const failed = M('http_req_failed'); const checks = M('checks');
    const perEndpoint = {};
    if (sum) for (const k of Object.keys(sum.metrics)) {
      const mm = /^http_req_duration\{name:(.+)\}$/.exec(k); if (!mm) continue;
      const f = (sum.metrics[`http_req_failed{name:${mm[1]}}`] || { values: {} }).values;
      perEndpoint[mm[1]] = { n: Math.round((sum.metrics[k].values.count) || 0), p50: sum.metrics[k].values.med, p95: sum.metrics[k].values['p(95)'], p99: sum.metrics[k].values['p(99)'], max: sum.metrics[k].values.max, errorRate: f.rate };
    }
    const created = fs.readFileSync(path.join(OUT, 'k6.log'), 'utf8').split('\n').filter((l) => l.includes('CREATED ')).map((l) => { const m = /CREATED (\{.*?\})/.exec(l.replace(/\\"/g, '"')); try { return m && JSON.parse(m[1]); } catch (e) { return null; } }).filter(Boolean);
    fs.writeFileSync(path.join(OUT, 'created.json'), JSON.stringify({ run: RUN, database: dbName, items: created }));

    const hold = samples.filter((x) => x.t >= toSec(RAMP) && x.t <= toSec(RAMP) + toSec(HOLD));
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const peak = (arr) => Math.max(0, ...arr);
    const achieved = Math.round(M('vus_max').max || M('vus').max || 0);
    const hostCpuAvg = Math.round(avg(hold.map((x) => x.sysCpu)));
    const generatorOk = hostCpuAvg < 85 && !(avg(hold.map((x) => (x.k6 ? x.k6.cpu : 0))) > os.cpus().length * 70);
    const leaks = M('tenant_leaks').count || 0; const serverErr = M('server_error').rate || 0;

    const reasons = [];
    if (stopReason) reasons.push(`stopped early: ${stopReason}`);
    if (!sum) reasons.push('k6 produced no summary');
    if (dur['p(95)'] > 500) reasons.push(`p95 ${dur['p(95)'].toFixed(0)} ms is above 500 ms`);
    if (dur['p(99)'] > 1000) reasons.push(`p99 ${dur['p(99)'].toFixed(0)} ms is above 1000 ms`);
    if (failed.rate >= 0.01) reasons.push(`error rate ${(failed.rate * 100).toFixed(2)} % is 1 % or more`);
    if (checks.rate !== undefined && checks.rate < 0.99) reasons.push(`only ${(checks.rate * 100).toFixed(1)} % of checks passed`);
    if (serverErr >= 0.05) reasons.push(`5xx / no-answer rate ${(serverErr * 100).toFixed(1)} %`);
    if (leaks) reasons.push(`${leaks} cross-school responses`);
    if (achieved < VUS * 0.95) reasons.push(`only ${achieved} of ${VUS} users were reached`);
    if (verifyCode !== 0) reasons.push('verify.js found inconsistent data');
    if (isoCode !== 0) reasons.push('isolation-check.js found cross-school data');
    if (!healthy) reasons.push('the application did not answer after the run');
    const verdict = !generatorOk && reasons.length ? 'INCONCLUSIVE' : reasons.length ? 'FAIL' : 'PASS';

    const result = {
      run: RUN, stage: STAGE, verdict, reasons, target: { vus: VUS, hold: HOLD, ramp: RAMP, cool: COOL, mix: MIX }, achievedVUs: achieved, seed: { schools: SCHOOLS, studentsPerSchool: PER_SCHOOL },
      requests: { total: reqs.count, perSecond: reqs.rate }, latencyMs: { avg: dur.avg, p50: dur.med, p90: dur['p(90)'], p95: dur['p(95)'], p99: dur['p(99)'], max: dur.max },
      errorRate: failed.rate, serverErrorRate: serverErr, checksPassed: checks.rate, tenantLeaks: leaks, signedIn: M('signed_in_users').count, writes: M('writes_done').count,
      host: { cpus: os.cpus().length, totalGB: Math.round(os.totalmem() / GB), minAvailableGB: Number(Math.min(...samples.map((x) => x.availGB), 99).toFixed(1)), systemCpuAvgDuringHold: hostCpuAvg, generatorHealthy: generatorOk },
      application: { cpuAvg: Math.round(avg(hold.map((x) => (x.app ? x.app.cpu : 0)))), cpuPeak: peak(samples.map((x) => (x.app ? x.app.cpu : 0))), rssPeakMB: peak(samples.map((x) => (x.app ? x.app.rssMB : 0))) },
      loadGenerator: { cpuAvg: Math.round(avg(hold.map((x) => (x.k6 ? x.k6.cpu : 0)))), cpuPeak: peak(samples.map((x) => (x.k6 ? x.k6.cpu : 0))), rssPeakMB: peak(samples.map((x) => (x.k6 ? x.k6.rssMB : 0))) },
      mongodb: { cpuPeak: peak(samples.map((x) => (x.mongod ? x.mongod.cpu : 0))), rssPeakMB: peak(samples.map((x) => (x.mongod ? x.mongod.rssMB : 0))), connectionsPeak: connsPeak, slowOperations: slow },
      eventLoop: { p99MaxMs: Math.max(0, ...lag.map((x) => x.p99)), maxMs: Math.max(0, ...lag.map((x) => x.max)), windowsWithP99Over100ms: lag.filter((x) => x.p99 > 100).length, windows: lag.length },
      verify: verifyCode === 0, isolation: isoCode === 0, healthyAfter: healthy, perEndpoint, createdRecords: created.length,
    };
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(__dirname, 'results', `latest-${STAGE}.json`), JSON.stringify(result, null, 2));
    printSummary(result, log);
  } finally {
    kill();
    await mongo.stop().catch(() => {});
  }
}

function printSummary(r, log) {
  const ms = (v) => (v === undefined ? '-' : `${Math.round(v)} ms`);
  log('');
  log(`=== Stage ${r.stage}: ${r.verdict} ${r.reasons.length ? `(${r.reasons.join('; ')})` : ''}`);
  log(`users reached ${r.achievedVUs}/${r.target.vus}, requests ${r.requests.total} (${Math.round(r.requests.perSecond)}/s), signed in ${r.signedIn}, writes ${r.writes}`);
  log(`latency p50 ${ms(r.latencyMs.p50)}  p90 ${ms(r.latencyMs.p90)}  p95 ${ms(r.latencyMs.p95)}  p99 ${ms(r.latencyMs.p99)}  max ${ms(r.latencyMs.max)}`);
  log(`errors ${(r.errorRate * 100).toFixed(2)} %  5xx/none ${(r.serverErrorRate * 100).toFixed(2)} %  checks ${(r.checksPassed * 100).toFixed(1)} %  cross-school ${r.tenantLeaks}`);
  log(`app cpu avg ${r.application.cpuAvg} % peak ${r.application.cpuPeak} % mem ${r.application.rssPeakMB} MB | mongod cpu peak ${r.mongodb.cpuPeak} % mem ${r.mongodb.rssPeakMB} MB conns ${r.mongodb.connectionsPeak} | k6 cpu avg ${r.loadGenerator.cpuAvg} % mem ${r.loadGenerator.rssPeakMB} MB | host cpu ${r.host.systemCpuAvgDuringHold} %`);
  log(`event loop: worst 2-second p99 delay ${r.eventLoop.p99MaxMs} ms, worst single delay ${r.eventLoop.maxMs} ms, ${r.eventLoop.windowsWithP99Over100ms} of ${r.eventLoop.windows} windows with p99 over 100 ms`);
  log(`login p95/p99: ${r.perEndpoint.login ? `${Math.round(r.perEndpoint.login.p95)} / ${Math.round(r.perEndpoint.login.p99)} ms` : '-'}`);
  log(`verify ${r.verify ? 'PASS' : 'FAIL'}, isolation ${r.isolation ? 'PASS' : 'FAIL'}, recorded test-created records: ${r.createdRecords}`);
  log(`Results: ${path.join(OUT, 'result.json')}`);
}

main().catch((err) => { console.error(err); kill(); process.exit(1); });
