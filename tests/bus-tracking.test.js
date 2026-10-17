// Live bus tracking, end to end through the HTTP API: a driver phone sends GPS readings, the server follows the route and the
// stops, and parents, students and the school see the same bus. No routing service or Firebase is contacted (ROUTING_URL is off
// under test, so the road is the straight line between the stops).

const http = require('http');
const { api, app, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Transport = require('../src/models/Transport');
const Student = require('../src/models/Student');
const Notification = require('../src/models/Notification');
const tracking = require('../src/services/busTracking');

let A;
let bus;
let student;
const LAT = 24.75;
// Four stops east along one road, about 600 m apart; the last is the school.
const LNGS = [84.990, 84.996, 85.002, 85.008];
const M_PER_DEG = 111320 * Math.cos(LAT * Math.PI / 180);
const T0 = Date.now() - 20 * 60 * 1000; // readings are stamped in the recent past, five seconds apart

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  tracking.resetForTests();
  A = await seedSchool('Alpha School');
  bus = await Transport.create({
    school: A.school._id, busNumber: 'BR02 AB 1234', driverName: 'Ramesh', driverPhone: '9000011111', routeName: 'Gaya Route',
    driverToken: 'DRIVERTOKEN-0001', trackingId: 'trk1', assignedStudents: [A.student._id],
    stops: LNGS.map((lng, i) => ({ name: i === 3 ? 'School' : `Stop ${i + 1}`, latitude: LAT, longitude: lng, order: i + 1 })),
  });
  student = await Student.findByIdAndUpdate(A.student._id, { bus: bus._id, busStopId: bus.stops[2]._id }, { new: true });
});

const driver = (path = '') => `/api/transport/driver/DRIVERTOKEN-0001${path}`;
const start = (body = {}) => api().patch(driver('/start-trip')).send(body);
const post = (points) => api().post(driver('/location')).send({ points });
const at = (i) => T0 + i * 5000;
// n readings driving east at 10 m/s from the longitude `lng0`, the first stamped step `i0`.
const drive = (lng0, n, i0 = 0, extra = {}) => Array.from({ length: n }, (_, k) => ({
  lat: LAT, lng: lng0 + (k * 50) / M_PER_DEG, accuracy: 8, at: at(i0 + k), ...extra,
}));
const snap = async (user = A.parentUser, id = bus._id) => (await api().get(`/api/transport/live/${id}`).set(auth(user))).body.data;
const titles = async () => (await Notification.find({ recipient: A.parentUser._id }).sort({ createdAt: 1 })).map((n) => n.title);
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('the trip and who may watch it', () => {
  test('a trip needs a route, an invalid code is refused, and readings are refused before the trip starts', async () => {
    expect((await api().patch('/api/transport/driver/NOPE/start-trip').send({})).status).toBe(404);
    expect((await post(drive(LNGS[0], 2))).status).toBe(409);
    const empty = await Transport.create({ school: A.school._id, busNumber: 'EMPTY', driverName: 'X', driverPhone: '1', routeName: 'R', driverToken: 'EMPTY-TOKEN-1' });
    expect((await api().patch('/api/transport/driver/EMPTY-TOKEN-1/start-trip').send({})).status).toBe(409);
    expect(empty.stops).toHaveLength(0);
    const res = await start();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ busStatus: 'On Route', currentStopIndex: 0, direction: 'pickup', routeSource: 'straight' });
  });

  test('a parent and the student see their own bus; another family and a bus of another school are refused', async () => {
    await start();
    expect((await api().get(`/api/transport/live/${bus._id}`)).status).toBe(401);
    expect((await snap(A.parentUser)).status).toBe('On Route');
    expect((await snap(A.studentUser)).status).toBe('On Route');
    expect((await snap(A.admin)).stops).toHaveLength(4);
    // A student on no bus, and a teacher without the transport permission, cannot watch.
    expect((await api().get(`/api/transport/live/${bus._id}`).set(auth(A.otherStudentUser))).status).toBe(404);
    expect((await api().get(`/api/transport/live/${bus._id}`).set(auth(A.teacherUser))).status).toBe(403);
    const B = await seedSchool('Beta School');
    expect((await api().get(`/api/transport/live/${bus._id}`).set(auth(B.admin))).status).toBe(404);
    expect((await api().get(`/api/transport/live/${bus._id}`).set(auth(B.parentUser))).status).toBe(404);
  });

  test('the child\'s bus tells the app which bus and which stop is theirs', async () => {
    const res = await api().get('/api/transport/my-child-bus').set(auth(A.parentUser));
    expect(res.body.data).toMatchObject({ busId: String(bus._id), myStopId: String(bus.stops[2]._id), busStatus: 'Idle' });
    expect(res.body.data.firebasePath).toBeUndefined();
  });
});

