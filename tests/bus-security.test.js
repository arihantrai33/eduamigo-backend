// Who may see a bus, enforced on the server, for every way in (snapshot, live stream, lists, assignments) and while a stream is open.
// Plus the driver side: one running trip per bus, one phone per trip. No browser, no GPS: readings and assignment changes are controlled.
process.env.BUS_STREAM_RECHECK_MS = '150';

const http = require('http');
const { api, app, connect, disconnect, clear, auth, makeUser, seedSchool } = require('./helpers');
const Transport = require('../src/models/Transport');
const Student = require('../src/models/Student');
const Parent = require('../src/models/Parent');
const School = require('../src/models/School');
const User = require('../src/models/User');
const Notification = require('../src/models/Notification');
const tracking = require('../src/services/busTracking');

const LAT = 24.75;
const LNGS = [84.990, 84.996, 85.002, 85.008];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let A; let B; let bus; let bus2; let busB; let server; let base; let child2;

beforeAll(async () => { await connect(); server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}/api`; });
afterAll(async () => { await new Promise((r) => server.close(r)); await disconnect(); });
beforeEach(async () => {
  await clear();
  tracking.resetForTests();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
  const mk = (school, n, tokenName) => Transport.create({
    school: school._id, busNumber: n, driverName: 'D', driverPhone: '9000011111', routeName: 'R', driverToken: tokenName, trackingId: `t-${tokenName}`,
    stops: LNGS.map((lng, i) => ({ name: `Stop ${i + 1}`, latitude: LAT, longitude: lng, order: i + 1 })),
  });
  bus = await mk(A.school, 'A-BUS-1', 'DRIVERTOKEN-A1');
  bus2 = await mk(A.school, 'A-BUS-2', 'DRIVERTOKEN-A2');
  busB = await mk(B.school, 'B-BUS-1', 'DRIVERTOKEN-B1');
  await Student.updateOne({ _id: A.student._id }, { bus: bus._id, busStopId: bus.stops[2]._id });
  await Student.updateOne({ _id: A.otherStudent._id }, { bus: bus2._id, busStopId: bus2.stops[1]._id });
  await Student.updateOne({ _id: B.student._id }, { bus: busB._id, busStopId: busB.stops[1]._id });
  // a second child of the same parent, on the other bus
  child2 = await Student.create({ name: 'Second Child', phone: '9000000099', rollNumber: '7', class: '8', section: 'A', school: A.school._id, parentUserId: A.parentUser._id, bus: bus2._id, busStopId: bus2.stops[2]._id });
  await Parent.updateOne({ userId: A.parentUser._id }, { $addToSet: { children: child2._id } });
});

const driver = (token, p = '') => `/api/transport/driver/${token}${p}`;
const startTrip = (token, body = {}) => api().patch(driver(token, '/start-trip')).send(body);
const reading = (i, extra = {}) => ({ lat: LAT, lng: LNGS[0] + (i * 50) / (111320 * Math.cos(LAT * Math.PI / 180)), accuracy: 8, at: Date.now() - 60000 + i * 5000, ...extra });
const post = (token, points, body = {}) => api().post(driver(token, '/location')).send({ points, ...body });
const see = (user, id, query = '') => api().get(`/api/transport/live/${id}${query}`).set(auth(user));

// A live stream held open, read line by line.
async function openStream(user, busId, query = '') {
  const ctl = new AbortController();
  const res = await fetch(`${base}/transport/live/${busId}/stream${query}`, { headers: { Authorization: auth(user).Authorization }, signal: ctl.signal });
  const lines = []; let ended = false;
  if (res.status === 200) {
    (async () => {
      const reader = res.body.getReader(); let buf = '';
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += Buffer.from(value).toString('utf8'); let nl; while ((nl = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } } } catch (e) { /* aborted */ }
      ended = true;
    })();
  }
  const waitFor = async (pred, ms = 2500) => { const until = Date.now() + ms; while (Date.now() < until) { const hit = lines.find(pred); if (hit) return hit; await sleep(25); } return null; };
  return { status: res.status, lines, waitFor, ended: () => ended, close: () => ctl.abort() };
}

describe('only the people of this bus see it', () => {
  test('a student and a parent see their own bus; a stranger, another family and another school never do (snapshot and stream)', async () => {
    await startTrip('DRIVERTOKEN-A1');
    expect((await see(A.studentUser, bus._id)).status).toBe(200);
    expect((await see(A.parentUser, bus._id, `?studentId=${A.student._id}`)).status).toBe(200);
    // another family's child, and a bus that is not theirs
    expect((await see(A.otherStudentUser, bus._id)).status).toBe(404);
    expect((await see(A.studentUser, bus2._id)).status).toBe(404);
    // another school: a bus, a student's own bus, the office view
    for (const u of [B.admin, B.parentUser, B.studentUser]) expect((await see(u, bus._id)).status).toBeGreaterThanOrEqual(403);
    expect((await see(A.admin, busB._id)).status).toBe(404);
    const stranger = await openStream(A.otherStudentUser, bus._id); expect(stranger.status).toBe(404);
    const foreign = await openStream(B.studentUser, bus._id); expect(foreign.status).toBe(404);
  });

  test('a parent with two children sees the bus of the child asked for, and only a linked child can be asked for', async () => {
    await startTrip('DRIVERTOKEN-A1'); await startTrip('DRIVERTOKEN-A2');
    expect((await see(A.parentUser, bus._id, `?studentId=${A.student._id}`)).status).toBe(200);
    expect((await see(A.parentUser, bus2._id, `?studentId=${child2._id}`)).status).toBe(200);
    expect((await see(A.parentUser, bus._id, `?studentId=${child2._id}`)).status).toBe(404);   // the other child's id does not open this bus
    expect((await see(A.parentUser, bus2._id, `?studentId=${A.student._id}`)).status).toBe(404);
    // an unrelated student's id (forged) opens nothing, on their own bus or on this one
    expect((await see(A.parentUser, bus2._id, `?studentId=${A.otherStudent._id}`)).status).toBe(404);
    expect((await see(A.parentUser, bus._id, `?studentId=${A.otherStudent._id}`)).status).toBe(404);
    // a student cannot pick someone else's id: the id in the address is ignored for a student
    expect((await see(A.studentUser, bus2._id, `?studentId=${A.otherStudent._id}`)).status).toBe(404);
    // my-child-bus too
    expect((await api().get(`/api/transport/my-child-bus?studentId=${A.otherStudent._id}`).set(auth(A.parentUser))).status).toBe(404);
    expect((await api().get(`/api/transport/my-child-bus?studentId=${child2._id}`).set(auth(A.parentUser))).body.data.busNumber).toBe('A-BUS-2');
  });

  test('the office of one school never sees or changes another school\'s buses', async () => {
    const list = await api().get('/api/transport').set(auth(A.admin));
    expect(list.body.data.map((b) => b.busNumber).sort()).toEqual(['A-BUS-1', 'A-BUS-2']);
    expect((await api().put(`/api/transport/${busB._id}/assign-students`).set(auth(A.admin)).send({ studentIds: [A.student._id] })).status).toBe(404);
    expect((await api().put(`/api/transport/${bus._id}/assign-students`).set(auth(A.admin)).send({ studentIds: [B.student._id] })).status).toBe(400);
    expect((await api().get(`/api/transport/live/${busB._id}/history`).set(auth(A.admin))).status).toBe(404);
    expect((await api().delete(`/api/transport/${busB._id}`).set(auth(A.admin))).status).toBe(404);
    expect((await api().get('/api/transport/live').set(auth(A.studentUser))).status).toBeGreaterThanOrEqual(403);
    expect((await api().get('/api/transport').set(auth(A.parentUser))).status).toBeGreaterThanOrEqual(403);
  });

  test('a driver code works only for its own bus', async () => {
    await startTrip('DRIVERTOKEN-A1'); await startTrip('DRIVERTOKEN-A2');
    await post('DRIVERTOKEN-A1', [reading(0), reading(1)]);
    const mine = await Transport.findById(bus._id).lean(); const other = await Transport.findById(bus2._id).lean();
    expect(mine.live).toBeTruthy(); expect(other.live).toBeUndefined();
    expect((await api().get(driver('DRIVERTOKEN-NOPE'))).status).toBe(404);
  });
});

describe('access is taken away while a map is open', () => {
  const closed = async (s, reason) => { const ev = await s.waitFor((l) => l.type === 'revoked'); expect(ev && ev.reason).toBe(reason); await sleep(60); expect(s.ended()).toBe(true); };

  test('a student taken off the bus loses the live map at once; the parent of a child taken off too', async () => {
    await startTrip('DRIVERTOKEN-A1');
    const student = await openStream(A.studentUser, bus._id);
    const parent = await openStream(A.parentUser, bus._id, `?studentId=${A.student._id}`);
    expect(student.status).toBe(200); expect(parent.status).toBe(200);
    await student.waitFor((l) => l.type === 'snapshot');
    const r = await api().put(`/api/transport/${bus._id}/assign-students`).set(auth(A.admin)).send({ studentIds: [] });
    expect(r.status).toBe(200);
    await closed(student, 'assignment'); await closed(parent, 'assignment');
    expect((await see(A.studentUser, bus._id)).status).toBe(404);
  });

  test('a child moved to another bus: the old bus\'s map closes, the new bus opens', async () => {
    await startTrip('DRIVERTOKEN-A1'); await startTrip('DRIVERTOKEN-A2');
    const old = await openStream(A.parentUser, bus._id, `?studentId=${A.student._id}`);
    await old.waitFor((l) => l.type === 'snapshot');
    await api().put(`/api/transport/${bus2._id}/assign-students`).set(auth(A.admin)).send({ studentIds: [A.otherStudent._id, child2._id, A.student._id] });
    await closed(old, 'assignment');
    const fresh = await openStream(A.parentUser, bus2._id, `?studentId=${A.student._id}`);
    expect(fresh.status).toBe(200); fresh.close();
  });

  test('a disabled account, a signed-out session, a suspended school and a deleted bus close the map', async () => {
    await startTrip('DRIVERTOKEN-A1');
    const disabled = await openStream(A.studentUser, bus._id);
    await disabled.waitFor((l) => l.type === 'snapshot');
    await User.updateOne({ _id: A.studentUser._id }, { isActive: false });
    await closed(disabled, 'account');

    const signedOut = await openStream(A.parentUser, bus._id, `?studentId=${A.student._id}`);
    await signedOut.waitFor((l) => l.type === 'snapshot');
    expect((await api().post('/api/users/logout-all').set(auth(A.parentUser))).status).toBe(200);
    await closed(signedOut, 'session');
    expect((await see(A.parentUser, bus._id, `?studentId=${A.student._id}`)).status).toBe(401);

    const office = await openStream(A.admin, bus._id);
    await office.waitFor((l) => l.type === 'snapshot');
    await api().delete(`/api/transport/${bus._id}`).set(auth(A.admin));
    await closed(office, 'bus');
  });

  test('a school that is suspended while a map is open closes it', async () => {
    await startTrip('DRIVERTOKEN-A1');
    const s = await openStream(A.admin, bus._id);
    await s.waitFor((l) => l.type === 'snapshot');
    await School.updateOne({ _id: A.school._id }, { isActive: false });
    await closed(s, 'school');
  });

  test('while access holds, the map stays open and keeps receiving positions', async () => {
    await startTrip('DRIVERTOKEN-A1');
    const s = await openStream(A.studentUser, bus._id);
    await s.waitFor((l) => l.type === 'snapshot');
    await sleep(500); // several re-checks have passed
    await post('DRIVERTOKEN-A1', [reading(0), reading(1)]);
    expect(await s.waitFor((l) => l.type === 'position')).toBeTruthy();
    expect(s.lines.some((l) => l.type === 'revoked')).toBe(false);
    s.close();
  });
});

describe('one running trip per bus, one phone per trip', () => {
  test('starting a trip that is already running is refused, and does not reset it or tell the parents again', async () => {
    const first = await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-one-1234' });
    expect(first.status).toBe(200);
    await post('DRIVERTOKEN-A1', [reading(0), reading(1)], { deviceId: 'phone-one-1234' });
    const again = await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-one-1234' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'TRIP_ALREADY_RUNNING', thisPhone: true, tripId: first.body.data.tripId });
    expect((await Transport.findById(bus._id)).tripId).toBe(first.body.data.tripId);
    await sleep(60);
    const told = await Notification.find({ recipient: A.parentUser._id, title: /has started/ });
    expect(told).toHaveLength(1);
  });

  test('another phone is told the trip runs elsewhere; it may take over only on purpose', async () => {
    const first = await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-one-1234' });
    const other = await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-two-5678' });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'TRIP_ALREADY_RUNNING', thisPhone: false });
    const view = await api().get(`${driver('DRIVERTOKEN-A1')}?deviceId=phone-two-5678`);
    expect(view.body.data).toMatchObject({ busStatus: 'On Route', thisPhone: false });
    expect(view.body.data.driverDevice).toBeUndefined();
    const same = await api().get(`${driver('DRIVERTOKEN-A1')}?deviceId=phone-one-1234`);
    expect(same.body.data.thisPhone).toBe(true);
    const takeover = await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-two-5678', restart: true });
    expect(takeover.status).toBe(200);
    expect(takeover.body.data.tripId).not.toBe(first.body.data.tripId);
  });

  test('readings and "reached stop" from a second phone are refused while the trip runs; the right phone is accepted', async () => {
    await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-one-1234' });
    const wrong = await post('DRIVERTOKEN-A1', [reading(0)], { deviceId: 'phone-two-5678' });
    expect(wrong.status).toBe(409); expect(wrong.body.code).toBe('OTHER_PHONE');
    expect((await post('DRIVERTOKEN-A1', [reading(0)])).status).toBe(409); // a phone that does not say who it is
    expect((await api().patch(driver('DRIVERTOKEN-A1', '/stop-done')).send({ deviceId: 'phone-two-5678' })).status).toBe(409);
    const right = await post('DRIVERTOKEN-A1', [reading(0), reading(1)], { deviceId: 'phone-one-1234' });
    expect(right.status).toBe(200); expect(right.body.data.accepted).toBe(2);
    expect((await api().patch(driver('DRIVERTOKEN-A1', '/stop-done')).send({ deviceId: 'phone-one-1234' })).status).toBe(200);
  });

  test('a trip nobody has heard from for a long time can be replaced without a takeover; ending is allowed from any phone and frees the bus', async () => {
    await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-one-1234' });
    await Transport.updateOne({ _id: bus._id }, { $set: { tripStartedAt: new Date(Date.now() - 20 * 60 * 1000), 'live.receivedAt': Date.now() - 20 * 60 * 1000 } });
    const replaced = await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-two-5678' });
    expect(replaced.status).toBe(200);
    expect((await api().patch(driver('DRIVERTOKEN-A1', '/end-trip')).send({})).status).toBe(200); // the other phone ends it
    expect((await Transport.findById(bus._id)).driverDevice).toBeUndefined();
    expect((await post('DRIVERTOKEN-A1', [reading(0)], { deviceId: 'phone-two-5678' })).status).toBe(409); // trip over: nothing is published
    expect((await startTrip('DRIVERTOKEN-A1', { deviceId: 'phone-three-9999' })).status).toBe(200);
  });

  test('a phone that does not send an id (an older app) still works when the trip it started has no phone recorded', async () => {
    expect((await startTrip('DRIVERTOKEN-A2')).status).toBe(200);
    const r = await post('DRIVERTOKEN-A2', [reading(0), reading(1)]);
    expect(r.status).toBe(200); expect(r.body.data.accepted).toBe(2);
  });
});
