/* eslint-disable no-console */
// Live bus tracking, end to end: how accurate is the position people see, how fast does it arrive, are the stop times and parent
// messages right, and does everybody see ONLY their own bus, at the same time, across several schools and several buses each.
//
//   node loadtests/bus-check.js [--schools 3] [--buses 4] [--per-bus 6] [--fast]
//
// It starts the API as in production on a throwaway in-memory database, creates schools with buses and stops through the real API
// (as each school's office), and for every bus runs a simulated driver phone: a GPS reading every second with noise, sent in batches every
// 4 seconds, along a known path ("the truth"), with a lane offset, stops with waiting time, and faults (a network drop-out, GPS jumps, a
// patch of poor accuracy). Students and parents of each bus watch through the live stream. Everything they receive is compared with the truth.
// All schools use the SAME stop coordinates, the worst case for mixing buses up. Nothing external is contacted.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const SCHOOLS = Number(arg('schools', 3));
const BUSES = Number(arg('buses', 4));
const PER_BUS = Number(arg('per-bus', 6));      // students on each bus (each also has a parent account watching)
const PORT = Number(arg('port', 8112));
const INSTANCES = Number(arg('instances', 1));   // 2 = two API servers on the same database; the phones' batches alternate between them, like a load balancer
const RUN = `BUS-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`;
const OUT = path.join(__dirname, 'results', RUN);
const SEED = path.join(__dirname, 'data/bus-seed.json');
const BASE = process.env.BUSSIM_BASE || `http://127.0.0.1:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- geometry
const RAD = Math.PI / 180;
const dist = (aLat, aLng, bLat, bLng) => {
  const dLat = (bLat - aLat) * RAD; const dLng = (bLng - aLng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const move = (lat, lng, northM, eastM) => [lat + northM / 110540, lng + eastM / (111320 * Math.cos(lat * RAD))];
const BASE_LAT = 24.7914; const BASE_LNG = 85.0002; // the same start for every school and bus on purpose
// Legs (north, east in metres) of the six stops; each bus of a school uses a different turn order.
const LEGS = [[[520, 0], [0, 430], [460, 0], [0, 520], [380, 380]], [[0, 520], [450, 0], [0, 380], [520, 0], [-300, 380]],
  [[400, 300], [0, 450], [-350, 0], [0, 520], [480, 0]], [[0, 400], [520, 0], [0, 460], [-300, 0], [430, 380]]];
function stopsFor(busIndex) {
  const legs = LEGS[busIndex % LEGS.length];
  const pts = [[BASE_LAT, BASE_LNG]];
  for (const [n, e] of legs) { const [la, lo] = pts[pts.length - 1]; pts.push(move(la, lo, n, e)); }
  return pts;
}

// The truth: where the bus really is at every moment, with speed changes, waiting at stops, and a lane offset from the drawn line.
function makeTruth(stops, seed) {
  const rnd = (() => { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; })();
  const cum = [0]; for (let i = 1; i < stops.length; i += 1) cum.push(cum[i - 1] + dist(...stops[i - 1], ...stops[i]));
  const total = cum[cum.length - 1];
  const base = 26 + rnd() * 6; const ph = rnd() * 6.28; const ph2 = rnd() * 6.28;
  const samples = []; // [tRel, meters, speedMps]
  let t = 0; let m = 0; let dwellUntil = -1; const dwelled = new Set();
  while (m < total + 5 && t < 3000) {
    const next = cum.findIndex((c, i) => i > 0 && c - m > -1 && !dwelled.has(i));
    let v = (base / 3.6) * (1 + 0.25 * Math.sin((2 * Math.PI * t) / 90 + ph));
    if (t < dwellUntil) v = 0;
    else if (next > 0 && cum[next] - m < 12 && next < stops.length - 1) { dwelled.add(next); dwellUntil = t + 20; v = 0; }
    samples.push([t, m, v]); m = Math.min(total + 5, m + v * 0.1); t += 0.1;
  }
  const meters = (tRel) => { const i = Math.min(samples.length - 1, Math.max(0, Math.round(tRel * 10))); return samples[i]; };
  const pointAt = (mm) => {
    let i = 1; while (i < cum.length - 1 && cum[i] < mm) i += 1;
    const f = Math.min(1, Math.max(0, (mm - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
    return [stops[i - 1][0] + (stops[i][0] - stops[i - 1][0]) * f, stops[i - 1][1] + (stops[i][1] - stops[i - 1][1]) * f, i];
  };
  const at = (tRel) => {
    const [, mm, v] = meters(tRel);
    const [la, lo, i] = pointAt(Math.min(mm, total));
    // lane offset: up to ~7 m to the side of the drawn line, changing slowly
    const side = 7 * Math.sin((2 * Math.PI * tRel) / 70 + ph2);
    const dn = stops[i][0] - stops[i - 1][0]; const de = (stops[i][1] - stops[i - 1][1]) * Math.cos(la * RAD);
    const len = Math.hypot(dn, de) || 1;
    const [la2, lo2] = move(la, lo, (de / len) * side * 1, (-dn / len) * side * 1);
    return { lat: la2, lng: lo2, meters: mm, speed: v };
  };
  // first moments at which the bus is within 70 m before a stop, and 130 m past it (the server's "reached" and "departed")
  const reach = []; const depart = []; const arriveAt = [];
  for (let k = 0; k < stops.length; k += 1) {
    reach.push(samples.find((s) => s[1] >= cum[k] - 70)?.[0] ?? null);
    depart.push(samples.find((s) => s[1] >= cum[k] + 130)?.[0] ?? samples[samples.length - 1][0]);
    arriveAt.push(samples.find((s) => s[1] >= cum[k] - 5)?.[0] ?? null);
  }
  return { at, total, cum, reach, depart, arriveAt, duration: samples[samples.length - 1][0] };
}
const gauss = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

// ---------------------------------------------------------------- http
async function http(method, p, token, body, base = BASE) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, json };
}
const login = async (code, id, pw) => (await http('POST', '/users/login', null, { schoolCode: code, identifier: id, password: pw })).json.token;
const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const stat = (arr) => ({ n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95), p99: pct(arr, 0.99), max: arr.length ? Math.max(...arr) : null });

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  const uri = `${mongo.getUri()}busrun_loadtest`;
  const env = {
    ...process.env, MONGO_URI: uri, NODE_ENV: 'production', PORT: String(PORT), DISABLE_JOBS: 'true', LOADTEST_SEED_OK: 'yes', BCRYPT_ROUNDS: '10',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), CORS_ORIGINS: 'http://127.0.0.1:4173',
    PUBLIC_API_URL: `http://127.0.0.1:${PORT}`, EMAIL_PROVIDER: 'log', PHOTO_STORAGE: 'local', ROUTING_URL: 'off', RATE_LIMIT_STORE: 'mongo',
    GEMINI_API_KEY: '', AZURE_OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '',
  };
  const children = [];
  const stopAll = async () => { children.forEach((c) => { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } }); await mongo.stop().catch(() => {}); };
  process.on('SIGINT', async () => { await stopAll(); process.exit(130); });
  try {
    const log = (...a) => { const l = `${new Date().toISOString().slice(11, 19)}  ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'run.log'), `${l}\n`); };
    log(`Bus check ${RUN}: ${SCHOOLS} schools x ${BUSES} buses, ${PER_BUS} students (and as many parents) watching each bus. Production mode, throwaway database.`);
    const seeded = await new Promise((resolve) => children.push(spawn('node', [path.join(__dirname, 'seed.js'), '--schools', String(SCHOOLS), '--students', '100', '--out', SEED], { env, stdio: 'ignore' }).on('exit', resolve)));
    if (seeded !== 0) throw new Error('seeding failed');
    const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    const serverLog = fs.openSync(path.join(OUT, 'server.log'), 'a');
    const server = spawn('node', [path.join(__dirname, '../server.js')], { env, stdio: ['ignore', serverLog, serverLog] });
    children.push(server);
    for (let i = 0; i < 60; i += 1) { if ((await fetch(`${BASE}/health`).catch(() => null))?.ok) break; if (i === 59) throw new Error('server did not start'); await sleep(500); }
    const BASES = [BASE];
    for (let k = 1; k < INSTANCES; k += 1) {
      const extra = spawn('node', [path.join(__dirname, '../server.js')], { env: { ...env, PORT: String(PORT + k) }, stdio: ['ignore', serverLog, serverLog] }); children.push(extra);
      const b = `http://127.0.0.1:${PORT + k}/api`;
      for (let i = 0; i < 60; i += 1) { if ((await fetch(`${b}/health`).catch(() => null))?.ok) break; if (i === 59) throw new Error('second server did not start'); await sleep(500); }
      BASES.push(b);
    }
    if (INSTANCES > 1) log(`${INSTANCES} API servers on one database: drivers' batches alternate between them, watchers are spread over them.`);

    // ---- fleet, through the real API, as each school's office
    const fleet = []; // { school, bus index, id, number, token(driver), stops:[{id,lat,lng}], truth, students:[{...}], parents:[...] }
    for (const [si, school] of seed.schools.entries()) {
      const admin = await login(school.code, school.admin.identifier, seed.password);
      for (let b = 0; b < BUSES; b += 1) {
        const pts = stopsFor(b);
        const created = await http('POST', '/transport', admin, { busNumber: `${school.code}-B${b + 1}`, driverName: `Driver ${school.code}-${b + 1}`, driverPhone: '9000000000', routeName: `Route ${b + 1}`, capacity: 40,
          stops: pts.map((p, k) => ({ name: `Stop ${k + 1}`, latitude: p[0], longitude: p[1], order: k + 1 })) });
        if (created.status !== 201) throw new Error(`creating a bus failed: ${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
        const bus = created.json.data;
        const kids = school.students.slice(b * PER_BUS, (b + 1) * PER_BUS);
        const stopIds = {}; kids.forEach((s, j) => { stopIds[s.id] = bus.stops[1 + (j % (pts.length - 1))]._id; });
        const asg = await http('PUT', `/transport/${bus._id}/assign-students`, admin, { studentIds: kids.map((s) => s.id), stopIds });
        if (asg.status !== 200) throw new Error(`assigning students failed: ${asg.status} ${JSON.stringify(asg.json).slice(0, 120)}`);
        fleet.push({ school: school.code, si, b, id: bus._id, number: bus.busNumber, driverToken: bus.driverToken, stopIds, stops: bus.stops.map((s) => ({ id: s._id, lat: s.latitude, lng: s.longitude })), pts,
          truth: makeTruth(pts, 1000 + si * 37 + b * 7), kids, adminToken: admin });
      }
    }
    // an unassigned student per school (no bus), for the "sees nothing" check
    const idle = seed.schools.map((s) => ({ school: s.code, student: s.students[BUSES * PER_BUS + 1] }));
    log(`Created ${fleet.length} buses with ${fleet.length * PER_BUS} students each assigned to a stop; all schools use the same stop coordinates.`);

    // ---- watchers: students and parents of each bus open the live stream
    const watch = []; // { fleet, role, token, events:[{recv, ev}] }
    for (const f of fleet) {
      for (const kid of f.kids) {
        const stoken = await login(f.school, kid.admissionNo, seed.password);
        const ptoken = await login(f.school, kid.parentMobile, seed.password);
        for (const [role, token] of [['student', stoken], ['parent', ptoken]]) watch.push({ f, role, token, kid, events: [], status: null });
      }
    }
    log(`${watch.length} watchers signed in (students and parents). Opening live streams...`);
    const aborts = [];
    for (const [wi, w] of watch.entries()) {
      const ac = new AbortController(); aborts.push(ac); w.base = BASES[wi % BASES.length];
      (async () => {
        try {
          const res = await fetch(`${w.base}/transport/live/${w.f.id}/stream`, { headers: { Authorization: `Bearer ${w.token}` }, signal: ac.signal });
          w.status = res.status;
          if (res.status !== 200) return;
          const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { try { w.events.push({ recv: Date.now(), ev: JSON.parse(line) }); } catch (e) { /* partial */ } } }
          }
        } catch (e) { if (e.name !== 'AbortError') w.error = e.message; }
      })();
    }
    await sleep(1500);

    // ---- drivers: start trips, then one GPS reading a second, a batch every 4 seconds
    const T = {}; // per bus bookkeeping
    const driverDone = [];
    const reasons = {}; let sent = 0; let acceptedTotal = 0; let rejectedTotal = 0; const batchErrors = [];
    for (const f of fleet) {
      const st = { sendAt: new Map(), readings: [], t0: 0 };
      T[f.id] = st;
      const rnd = (() => { let s = 77 + f.si * 13 + f.b; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; })();
      driverDone.push((async () => {
        const started = await http('PATCH', `/transport/driver/${f.driverToken}/start-trip`, null, { direction: 'pickup' });
        if (started.status !== 200) throw new Error(`start-trip failed ${started.status}`);
        st.t0 = Date.now();
        const queue = []; let lastSend = 0;
        const dropFrom = 70; const dropTo = 100; // bus index 1: the phone loses the network for 30 s
        for (let sec = 0; ; sec += 1) {
          const tRel = sec; const tr = f.truth.at(tRel);
          const fault = (f.b % 4 === 3 && sec >= 100 && sec < 115) ? 'poor' : '';
          const acc = fault === 'poor' ? 60 + rnd() * 80 : 6 + rnd() * 8;
          const sig = acc / 2;
          let [lat, lng] = move(tr.lat, tr.lng, gauss(rnd) * sig, gauss(rnd) * sig);
          if (f.b % 4 === 2 && sec >= 50 && sec < 53) [lat, lng] = move(lat, lng, 500, 400); // a GPS jump of ~640 m, three readings
          const at = st.t0 + sec * 1000;
          queue.push({ lat, lng, accuracy: Math.round(acc), speed: tr.speed, at });
          st.readings.push({ at, tRel, lat, lng, acc, fault });
          const offline = f.b % 4 === 1 && sec >= dropFrom && sec < dropTo;
          if (!offline && sec - lastSend >= 4) {
            const batch = queue.splice(0, 60);
            batch.forEach((p) => st.sendAt.set(p.at, Date.now()));
            const r = await http('POST', `/transport/driver/${f.driverToken}/location`, null, { points: batch }, BASES[(st.batchNo = (st.batchNo || 0) + 1) % BASES.length]); sent += 1;
            if (r.status === 200) { acceptedTotal += r.json.data.accepted; rejectedTotal += r.json.data.rejected; for (const [k, v] of Object.entries(r.json.data.reasons || {})) reasons[k] = (reasons[k] || 0) + v; }
            else batchErrors.push(`${f.number}: ${r.status}`);
            lastSend = sec;
          }
          if (tRel > f.truth.duration + 8) break;
          await sleep(Math.max(0, st.t0 + (sec + 1) * 1000 - Date.now()));
        }
        // flush anything still queued, then the driver ends the trip
        if (queue.length) { const r = await http('POST', `/transport/driver/${f.driverToken}/location`, null, { points: queue.splice(0, 60) }); sent += 1; if (r.status !== 200) batchErrors.push(`${f.number}: ${r.status}`); }
        await sleep(1500);
        st.endedAt = Date.now();
        await http('PATCH', `/transport/driver/${f.driverToken}/end-trip`, null, {});
      })());
    }

    // ---- while the buses move: every watcher tries to see buses that are not theirs, and other things they must not be able to do
    const leaks = []; let attempts = 0; let rateLimited = 0;
    const expectNo = async (label, method, p, token, okStatuses = [401, 403, 404]) => { attempts += 1; const r = await http(method, p, token); if (r.status === 429) rateLimited += 1; else if (!okStatuses.includes(r.status)) leaks.push(`${label}: ${method} ${p} -> ${r.status}`); };
    await sleep(25000);
    for (const w of watch.filter((x, i) => i % 2 === 0 || true)) {
      const same = fleet.filter((f) => f.school === w.f.school && f.id !== w.f.id);
      const other = fleet.filter((f) => f.school !== w.f.school);
      if (same[0]) await expectNo(`${w.role} ${w.f.number} -> another bus of its school`, 'GET', `/transport/live/${same[0].id}`, w.token);
      if (other[0]) await expectNo(`${w.role} ${w.f.number} -> a bus of another school`, 'GET', `/transport/live/${other[(w.f.b) % other.length].id}`, w.token);
      if (same[0]) await expectNo(`${w.role} ${w.f.number} -> stream of another bus`, 'GET', `/transport/live/${same[0].id}/stream`, w.token);
      await expectNo(`${w.role} ${w.f.number} -> all buses (office view)`, 'GET', '/transport/live', w.token);
      await expectNo(`${w.role} ${w.f.number} -> bus list with driver codes`, 'GET', '/transport', w.token);
      await expectNo(`${w.role} ${w.f.number} -> bus history`, 'GET', `/transport/live/${w.f.id}/history`, w.token);
    }
    for (const f of fleet) {
      const foreign = fleet.filter((x) => x.school !== f.school)[0];
      await expectNo(`office of ${f.school} -> a bus of another school`, 'GET', `/transport/live/${foreign.id}`, f.adminToken);
      attempts += 1; const list = await http('GET', '/transport', f.adminToken); if (!(list.json.data || []).every((x) => String(x.school) === String(seed.schools.find((s) => s.code === f.school).id))) leaks.push(`office of ${f.school} got a bus list with another school's buses`);
    }
    for (const i of idle) {
      const tok = await login(i.school, i.student.admissionNo, seed.password);
      await expectNo(`student without a bus (${i.school}) -> my bus`, 'GET', '/transport/my-child-bus', tok);
      await expectNo(`student without a bus (${i.school}) -> some bus`, 'GET', `/transport/live/${fleet.find((f) => f.school === i.school).id}`, tok);
    }
    attempts += 1; const bad = await http('PATCH', '/transport/driver/not-a-real-code/start-trip', null, {}); if (bad.status !== 404) leaks.push(`wrong driver code -> ${bad.status}`);
    log(`${attempts} attempts to see or do what is not allowed were made while the buses were moving.`);

    await Promise.all(driverDone);
    await sleep(2500);
    aborts.forEach((a) => a.abort());

    // ---- compare everything people received with the truth
    const results = { run: RUN, config: { schools: SCHOOLS, busesPerSchool: BUSES, watchersPerBus: PER_BUS * 2 }, buses: [] };
    const allErr = []; const errByKind = { normal: [], afterDropout: [], afterJump: [], poorAccuracy: [] };
    const lat = []; const age = []; const etaErr = { le1: [], '1to3': [], '3to6': [], gt6: [] }; const stopDelay = []; const early = [];
    let missing = 0; let staleEnds = 0; let expectedTotal = 0; let wrongBusEvents = 0; let crossTrip = 0;
    for (const f of fleet) {
      const st = T[f.id]; const mine = watch.filter((w) => w.f.id === f.id);
      const ref = mine[0]; const posEv = (w) => w.events.filter((e) => e.ev.type === 'position');
      const refPos = posEv(ref);
      const tripIds = new Set(mine.flatMap((w) => w.events.map((e) => e.ev.tripId).filter(Boolean)));
      if (tripIds.size > 1) crossTrip += 1;
      for (const w of mine) for (const e of w.events) if (e.ev.busId && String(e.ev.busId) !== String(f.id)) wrongBusEvents += 1;
      const refAts = new Set(refPos.map((e) => e.ev.position.at));
      const refLast = refPos.length ? refPos[refPos.length - 1].ev.position.at : null;
      for (const w of mine) {
        const pw = posEv(w); const have = new Set(pw.map((e) => e.ev.position.at)); expectedTotal += refAts.size; for (const a of refAts) if (!have.has(a)) missing += 1;
        if (INSTANCES > 1 && refLast && (pw.length ? pw[pw.length - 1].ev.position.at : 0) < refLast - 6000) staleEnds += 1; // with several servers, a watcher may skip an update but must end on the same position
      }
      const errs = [];
      for (const e of refPos) {
        const p = e.ev.position; const rd = st.readings.find((r) => r.at === p.at); if (!rd) continue;
        const truth = f.truth.at(rd.tRel); const err = dist(p.lat, p.lng, truth.lat, truth.lng);
        errs.push(err); allErr.push(err);
        const kind = rd.fault === 'poor' ? 'poorAccuracy' : (f.b % 4 === 2 && rd.tRel >= 53 && rd.tRel < 70) ? 'afterJump' : (f.b % 4 === 1 && rd.tRel >= 100 && rd.tRel < 110) ? 'afterDropout' : 'normal';
        errByKind[kind].push(err);
        if (st.sendAt.has(p.at)) { lat.push(e.recv - st.sendAt.get(p.at)); age.push(e.recv - p.at); }
        // ETAs: predicted arrival time versus the real arrival time of each stop still ahead
        const tNow = rd.tRel; (e.ev.etas || []).forEach((m, k) => {
          if (m === null || m === undefined || k < e.ev.currentStopIndex) return;
          const real = f.truth.arriveAt[k]; if (real === null || real <= tNow) return;
          const predicted = tNow + m * 60; const error = predicted - real; const horizon = real - tNow;
          (horizon <= 60 ? etaErr.le1 : horizon <= 180 ? etaErr['1to3'] : horizon <= 360 ? etaErr['3to6'] : etaErr.gt6).push(error);
        });
      }
      // when the server moved on from a stop versus when the bus really left it
      let prev = 0; for (const e of refPos) { const ci = e.ev.currentStopIndex; if (ci > prev) { const rd = st.readings.find((r) => r.at === e.ev.position.at); for (let k = prev; k < ci; k += 1) if (rd && f.truth.depart[k] !== null) stopDelay.push(rd.tRel - f.truth.depart[k]); prev = ci; } }
      // the stop numbers the server ended on
      const lastEv = refPos[refPos.length - 1]; const finalStop = lastEv ? lastEv.ev.currentStopIndex : null;
      results.buses.push({ bus: f.number, events: refPos.length, errM: stat(errs), finalStopIndex: finalStop, signals: [...new Set(ref.events.map((e) => e.ev.signal).filter(Boolean))] });
    }
    // parent messages: the right parent, once, for their own child's stop only
    const noticeProblems = []; let noticeChecked = 0;
    for (const f of fleet) {
      const stopOrder = new Map(f.stops.map((s, i) => [String(s.id), i]));
      for (const kid of f.kids) {
        const ptoken = (watch.find((w) => w.f.id === f.id && w.kid === kid && w.role === 'parent')).token;
        const inbox = (await http('GET', '/notifications/my', ptoken)).json.data || [];
        const bus = inbox.filter((n) => n.type === 'Transport'); noticeChecked += 1;
        const arrived = bus.filter((n) => /is at the stop/.test(n.title)); const near = bus.filter((n) => /min away/.test(n.title)); const started = bus.filter((n) => /started|on its way|left/i.test(n.title + n.message));
        if (arrived.length !== 1) noticeProblems.push(`${f.number} parent of ${kid.admissionNo}: ${arrived.length} "at the stop" messages (expected 1)`);
        if (near.length > 1) noticeProblems.push(`${f.number} parent of ${kid.admissionNo}: ${near.length} "minutes away" messages (expected at most 1)`);
        if (bus.some((n) => !n.title.includes(f.number) && /^Bus /.test(n.title))) noticeProblems.push(`${f.number} parent of ${kid.admissionNo} got a message about another bus`);
        const stopName = `Stop ${stopOrder.get(String(f.stopIds[kid.id])) + 1}`;
        if (arrived[0] && !arrived[0].message.includes(stopName)) noticeProblems.push(`${f.number} parent of ${kid.admissionNo}: "at the stop" names the wrong stop (${arrived[0].message})`);
        void started;
      }
    }
    for (const i of idle) { // parents of students without a bus hear nothing from any bus
      const stu = i.student; const pt = await login(i.school, stu.parentMobile, seed.password);
      const inbox = (await http('GET', '/notifications/my', pt)).json.data || [];
      if (inbox.some((n) => n.type === 'Transport')) noticeProblems.push(`a parent whose child has no bus (${i.school}) got a bus message`);
    }

    const verdictRows = [];
    const check = (name, ok, detail) => verdictRows.push({ name, ok, detail });
    const e = stat(allErr);
    check('position error: p95 <= 15 m, p99 <= 30 m', e.p95 <= 15 && e.p99 <= 30, `p50 ${e.p50?.toFixed(1)} m, p95 ${e.p95?.toFixed(1)} m, p99 ${e.p99?.toFixed(1)} m, max ${e.max?.toFixed(1)} m (${e.n} positions)`);
    for (const [k, arr] of Object.entries(errByKind)) if (arr.length) { const s = stat(arr); check(`position error, ${k}: p95 <= 25 m`, s.p95 <= 25, `p50 ${s.p50.toFixed(1)}, p95 ${s.p95.toFixed(1)}, max ${s.max.toFixed(1)} m (n=${s.n})`); }
    const L = stat(lat); const A = stat(age);
    check('delivery: driver sends -> viewer has it, p95 <= 1,500 ms, p99 <= 3,000 ms', L.p95 <= 1500 && L.p99 <= 3000, `p50 ${L.p50} ms, p95 ${L.p95} ms, p99 ${L.p99} ms, max ${L.max} ms`);
    check('position age on screen (reading taken -> shown), p95 <= 6 s', A.p95 <= 6000, `p50 ${A.p50} ms, p95 ${A.p95} ms (includes the 4 s batching on the phone)`);
    check(INSTANCES > 1 ? 'every watcher received (nearly) every position update and ended within one update of the last position (with several servers an update may be skipped when two arrive within a second)' : 'every watcher of a bus received every position update', INSTANCES > 1 ? missing <= expectedTotal * 0.05 && staleEnds === 0 : missing === 0, `${missing} missing of ${expectedTotal}, ${staleEnds} watchers ended on a different position`);
    check('no watcher received an event of another bus; one trip id per bus', wrongBusEvents === 0 && crossTrip === 0, `${wrongBusEvents} foreign events, ${crossTrip} buses with mixed trip ids`);
    check('nobody could see or do what they must not (cross-bus, cross-school, role)', leaks.length === 0, `${attempts} attempts, ${leaks.length} got through${leaks.length ? `: ${leaks.slice(0, 3).join(' | ')}` : ''}`);
    check('no sign-in, stream or check was turned away by a rate limit (all users share one address, like a school wifi)', rateLimited === 0 && watch.every((w) => w.token), `${rateLimited} rate-limited, ${watch.filter((w) => !w.token).length} sign-ins failed`);
    check('every live-stream watcher was accepted (200) for its own bus', watch.every((w) => w.status === 200), `${watch.filter((w) => w.status !== 200).length} refused`);
    const sd = stat(stopDelay); check('stop tracking: the server moves on within 8 s of the bus really leaving a stop', sd.n > 0 && Math.abs(sd.p95) <= 8, `delay p50 ${sd.p50?.toFixed(1)} s, p95 ${sd.p95?.toFixed(1)} s (n=${sd.n})`);
    const finals = results.buses.map((b) => b.finalStopIndex); check('every bus finished at the last stop', finals.every((x) => x >= fleet[0].stops.length - 2), `final stop indexes: ${finals.join(',')}`);
    for (const [k, arr] of Object.entries(etaErr)) if (arr.length) { const abs = arr.map(Math.abs); const s = stat(abs); const bias = arr.reduce((a, b) => a + b, 0) / arr.length; const lim = { le1: 45, '1to3': 75, '3to6': 120, gt6: 180 }[k]; check(`ETA error for stops ${({ le1: 'within 1 min', '1to3': '1-3 min', '3to6': '3-6 min', gt6: 'over 6 min' })[k]} away: median <= ${lim} s`, s.p50 <= lim, `median ${s.p50.toFixed(0)} s, p95 ${s.p95.toFixed(0)} s, bias ${bias.toFixed(0)} s (predicted minus real; positive = late) (n=${s.n})`); }
    check(`parent messages: ${noticeChecked} parents got exactly one "at the stop", at most one "minutes away", only about their own bus and stop; parents of children without a bus got none`, noticeProblems.length === 0, noticeProblems.length ? noticeProblems.slice(0, 3).join(' | ') : 'all correct');
    check('no batch of readings was refused with an error', batchErrors.length === 0, `${sent} batches sent, ${batchErrors.length} errors${batchErrors.length ? `: ${batchErrors.slice(0, 3).join(' ')}` : ''}`);
    results.checks = verdictRows; results.readings = { batches: sent, accepted: acceptedTotal, rejected: rejectedTotal, rejectedReasons: reasons };
    results.verdict = verdictRows.every((r) => r.ok) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
    log('');
    for (const r of verdictRows) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
    log(`\nReadings: ${sent} batches, ${acceptedTotal} accepted, ${rejectedTotal} rejected (${JSON.stringify(reasons)}).`);
    log(`=== Bus check: ${results.verdict}. Results: ${path.join(OUT, 'result.json')}`);
  } finally {
    await stopAll();
  }
}
module.exports = { dist, move, makeTruth, stopsFor, gauss, http, login, pct, stat, BASE_LAT, BASE_LNG };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