describe('following the bus along the road', () => {
  test('readings move the bus along the route, stop by stop, and ETAs count down', async () => {
    await start();
    // The whole route is 1800 m: 36 readings at 50 m each, 10 m/s.
    let last = null; const etasToSchool = []; const passed = [];
    for (let i = 0; i < 36; i += 4) {
      const res = await post(drive(LNGS[0] + (i * 50) / M_PER_DEG, 4, i));
      expect(res.status).toBe(200);
      expect(res.body.data.accepted).toBe(4);
      last = res.body.data;
      etasToSchool.push(last.etas[3]);
      passed.push(last.currentStopIndex);
    }
    // Stops are reached and left by themselves: the index only grows, and ends on the school.
    expect(passed).toEqual([...passed].sort((a, b) => a - b));
    expect(passed.at(-1)).toBeGreaterThanOrEqual(2);
    const s = await snap();
    expect(s.signal).toBe('live');
    expect(s.position.lat).toBeCloseTo(LAT, 4); // snapped onto the road
    expect(s.position.routeMeters).toBeGreaterThan(1500);
    expect(s.position.speedKmh).toBeGreaterThanOrEqual(30);
    expect(s.position.speedKmh).toBeLessThanOrEqual(40);
    expect(s.position.heading).toBeGreaterThan(80);
    expect(s.position.heading).toBeLessThan(100); // east
    const defined = etasToSchool.filter((x) => x !== null);
    expect(defined[0]).toBeGreaterThan(defined.at(-1) - 1);
    expect(s.stops.map((x) => x.status)).toEqual(expect.arrayContaining(['Departed']));
    expect(s.stops[0].status).toBe('Departed');
  });

  test('driving through a stop marks it reached, and leaving it marks it departed and makes the next one current', async () => {
    await start();
    // Stop 1 is at metre 0, stop 2 at metre 604. Starting at stop 1 marks it reached; 130 m on, it is departed.
    await post(drive(LNGS[0], 2, 0)); // 0 and 50 m
    let db = await Transport.findById(bus._id);
    expect(db.stops[0].arrivedAt).toBeDefined();
    expect((await snap()).currentStopIndex).toBe(0);
    await post(drive(LNGS[0] + 100 / M_PER_DEG, 3, 2)); // 100, 150, 200 m
    expect((await snap()).currentStopIndex).toBe(1);
    db = await Transport.findById(bus._id);
    expect(db.stops[0].status).toBe('Departed');
    expect(db.stops[1].status).toBe('Live');
    // 450 m is still 150 m short of stop 2; 560 m is within its 70 m.
    await post(drive(LNGS[0] + 450 / M_PER_DEG, 1, 10));
    expect((await Transport.findById(bus._id)).stops[1].arrivedAt).toBeUndefined();
    await post(drive(LNGS[0] + 560 / M_PER_DEG, 1, 12));
    expect((await Transport.findById(bus._id)).stops[1].arrivedAt).toBeDefined();
    expect((await snap()).currentStopIndex).toBe(1);
    await post(drive(LNGS[0] + 760 / M_PER_DEG, 1, 14)); // 156 m past stop 2
    expect((await snap()).currentStopIndex).toBe(2);
  });

  test('a bundle of readings that passes several stops marks each one in order', async () => {
    await start();
    const res = await post(drive(LNGS[0], 30, 0)); // 0 to 1450 m in one go
    expect(res.body.data.currentStopIndex).toBe(3); // the school is next
    const db = await Transport.findById(bus._id);
    expect(db.stops.map((x) => x.status)).toEqual(['Departed', 'Departed', 'Departed', 'Live']);
    expect(db.stops[0].arrivedAt && db.stops[1].arrivedAt && db.stops[2].arrivedAt).toBeTruthy();
  });

  test('the driver\'s button moves on to the next stop by hand, and the old single-reading call still works', async () => {
    await start();
    const done = await api().patch(driver('/stop-done'));
    expect(done.body.data.currentStopIndex).toBe(1);
    expect(done.body.data.stops[0].status).toBe('Departed');
    expect(done.body.data.stops[1].status).toBe('Live');
    const old = await api().post(driver('/update-location')).send({ lat: LAT, lng: LNGS[1] });
    expect(old.status).toBe(200);
    expect(old.body.data.accepted).toBe(1);
  });

  test('a bus that is off the road is shown where it is and marked off route', async () => {
    await start();
    await post([{ lat: LAT + 0.01, lng: LNGS[0] + 0.002, accuracy: 6, at: at(0) }]);
    const s = await snap();
    expect(s.position.offRoute).toBe(true);
    expect(s.position.lat).toBeCloseTo(LAT + 0.01, 5);
  });
});

