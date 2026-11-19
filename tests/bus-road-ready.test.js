// The road line is ready before any trip: it is fetched when someone first looks at an idle bus (or when the stops are saved), is
// stored for exactly those stops, and is not reused after the stops are edited. A stop taken off the route no longer holds a pick-up place.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Transport = require('../src/models/Transport');
const Student = require('../src/models/Student');
const tracking = require('../src/services/busTracking');

let A; let bus; let realFetch;
const STOPS = [[25.30397, 82.99625], [25.3060, 82.9860], [25.30738, 82.99644], [25.3047, 82.9975]];

// An OSRM-shaped answer: the road bends between the stops (an extra point), so it is longer than the straight line.
const osrm = () => jest.fn(async (url) => {
  const coords = String(url).split('/driving/')[1].split('?')[0].split(';').map((c) => c.split(',').map(Number));
  const line = [];
  coords.forEach((c, i) => { if (i) line.push([(coords[i - 1][0] + c[0]) / 2 + 0.002, (coords[i - 1][1] + c[1]) / 2 - 0.002]); line.push(c); });
  return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ geometry: { coordinates: line } }] }) };
});
const until = async (fn, ms = 3000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 40)); } };
const live = async () => (await api().get(`/api/transport/live/${bus._id}`).set(auth(A.admin))).body.data;

beforeAll(async () => { await connect(); realFetch = global.fetch; });
afterAll(async () => { global.fetch = realFetch; delete process.env.ROUTING_URL; await disconnect(); });
beforeEach(async () => {
  await clear();
  tracking.resetForTests();
  process.env.ROUTING_URL = 'http://osrm.test';
  global.fetch = osrm();
  A = await seedSchool('Alpha School');
  bus = await Transport.create({
    school: A.school._id, busNumber: 'UP65 GV 0001', driverName: 'Ramesh', driverPhone: '9000011111', routeName: 'Varanasi', driverToken: 'GVPS-BUS-1', trackingId: 'trk1',
    assignedStudents: [A.student._id], stops: STOPS.map(([latitude, longitude], i) => ({ name: `Stop ${i + 1}`, latitude, longitude, order: i + 1 })),
  });
});

test('an idle bus gets its road before any trip, and it is kept for the next trip', async () => {
  const first = await live();
  expect(first.status).toBe('Idle');
  await until(async () => (await live()).route.source === 'road');
  const stored = await Transport.findById(bus._id).lean();
  expect(stored.route.source).toBe('road');
  expect(stored.route.points.length).toBeGreaterThan(STOPS.length);
  // The trip start reuses it instead of asking the routing service again.
  global.fetch.mockClear();
  const started = await api().patch('/api/transport/driver/GVPS-BUS-1/start-trip').send({});
  expect(started.status).toBe(200);
  expect(started.body.data.routeSource).toBe('road');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('after the stops are edited the old road is not used, and a new one follows', async () => {
  await live();
  await until(async () => (await live()).route.source === 'road');
  const edited = STOPS.map(([latitude, longitude], i) => ({ name: `Stop ${i + 1}`, latitude: i === 1 ? latitude + 0.004 : latitude, longitude, order: i + 1 }));
  global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })); // routing is down for a moment
  const res = await api().put(`/api/transport/${bus._id}/stops`).set(auth(A.admin)).send({ stops: edited });
  expect(res.status).toBe(200);
  const after = await live();
  expect(after.route.source).toBe('straight'); // not the road of the old stops
  expect(after.route.points).toHaveLength(4);
});

test('a stop taken off the route is cleared from the students who used it', async () => {
  const stopId = bus.stops[2]._id;
  await Student.updateOne({ _id: A.student._id }, { bus: bus._id, busStopId: stopId });
  const keep = bus.stops.filter((s) => String(s._id) !== String(stopId)).map((s) => s.toObject());
  const res = await api().put(`/api/transport/${bus._id}/stops`).set(auth(A.admin)).send({ stops: keep });
  expect(res.status).toBe(200);
  expect((await Student.findById(A.student._id)).busStopId).toBeNull();
});

test('when no road can be had, the route says why (viewers and the admin screen can show it), and a viewer asking again tries once more', async () => {
  process.env.BUS_ROUTE_RETRY_MS = '150';
  global.fetch = jest.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })); // the routing service refuses
  await live();
  const refused = await until(async () => { const r = (await live()).route; return r.reason ? r : null; });
  expect(refused.source).toBe('straight');
  expect(refused.reason).toBe('http_429');
  // The service recovers; the next look (after the short wait) gets the road, and the reason is gone.
  global.fetch = osrm();
  await until(async () => (await live()).route.source === 'road', 5000);
  const road = (await live()).route;
  expect(road.reason).toBeUndefined();
  delete process.env.BUS_ROUTE_RETRY_MS;
});
