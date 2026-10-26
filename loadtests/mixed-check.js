/* eslint-disable no-console */
// Thousands of people active at the same time, doing different things in many schools: watching their bus live (with drivers' phones
// sending GPS), chatting, asking the Learning AI tutor, and using the ordinary screens (dashboards, fees, homework, attendance).
//
//   node loadtests/mixed-check.js [--users 3000] [--schools 30] [--ramp 2m] [--hold 8m]
//
// One command: throwaway in-memory database, the API as in production (production rate limits, error masking, strict CORS), a stand-in
// for the AI provider (loadtests/fake-ai.js, so nothing real is called or paid for), k6 for the requests (loadtests/k6/mixed.js), and this
// process for the drivers and the people holding a live bus map open. It measures speed and errors, the CPU and memory of the
// application and database, the event loop, the accuracy and delivery of the bus positions, the AI answers, and checks the data and the
// separation of schools afterwards. Everyone connects from one address, like a very large school wifi.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
process.env.BUSSIM_BASE = `http://127.0.0.1:${Number(arg('port', 8113))}/api`; // read by bus-check.js when it is loaded
const bus = require('./bus-check');
const fakeAi = require('./fake-ai');
const USERS = Number(arg('users', 3000));
const F = USERS / 3000;
const SCHOOLS = Number(arg('schools', Math.max(3, Math.round(30 * F))));
const RAMP = String(arg('ramp', '2m')); const HOLD = String(arg('hold', '8m'));
const PORT = Number(arg('port', 8113)); const AI_PORT = Number(arg('ai-port', 8121));
const RUN = `MIX-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
const OUT = path.join(__dirname, 'results', RUN);
const SEED = path.join(__dirname, 'data/mixed-seed.json');
const BASE = `http://127.0.0.1:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toSec = (d) => { const m = /^(\d+)(s|m|h)$/.exec(d); return m ? Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]] : 0; };
const GB = 1024 ** 3;
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch (e) { return ''; } };
const availableGB = () => { const vm = sh('vm_stat', []); if (!vm) return os.freemem() / GB; const page = Number((/page size of (\d+) bytes/.exec(vm) || [])[1] || 16384); const n = (l) => Number((new RegExp(`${l}:\\s+(\\d+)`).exec(vm) || [])[1] || 0); return ((n('Pages free') + n('Pages inactive') + n('Pages speculative')) * page) / GB; };
const procStats = (pids) => (pids.length ? sh('ps', ['-o', 'pid=,%cpu=,rss=', '-p', pids.join(',')]).trim().split('\n').filter(Boolean).map((l) => { const [pid, cpu, rss] = l.trim().split(/\s+/); return { pid: Number(pid), cpu: Number(cpu), rssMB: Math.round(Number(rss) / 1024) }; }) : []);
const sysCpu = () => Math.min(100, sh('ps', ['-A', '-o', '%cpu=']).split('\n').reduce((t, v) => t + (Number(v) || 0), 0) / os.cpus().length);