describe('bad readings never reach the map', () => {
  test('wrong coordinates, poor accuracy, jumps, old and repeated readings are dropped and counted', async () => {
    await start();
    expect((await post([{ lat: 'x', lng: 1 }])).status).toBe(400);
    expect((await post([{ lat: 95, lng: 1 }])).status).toBe(400);
    const ok = await post(drive(LNGS[0], 3, 0));
    expect(ok.body.data.accepted).toBe(3);
    const bad = await post([
      { lat: LAT, lng: LNGS[0], accuracy: 400, at: at(5) },                      // too imprecise
      { lat: LAT + 0.3, lng: LNGS[0], accuracy: 5, at: at(6) },                  // 33 km in 5 seconds
      { lat: 0, lng: 0, accuracy: 5, at: at(7) },                                // the "no fix" position
      ...drive(LNGS[0], 3, 0),                                                    // the same readings again
    ]);
    expect(bad.body.data.accepted).toBe(0);
    expect(bad.body.data.reasons).toMatchObject({ poor_accuracy: 1, gps_jump: 1, coordinates: 1, old_or_repeat: 3 });
    const s = await snap();
    expect(s.position.lat).toBeCloseTo(LAT, 4); // the jump never moved the bus
  });

  test('readings that were kept on the phone while offline arrive in a bundle, in any order, and play back in order', async () => {
    await start();
    const bundle = drive(LNGS[0], 12, 0).reverse();
    const res = await post(bundle);
    expect(res.body.data.accepted).toBe(12);
    const s = await snap();
    expect(s.position.routeMeters).toBeGreaterThan(500); // the newest reading won, not the first received
    expect((await post(Array.from({ length: 61 }, (_, k) => ({ lat: LAT, lng: LNGS[0], at: at(100 + k) })))).status).toBe(400);
  });

  test('a standing bus does not drift: GPS noise around one place keeps the same position', async () => {
    await start();
    await post(drive(LNGS[0], 3, 0));
    const before = (await snap()).position;
    await post([{ lat: LAT, lng: before.lng + 2 / M_PER_DEG, accuracy: 15, speed: 0, at: at(4) }, { lat: LAT, lng: before.lng - 3 / M_PER_DEG, accuracy: 15, speed: 0, at: at(5) }]);
    const after = (await snap()).position;
    expect(after.lng).toBeCloseTo(before.lng, 6);
    expect(after.speedKmh).toBe(0);
  });
});

describe('what viewers are told, once', () => {
  test('parents hear about the start, the bus being near their child\'s stop, and the bus at the stop, each once; and the end', async () => {
    await start();
    await settle();
    // The child's stop is stop 3 (metre 1200). About 5 minutes away at the default speed is ~ 1.5 km, so it fires at once;
    // drive close to the stop after that.
    await post(drive(LNGS[0], 20, 0));          // up to 950 m
    await post(drive(LNGS[0] + 950 / M_PER_DEG, 5, 20));
    await post(drive(LNGS[0] + 950 / M_PER_DEG, 5, 20)); // the same readings sent twice
    await settle();
    await post([{ lat: LAT, lng: LNGS[2] - 30 / M_PER_DEG, accuracy: 5, at: at(30) }]);
    await settle();
    await post([{ lat: LAT, lng: LNGS[2] - 25 / M_PER_DEG, accuracy: 5, at: at(31) }]);
    await settle();
    const t = await titles();
    expect(t.filter((x) => /has started/.test(x))).toHaveLength(1);
    expect(t.filter((x) => /min away/.test(x))).toHaveLength(1);
    expect(t.filter((x) => /is at the stop/.test(x))).toHaveLength(1);
    await api().patch(driver('/end-trip'));
    await settle();
    expect((await titles()).filter((x) => /trip ended/.test(x))).toHaveLength(1);
  });

  test('a different student\'s parent is not told about this child\'s stop', async () => {
    await start();
    await post(drive(LNGS[0], 20, 0));
    await settle();
    const other = await Notification.countDocuments({ school: A.school._id, recipient: A.admin._id });
    expect(other).toBe(0);
  });
});

describe('signal and the end of the trip', () => {
  test('no reading for a while shows "signal lost" and a new reading brings it back', async () => {
    await start();
    await post(drive(LNGS[0], 2, 0));
    expect((await snap()).signal).toBe('live');
    process.env.BUS_STALE_MS = '1';
    await new Promise((r) => setTimeout(r, 10));
    expect((await snap()).signal).toBe('lost');
    delete process.env.BUS_STALE_MS;
    await post(drive(LNGS[0] + 100 / M_PER_DEG, 1, 3));
    expect((await snap()).signal).toBe('live');
  });

  test('ending the trip clears the position, refuses more readings, and shows the bus as completed', async () => {
    await start();
    await post(drive(LNGS[0], 3, 0));
    expect((await api().patch(driver('/end-trip'))).status).toBe(200);
    const s = await snap();
    expect(s).toMatchObject({ status: 'Completed', position: null });
    const res = await post(drive(LNGS[0], 1, 4));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRIP_NOT_ACTIVE');
  });

  test('a trip whose phone went quiet for hours is closed by the clean-up', async () => {
    await start();
    await post(drive(LNGS[0], 2, 0));
    expect(await tracking.closeAbandonedTrips(3)).toBe(0);
    expect(await tracking.closeAbandonedTrips(3, Date.now() + 4 * 3600 * 1000)).toBe(1);
    expect((await Transport.findById(bus._id)).busStatus).toBe('Completed');
  });

  test('a new trip starts clean: stops reset, no old position, messages allowed again', async () => {
    await start();
    await post(drive(LNGS[0], 30, 0));
    await api().patch(driver('/end-trip'));
    await settle();
    await start();
    const s = await snap();
    expect(s.position).toBeNull();
    expect(s.currentStopIndex).toBe(0);
    expect(s.stops.map((x) => x.status)).toEqual(['Live', 'Pending', 'Pending', 'Pending']);
    expect(s.signal).toBe('waiting');
  });
});

describe('the drop run', () => {
  test('in the afternoon the stops come in reverse, from the school out, and the bus follows them', async () => {
    const res = await start({ direction: 'drop' });
    expect(res.body.data.direction).toBe('drop');
    const s = await snap();
    expect(s.stops.map((x) => x.name)).toEqual(['School', 'Stop 3', 'Stop 2', 'Stop 1']);
    expect(s.stops[0].status).toBe('Live');
    // Driving west from the school past the first stop.
    const west = Array.from({ length: 14 }, (_, k) => ({ lat: LAT, lng: LNGS[3] - (k * 50) / M_PER_DEG, accuracy: 6, at: at(k) }));
    await post(west);
    const after = await snap();
    expect(after.currentStopIndex).toBeGreaterThanOrEqual(1);
    expect(after.position.heading).toBeGreaterThan(260);
    expect(after.position.heading).toBeLessThan(280);
  });
});