async function api(method, p, token, body) { return bus.http(method, p, token, body); }
async function signIn(code, id, pw) {
  const res = await fetch(`${BASE}/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schoolCode: code, identifier: id, password: pw }) });
  if (res.status === 429) { await sleep(2000); return signIn(code, id, pw); } // a rate limit: wait and try again
  const j = await res.json().catch(() => ({})); return { token: j.token, userId: j.user && j.user._id };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const log = (...a) => { const l = `${new Date().toISOString().slice(11, 19)}  ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'run.log'), `${l}\n`); };
  if (availableGB() < 3.5) { console.error(`REFUSED: only ${availableGB().toFixed(1)} GB of memory is free; close apps first (need 3.5 GB)`); process.exit(2); }
  log(`Mixed activity ${RUN}: about ${USERS} people in ${SCHOOLS} schools, ramp ${RAMP}, hold ${HOLD}. ${os.cpus().length} CPUs, ${(os.totalmem() / GB).toFixed(0)} GB, ${availableGB().toFixed(1)} GB free now.`);
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  const uri = `${mongo.getUri()}mixed_loadtest`;
  const ai = await fakeAi.start({ port: AI_PORT, firstTokenMs: 800, tokensPerSec: 45 });
  const env = {
    ...process.env, MONGO_URI: uri, NODE_ENV: 'production', PORT: String(PORT), DISABLE_JOBS: 'true', LOADTEST_SEED_OK: 'yes', BCRYPT_ROUNDS: '10',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), CORS_ORIGINS: 'http://127.0.0.1:4173',
    PUBLIC_API_URL: `http://127.0.0.1:${PORT}`, EMAIL_PROVIDER: 'log', PHOTO_STORAGE: 'local', ROUTING_URL: 'off', RATE_LIMIT_STORE: 'mongo',
    GEMINI_API_KEY: '', CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '',
    AZURE_OPENAI_ENDPOINT: `http://127.0.0.1:${AI_PORT}`, AZURE_OPENAI_API_KEY: 'fake', AZURE_OPENAI_DEPLOYMENT: 'fake', ASSISTANT_PROVIDERS: 'azure', LEARNING_VECTOR_SEARCH: 'off',
  };
  const children = [];
  const stopAll = async () => { children.forEach((c) => { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } }); await ai.close().catch(() => {}); await mongo.stop().catch(() => {}); };
  process.on('SIGINT', async () => { await stopAll(); process.exit(130); });
  try {
    const seeded = await new Promise((resolve) => children.push(spawn('node', [path.join(__dirname, 'seed.js'), '--schools', String(SCHOOLS), '--students', '100', '--out', SEED], { env, stdio: 'ignore' }).on('exit', resolve)));
    if (seeded !== 0) throw new Error('seeding failed');
    const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    const lagFile = path.join(OUT, 'eventloop.json');
    const serverLog = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn('node', [path.join(__dirname, '../server.js')], { env: { ...env, LAG_FILE: lagFile, NODE_OPTIONS: `--require ${path.join(__dirname, 'lagprobe.js')}` }, stdio: ['ignore', serverLog, serverLog] });
    children.push(server);
    for (let i = 0; i < 90; i += 1) { if ((await fetch(`${BASE}/health`).catch(() => null))?.ok) break; if (i === 89) throw new Error('server did not start'); await sleep(500); }
    const mongodPid = mongo.instanceInfo && mongo.instanceInfo.instance && mongo.instanceInfo.instance.mongodProcess ? mongo.instanceInfo.instance.mongodProcess.pid : undefined;
    log(`Seeded ${SCHOOLS} schools, server up.`);

    // ---- buses (2 per school, 5 students on each), through the real API
    const fleet = [];
    for (const [si, school] of seed.schools.entries()) {
      const admin = (await signIn(school.code, school.admin.identifier, seed.password)).token;
      for (let b = 0; b < 2; b += 1) {
        const pts = bus.stopsFor(b);
        const created = await api('POST', '/transport', admin, { busNumber: `${school.code}-B${b + 1}`, driverName: 'Driver', driverPhone: '9000000000', routeName: `Route ${b + 1}`, capacity: 40, stops: pts.map((p, k) => ({ name: `Stop ${k + 1}`, latitude: p[0], longitude: p[1], order: k + 1 })) });
        if (created.status !== 201) throw new Error(`creating a bus failed ${created.status}`);
        const kids = school.students.slice(b * 5, b * 5 + 5);
        const stopIds = {}; kids.forEach((s, j) => { stopIds[s.id] = created.json.data.stops[1 + (j % (pts.length - 1))]._id; });
        const asg = await api('PUT', `/transport/${created.json.data._id}/assign-students`, admin, { studentIds: kids.map((s) => s.id), stopIds });
        if (asg.status !== 200) throw new Error(`assigning students failed ${asg.status}`);
        fleet.push({ school: school.code, si, b, id: created.json.data._id, number: created.json.data.busNumber, driverToken: created.json.data.driverToken, kids, truth: bus.makeTruth(pts, 500 + si * 31 + b * 11) });
      }
    }
    log(`${fleet.length} buses created, each with 5 students (and their parents) assigned.`);

    // ---- sign everybody in beforehand (about 15 a second, below the production limit for one address), build the token pools
    const t0 = Date.now(); let signed = 0;
    const queue = []; const want = (code, id, tag) => queue.push({ code, id, tag });
    const watch = []; const pool = { browse: { student: [], parent: [], teacher: [], admin: [] }, chat: { parents: [] }, ai: [] };
    const jobs = [];
    for (const [si, school] of seed.schools.entries()) {
      const st = school.students;
      for (const f of fleet.filter((x) => x.si === si)) for (const kid of f.kids) { jobs.push(['watch-s', school, f, kid]); jobs.push(['watch-p', school, f, kid]); }
      for (const kid of st.slice(10, 25)) jobs.push(['ai', school, kid]);
      for (const kid of st.slice(25, 50)) jobs.push(['chat', school, kid]);
      for (const kid of st.slice(50, 70)) jobs.push(['browse-s', school, kid]);
      for (const kid of st.slice(70, 80)) jobs.push(['browse-p', school, kid]);
      for (const t of school.teachers) jobs.push(['teacher', school, t]);
      jobs.push(['admin', school]);
    }
    void queue; void want;
    const teacherByUser = new Map(); const tokenOf = new Map();
    let ji = 0; const lanes = 6;
    await Promise.all(Array.from({ length: lanes }, async () => {
      for (;;) {
        const j = jobs[ji]; ji += 1; if (!j) return;
        const [kind, school, a, b2] = j;
        const started = Date.now();
        if (kind === 'watch-s') { const r = await signIn(school.code, b2.admissionNo, seed.password); watch.push({ f: a, role: 'student', token: r.token, kid: b2, events: [] }); }
        else if (kind === 'watch-p') { const r = await signIn(school.code, b2.parentMobile, seed.password); watch.push({ f: a, role: 'parent', token: r.token, kid: b2, events: [] }); }
        else if (kind === 'ai') { const r = await signIn(school.code, a.admissionNo, seed.password); pool.ai.push({ token: r.token }); }
        else if (kind === 'chat') { const r = await signIn(school.code, a.parentMobile, seed.password); tokenOf.set(a.id, { token: r.token, userId: r.userId, school }); }
        else if (kind === 'browse-s') { const r = await signIn(school.code, a.admissionNo, seed.password); pool.browse.student.push({ token: r.token }); }
        else if (kind === 'browse-p') { const r = await signIn(school.code, a.parentMobile, seed.password); pool.browse.parent.push({ token: r.token }); }
        else if (kind === 'teacher') { const r = await signIn(school.code, a.identifier, seed.password); const sections = school.sectionStudents.filter((s) => a.sections.some((x) => x.class === s.class && x.section === s.section)); pool.browse.teacher.push({ token: r.token, sections }); teacherByUser.set(r.userId, r.token); }
        else if (kind === 'admin') { const r = await signIn(school.code, school.admin.identifier, seed.password); pool.browse.admin.push({ token: r.token, feeIds: school.feeIds.slice(0, 3) }); }
        signed += 1;
        const gap = 1000 / 15 * lanes - (Date.now() - started); if (gap > 0) await sleep(gap); // about 15 sign-ins a second in all
      }
    }));
    // chat pairs: each chatting parent with the class teacher the app gives them
    for (const [, v] of tokenOf) {
      const r = await api('GET', '/chat/parent-teachers', v.token);
      const teacher = ((r.json.data || {}).teachers || [])[0]; if (!teacher) continue;
      pool.chat.parents.push({ token: v.token, parentUserId: v.userId, teacherUserId: teacher.userId, roomId: teacher.roomId, teacherToken: teacherByUser.get(teacher.userId) || v.token });
    }
    fs.writeFileSync(path.join(OUT, 'tokens.json'), JSON.stringify(pool));
    log(`${signed} people signed in in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${watch.length} bus watchers, ${pool.ai.length} learners, ${pool.chat.parents.length} chatters, ${pool.browse.student.length + pool.browse.parent.length + pool.browse.teacher.length + pool.browse.admin.length} on ordinary screens.`);
    if (pool.chat.parents.some((p) => !p.teacherToken)) log('note: some chat pairs have no teacher token');

    // ---- live bus maps held open
    const aborts = [];
    for (const w of watch) {
      const ac = new AbortController(); aborts.push(ac);
      (async () => {
        try {
          const res = await fetch(`${BASE}/transport/live/${w.f.id}/stream`, { headers: { Authorization: `Bearer ${w.token}` }, signal: ac.signal }); w.status = res.status; if (res.status !== 200) return;
          const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
          for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { w.events.push({ recv: Date.now(), ev: JSON.parse(line) }); } catch (e) { /* partial */ } } } }
        } catch (e) { if (e.name !== 'AbortError') w.error = e.message; }
      })();
    }
    await sleep(2000);
    log(`${watch.filter((w) => w.status === 200).length} of ${watch.length} live bus maps are open.`);

    // ---- k6 starts the request streams; the drivers start 30 s later, so every trip runs inside the hold
    const summaryFile = path.join(OUT, 'k6-summary.json');
    const k6out = fs.openSync(path.join(OUT, 'k6.log'), 'a');
    const k6 = spawn('k6', ['run', '--quiet', path.join(__dirname, 'k6/mixed.js')], { env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}`, TOKENS_FILE: path.join(OUT, 'tokens.json'), RATE_SCALE: String(F), RAMP, HOLD, SUMMARY_FILE: summaryFile }, stdio: ['ignore', k6out, k6out] });
    children.push(k6);
    const k6Exit = new Promise((r) => k6.on('exit', r)); let k6Done = false; k6Exit.then(() => { k6Done = true; });
    const startedAt = Date.now();
    const samples = []; let stopReason = ''; let lowMem = 0;
    const sampler = (async () => {
      while (!k6Done) {
        await sleep(2000);
        const avail = availableGB(); const [s] = procStats([server.pid]); const [g] = procStats([k6.pid]); const [m] = procStats(mongodPid ? [mongodPid] : []); const [me] = procStats([process.pid]);
        samples.push({ t: Math.round((Date.now() - startedAt) / 1000), availGB: Number(avail.toFixed(2)), sysCpu: Math.round(sysCpu()), app: s, k6: g, mongod: m, gen: me });
        lowMem = avail < 1.5 ? lowMem + 1 : 0;
        if (lowMem >= 2) stopReason = `host memory low (${avail.toFixed(1)} GB)`;
        if (!s) stopReason = stopReason || 'the application process stopped';
        if (stopReason) { log(`STOPPING: ${stopReason}`); k6.kill('SIGTERM'); break; }
      }
    })();

    await sleep(30000);
    const T = {}; const driverRuns = []; const reasons = {}; let batches = 0; let batchErrors = 0; let accepted = 0; let rejected = 0;
    for (const f of fleet) {
      const st = { sendAt: new Map(), readings: [], t0: 0 }; T[f.id] = st;
      const rnd = (() => { let s = 99 + f.si * 17 + f.b; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; })();
      driverRuns.push((async () => {
        const started = await api('PATCH', `/transport/driver/${f.driverToken}/start-trip`, null, { direction: 'pickup' }); if (started.status !== 200) { batchErrors += 1; return; }
        st.t0 = Date.now(); const queue2 = []; let lastSend = 0;
        for (let sec = 0; ; sec += 1) {
          const tr = f.truth.at(sec); const fault = (f.b === 1 && f.si % 5 === 3 && sec >= 100 && sec < 115);
          const acc = fault ? 60 + rnd() * 80 : 6 + rnd() * 8; const sig = acc / 2;
          const [lat, lng] = bus.move(tr.lat, tr.lng, bus.gauss(rnd) * sig, bus.gauss(rnd) * sig);
          const at = st.t0 + sec * 1000; queue2.push({ lat, lng, accuracy: Math.round(acc), speed: tr.speed, at }); st.readings.push({ at, tRel: sec });
          const offline = f.b === 0 && f.si % 7 === 1 && sec >= 70 && sec < 100;
          if (!offline && sec - lastSend >= 4) {
            const batch = queue2.splice(0, 60); batch.forEach((p) => st.sendAt.set(p.at, Date.now()));
            const r = await api('POST', `/transport/driver/${f.driverToken}/location`, null, { points: batch }); batches += 1;
            if (r.status === 200) { accepted += r.json.data.accepted; rejected += r.json.data.rejected; for (const [k, v] of Object.entries(r.json.data.reasons || {})) reasons[k] = (reasons[k] || 0) + v; } else batchErrors += 1;
            lastSend = sec;
          }
          if (sec > f.truth.duration + 8) break;
          await sleep(Math.max(0, st.t0 + (sec + 1) * 1000 - Date.now()));
        }
        if (queue2.length) await api('POST', `/transport/driver/${f.driverToken}/location`, null, { points: queue2.splice(0, 60) });
        await sleep(1500); await api('PATCH', `/transport/driver/${f.driverToken}/end-trip`, null, {});
      })());
    }
    // while all this runs: some bus watchers try to see buses that are not theirs
    let attempts = 0; const leaks = []; let limited = 0;
    await sleep(60000);
    const sample = watch.filter((_, i) => i % 6 === 0);
    for (const w of sample) {
      const other = fleet.filter((f) => f.id !== w.f.id); const foreign = other[(Math.abs(w.f.si * 3 + w.f.b)) % other.length];
      for (const p of [`/transport/live/${foreign.id}`, '/transport/live', '/transport']) { attempts += 1; const r = await api('GET', p, w.token); if (r.status === 429) limited += 1; else if (![401, 403, 404].includes(r.status)) leaks.push(`${w.role} ${w.f.number}: ${p} -> ${r.status}`); }
    }
    log(`${attempts} attempts to see other buses or office views while everything was running.`);
    await Promise.all(driverRuns);
    await Promise.race([k6Exit, sleep(toSec(HOLD) * 1000 + 120000)]);
    await sampler;
    aborts.forEach((a) => a.abort());
    log('Everything has finished; collecting results.');
    await sleep(2500);

    // ---- results
    const sum = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : null;
    const M = (n) => (sum && sum.metrics[n] && sum.metrics[n].values) || {};
    const lag = (() => { try { return JSON.parse(fs.readFileSync(lagFile, 'utf8')); } catch (e) { return []; } })();
    const dur = M('http_req_duration'); const reads = M('http_req_duration{kind:read}'); const writesM = M('http_req_duration{kind:write}'); const aiM = M('http_req_duration{kind:ai}');
    const perEndpoint = {};
    if (sum) for (const k of Object.keys(sum.metrics)) { const m = /^http_req_duration\{name:(.+)\}$/.exec(k); if (m) { const v = sum.metrics[k].values; perEndpoint[m[1]] = { n: v.count, p50: v.med, p95: v['p(95)'], p99: v['p(99)'], max: v.max }; } }
    // bus accuracy and delivery
    const errs = []; const lat = []; let missing = 0; let expected = 0; let foreign = 0;
    for (const f of fleet) {
      const mine = watch.filter((w) => w.f.id === f.id); const st = T[f.id]; const ref = mine[0]; if (!ref) continue;
      const pos = (w) => w.events.filter((e) => e.ev.type === 'position'); const refPos = pos(ref); const refAts = new Set(refPos.map((e) => e.ev.position.at));
      for (const w of mine) { const have = new Set(pos(w).map((e) => e.ev.position.at)); expected += refAts.size; for (const a of refAts) if (!have.has(a)) missing += 1; for (const e of w.events) if (e.ev.busId && String(e.ev.busId) !== String(f.id)) foreign += 1; }
      for (const e of refPos) { const rd = st.readings.find((r) => r.at === e.ev.position.at); if (!rd) continue; const tr = f.truth.at(rd.tRel); errs.push(bus.dist(e.ev.position.lat, e.ev.position.lng, tr.lat, tr.lng)); if (st.sendAt.has(e.ev.position.at)) lat.push(e.recv - st.sendAt.get(e.ev.position.at)); }
    }
    const be = bus.stat(errs); const bl = bus.stat(lat);
    const hold = samples.filter((x) => x.t >= toSec(RAMP) && x.t <= toSec(RAMP) + toSec(HOLD));
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0); const peak = (arr) => Math.max(0, ...arr);
    const mongoose = require('mongoose'); await mongoose.connect(uri); const conn = mongoose.connection;
    let connsPeak = 0; try { const ss = await conn.db.admin().command({ serverStatus: 1 }); connsPeak = ss.connections.current; } catch (e) { /* none */ }
    await mongoose.disconnect();
    const runChild = (file, extra = {}) => new Promise((resolve) => spawn('node', [path.join(__dirname, file)], { env: { ...env, ...extra }, stdio: ['ignore', fs.openSync(path.join(OUT, `${file}.log`), 'a'), fs.openSync(path.join(OUT, `${file}.log`), 'a')] }).on('exit', resolve));
    const verifyCode = await runChild('verify.js'); const isoCode = await runChild('isolation-check.js', { BASE_URL: `http://127.0.0.1:${PORT}`, SEED_FILE: SEED });
    const healthy = !!(await fetch(`${BASE}/health`).catch(() => null))?.ok;

    const peopleHeld = watch.filter((w) => w.status === 200).length;
    const result = {
      run: RUN, config: { users: USERS, schools: SCHOOLS, ramp: RAMP, hold: HOLD }, people: { busWatchers: watch.length, learners: pool.ai.length, chatters: pool.chat.parents.length, ordinary: pool.browse.student.length + pool.browse.parent.length + pool.browse.teacher.length + pool.browse.admin.length, busMapsOpen: peopleHeld, buses: fleet.length },
      requests: { total: M('http_reqs').count, perSecond: M('http_reqs').rate }, latencyMs: { all: { p50: dur.med, p95: dur['p(95)'], p99: dur['p(99)'], max: dur.max }, reads: { p95: reads['p(95)'], p99: reads['p(99)'] }, writes: { p95: writesM['p(95)'], p99: writesM['p(99)'] }, ai: { p50: aiM.med, p95: aiM['p(95)'], max: aiM.max } },
      errors: { http: M('http_req_failed').rate, serverErrors: M('server_error').rate, checks: M('checks').rate },
      ai: { answeredOk: M('ai_answer_ok').rate, refused: M('ai_refused').count, answerMs: { p50: M('ai_answer_ms').med, p95: M('ai_answer_ms')['p(95)'] }, provider: ai.stats },
      bus: { positions: be.n, errM: be, deliveryMs: bl, missingUpdates: missing, expectedUpdates: expected, foreignEvents: foreign, accessAttempts: attempts, accessLeaks: leaks, rateLimited: limited, batches, batchErrors, accepted, rejected, rejectedReasons: reasons },
      host: { cpus: os.cpus().length, totalGB: Math.round(os.totalmem() / GB), minAvailableGB: Math.min(...samples.map((x) => x.availGB), 99), systemCpuAvgDuringHold: Math.round(avg(hold.map((x) => x.sysCpu))) },
      application: { cpuAvg: Math.round(avg(hold.map((x) => (x.app ? x.app.cpu : 0)))), cpuPeak: Math.round(peak(samples.map((x) => (x.app ? x.app.cpu : 0)))), rssPeakMB: peak(samples.map((x) => (x.app ? x.app.rssMB : 0))) },
      mongodb: { cpuPeak: Math.round(peak(samples.map((x) => (x.mongod ? x.mongod.cpu : 0)))), rssPeakMB: peak(samples.map((x) => (x.mongod ? x.mongod.rssMB : 0))), connectionsAtEnd: connsPeak },
      loadGenerators: { k6CpuPeak: Math.round(peak(samples.map((x) => (x.k6 ? x.k6.cpu : 0)))), k6RssPeakMB: peak(samples.map((x) => (x.k6 ? x.k6.rssMB : 0))), driversAndMapsRssPeakMB: peak(samples.map((x) => (x.gen ? x.gen.rssMB : 0))) },
      eventLoop: { p99MaxMs: Math.max(0, ...lag.map((x) => x.p99)), maxMs: Math.max(0, ...lag.map((x) => x.max)), windowsOver100ms: lag.filter((x) => x.p99 > 100).length, windows: lag.length },
      verify: verifyCode === 0, isolation: isoCode === 0, healthyAfter: healthy, perEndpoint,
    };
    const reasons2 = [];
    if (stopReason) reasons2.push(`stopped early: ${stopReason}`);
    if (!sum) reasons2.push('k6 produced no summary');
    if (result.latencyMs.reads.p95 > 500) reasons2.push(`read p95 ${Math.round(result.latencyMs.reads.p95)} ms is above 500`);
    if (result.latencyMs.reads.p99 > 1000) reasons2.push(`read p99 ${Math.round(result.latencyMs.reads.p99)} ms is above 1000`);
    if (result.latencyMs.writes.p95 > 800) reasons2.push(`write p95 ${Math.round(result.latencyMs.writes.p95)} ms is above 800`);
    if (result.errors.http >= 0.01) reasons2.push(`HTTP error rate ${(result.errors.http * 100).toFixed(2)} %`);
    if (result.errors.serverErrors >= 0.05) reasons2.push('5xx rate 5 % or more');
    if (result.ai.answeredOk < 0.98) reasons2.push(`only ${(result.ai.answeredOk * 100).toFixed(1)} % of AI answers completed`);
    if (be.p95 > 15) reasons2.push(`bus position error p95 ${be.p95.toFixed(1)} m`);
    if (missing > 0) reasons2.push(`${missing} bus updates did not reach every watcher`);
    if (foreign > 0 || leaks.length) reasons2.push('a bus was seen by someone it does not belong to');
    if (peopleHeld < watch.length) reasons2.push(`${watch.length - peopleHeld} live bus maps could not be opened`);
    if (!result.verify) reasons2.push('verify.js found inconsistent data'); if (!result.isolation) reasons2.push('isolation-check.js found cross-school data'); if (!healthy) reasons2.push('the application did not answer after the run');
    const generatorOk = result.host.systemCpuAvgDuringHold < 85 && result.host.minAvailableGB >= 1.5;
    result.reasons = reasons2; result.verdict = reasons2.length ? (generatorOk ? 'FAIL' : 'INCONCLUSIVE') : 'PASS'; result.generatorHealthy = generatorOk;
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(OUT, 'samples.json'), JSON.stringify(samples));
    const ms = (v) => (v === undefined || v === null ? '-' : `${Math.round(v)} ms`);
    log('');
    log(`=== Mixed activity: ${result.verdict}${reasons2.length ? ` (${reasons2.join('; ')})` : ''}`);
    log(`people: ${result.people.busWatchers} bus watchers on ${result.people.buses} buses, ${result.people.learners} learners, ${result.people.chatters} chatters, ${result.people.ordinary} on ordinary screens = ${result.people.busWatchers + result.people.learners + result.people.chatters + result.people.ordinary}`);
    log(`requests ${result.requests.total} (${Math.round(result.requests.perSecond)}/s); reads p95 ${ms(result.latencyMs.reads.p95)} p99 ${ms(result.latencyMs.reads.p99)}; writes p95 ${ms(result.latencyMs.writes.p95)} p99 ${ms(result.latencyMs.writes.p99)}; all max ${ms(result.latencyMs.all.max)}`);
    log(`errors: http ${(result.errors.http * 100).toFixed(2)} %, 5xx ${(result.errors.serverErrors * 100).toFixed(2)} %, checks ${(result.errors.checks * 100).toFixed(1)} %`);
    log(`AI: ${(result.ai.answeredOk * 100).toFixed(1)} % answered, refused ${result.ai.refused}, answer time p50 ${ms(result.ai.answerMs.p50)} p95 ${ms(result.ai.answerMs.p95)}, provider saw ${ai.stats.requests} calls, at most ${ai.stats.maxActive} at once`);
    log(`bus: ${be.n} positions, error p50 ${be.p50?.toFixed(1)} m p95 ${be.p95?.toFixed(1)} m max ${be.max?.toFixed(1)} m; delivery p95 ${bl.p95} ms; missing ${missing}/${expected}; ${attempts} access attempts, ${leaks.length} got through; batches ${batches}, errors ${batchErrors}`);
    log(`application cpu avg ${result.application.cpuAvg} % peak ${result.application.cpuPeak} % mem ${result.application.rssPeakMB} MB | mongod cpu peak ${result.mongodb.cpuPeak} % | k6 mem ${result.loadGenerators.k6RssPeakMB} MB | host cpu ${result.host.systemCpuAvgDuringHold} %, lowest free memory ${result.host.minAvailableGB} GB`);
    log(`event loop: worst 2 s p99 ${result.eventLoop.p99MaxMs} ms, worst single ${result.eventLoop.maxMs} ms, ${result.eventLoop.windowsOver100ms} of ${result.eventLoop.windows} windows over 100 ms; verify ${result.verify ? 'PASS' : 'FAIL'}, isolation ${result.isolation ? 'PASS' : 'FAIL'}`);
    log(`Results: ${path.join(OUT, 'result.json')}`);
  } finally { await stopAll(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