describe('the school office', () => {
  test('the live view lists only buses on a trip, and the history keeps the sampled points', async () => {
    expect((await api().get('/api/transport/live').set(auth(A.admin))).body.data).toHaveLength(0);
    await start();
    await post(drive(LNGS[0], 10, 0));
    await settle();
    const live = await api().get('/api/transport/live').set(auth(A.admin));
    expect(live.body.data).toHaveLength(1);
    expect(live.body.data[0].route).toBeUndefined();
    expect((await api().get('/api/transport/live').set(auth(A.parentUser))).status).toBe(403);
    const hist = await api().get(`/api/transport/live/${bus._id}/history`).set(auth(A.admin));
    expect(hist.body.data.length).toBeGreaterThanOrEqual(1);
    expect(hist.body.data[0]).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
  });

  test('assigning students records each one\'s stop; a stop of another bus is ignored', async () => {
    const other = await Transport.create({ school: A.school._id, busNumber: 'OTHER', driverName: 'Y', driverPhone: '2', routeName: 'R2', driverToken: 'OTHER-TOKEN-1', stops: [{ name: 'Elsewhere', latitude: 1, longitude: 1, order: 1 }] });
    const res = await api().put(`/api/transport/${bus._id}/assign-students`).set(auth(A.admin))
      .send({ studentIds: [String(A.student._id), String(A.otherStudent._id)], stopIds: { [A.student._id]: String(bus.stops[1]._id), [A.otherStudent._id]: String(other.stops[0]._id) } });
    expect(res.status).toBe(200);
    expect(String((await Student.findById(A.student._id)).busStopId)).toBe(String(bus.stops[1]._id));
    expect((await Student.findById(A.otherStudent._id)).busStopId).toBeNull();
    // Taking a student off the bus clears the stop too.
    await api().put(`/api/transport/${bus._id}/assign-students`).set(auth(A.admin)).send({ studentIds: [String(A.otherStudent._id)] });
    const gone = await Student.findById(A.student._id);
    expect(gone.bus).toBeNull();
    expect(gone.busStopId).toBeNull();
  });
});

describe('the live stream', () => {
  test('a viewer gets the snapshot first and then each change, and a stranger gets nothing', async () => {
    await start();
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}/api/transport/live/${bus._id}/stream`;
    const token = auth(A.parentUser).Authorization;
    const ctl = new AbortController();
    const res = await fetch(base, { headers: { Authorization: token }, signal: ctl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const reader = res.body.getReader();
    const lines = [];
    let buf = '';
    const next = async () => {
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); return JSON.parse(line); }
        const { value, done } = await reader.read();
        if (done) return null;
        buf += Buffer.from(value).toString('utf8');
      }
    };
    lines.push(await next());
    expect(lines[0]).toMatchObject({ type: 'snapshot', status: 'On Route', position: null });
    expect(lines[0].route.points.length).toBeGreaterThanOrEqual(2);
    await post(drive(LNGS[0], 4, 0));
    let ev = await next();
    while (ev && ev.type !== 'position') ev = await next(); // a stop change may come first
    expect(ev).toMatchObject({ type: 'position' });
    expect(ev.position.lat).toBeCloseTo(LAT, 4);
    expect(ev.etas).toHaveLength(4);
    ctl.abort();
    const stranger = await fetch(base, { headers: { Authorization: auth(A.otherStudentUser).Authorization } });
    expect(stranger.status).toBe(404);
    await new Promise((r) => server.close(r));
  });
});

describe('the geometry', () => {
  test('distances, projection onto the road, and simplifying a line', () => {
    expect(tracking.distance(LAT, LNGS[0], LAT, LNGS[1])).toBeGreaterThan(590);
    expect(tracking.distance(LAT, LNGS[0], LAT, LNGS[1])).toBeLessThan(620);
    const route = tracking.buildRoute(LNGS.map((lng) => [LAT, lng]));
    const p = tracking.project(route, LAT + 0.0002, LNGS[1] + 0.001);
    expect(p.d).toBeGreaterThan(15);
    expect(p.d).toBeLessThan(30);
    expect(p.meters).toBeGreaterThan(600);
    const line = Array.from({ length: 50 }, (_, i) => [LAT, 84.99 + i * 0.0001]);
    expect(tracking.simplify(line, 3)).toHaveLength(2);
    expect(tracking.simplify([[0, 0], [0.001, 0.0005], [0, 0.001]], 3)).toHaveLength(3);
  });
});
