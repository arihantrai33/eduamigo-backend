// More than one server instance: the driver's phone may be talking to one instance while a parent's screen is connected to another.
// The picture of a bus is kept in each process's memory, so an instance that did not write the bus itself must look in the database
// (services/busTracking.js, "several server instances"). "Another instance" is simulated by writing to the database directly.
process.env.BUS_SYNC_MS = '20';
process.env.BUS_IDLE_SYNC_MS = '20';
process.env.BUS_OWNER_MS = '60';

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Transport = require('../src/models/Transport');
const Student = require('../src/models/Student');
const tracking = require('../src/services/busTracking');

let A; let bus;
const LAT = 24.75;
const LNGS = [84.990, 84.996, 85.002, 85.008];
const M_PER_DEG = 111320 * Math.cos(LAT * Math.PI / 180);
const T0 = Date.now() - 20 * 60 * 1000;
const at = (i) => T0 + i * 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  tracking.resetForTests();
  A = await seedSchool('Alpha School');
  bus = await Transport.create({
    school: A.school._id, busNumber: 'BR02 AB 1234', driverName: 'Ramesh', driverPhone: '9000011111', routeName: 'Gaya Route',
    driverToken: 'DRIVERTOKEN-0002', trackingId: 'trk2', assignedStudents: [A.student._id],
    stops: LNGS.map((lng, i) => ({ name: `Stop ${i + 1}`, latitude: LAT, longitude: lng, order: i + 1 })),
  });
  await Student.findByIdAndUpdate(A.student._id, { bus: bus._id, busStopId: bus.stops[2]._id });
});
afterEach(() => jest.restoreAllMocks());

const driver = (p = '') => `/api/transport/driver/DRIVERTOKEN-0002${p}`;
const start = () => api().patch(driver('/start-trip')).send({});
const post = (points) => api().post(driver('/location')).send({ points });
const reading = (lngMetres, i, extra = {}) => ({ lat: LAT, lng: LNGS[0] + lngMetres / M_PER_DEG, accuracy: 8, at: at(i), ...extra });
const snap = async () => (await api().get(`/api/transport/live/${bus._id}`).set(auth(A.parentUser))).body.data;

test('a trip started by another instance shows up here without a restart', async () => {
  expect((await snap()).status).toBe('Idle'); // this instance now holds the bus as idle
  await Transport.updateOne({ _id: bus._id }, { $set: { busStatus: 'On Route', tripId: 'trip-from-elsewhere', currentStopIndex: 0, 'stops.0.status': 'Live' } });
  await sleep(40);
  const now = await snap();
  expect(now).toMatchObject({ status: 'On Route', tripId: 'trip-from-elsewhere' });
});

test('readings received by another instance move the bus on this instance, and the people watching here are told', async () => {
  expect((await start()).status).toBe(200);
  await post([reading(0, 0), reading(50, 1)]);
  await sleep(100); // this instance is no longer the one in charge of the bus
  const events = [];
  const stop = tracking.subscribe(String(bus._id), (e) => events.push(e));
  const when = Date.now();
  await Transport.updateOne({ _id: bus._id }, { $set: { live: { lat: LAT, lng: LNGS[0] + 400 / M_PER_DEG, heading: 90, speedKmh: 20, avgKmh: 20, accuracy: 8, at: when, receivedAt: when, routeMeters: 400, offRoute: false }, currentStopIndex: 1, 'stops.0.status': 'Departed', 'stops.1.status': 'Live' } });
  await sleep(250);
  stop();
  const moved = events.filter((e) => e.type === 'position' && e.position.at === when);
  expect(moved).toHaveLength(1);
  expect(moved[0].position.routeMeters).toBe(400);
  expect(events.some((e) => e.type === 'stops' && e.currentStopIndex === 1)).toBe(true);
  expect((await snap()).position.routeMeters).toBe(400);
});

test('a trip ended by another instance is shown as ended here', async () => {
  await start();
  await post([reading(0, 0)]);
  await sleep(100);
  const events = [];
  const stop = tracking.subscribe(String(bus._id), (e) => events.push(e));
  await Transport.updateOne({ _id: bus._id }, { $set: { busStatus: 'Completed' }, $unset: { live: 1 } });
  await sleep(250);
  stop();
  expect(events.some((e) => e.type === 'snapshot' && e.status === 'Completed')).toBe(true);
  expect((await snap()).status).toBe('Completed');
});

test('the instance that is receiving the readings does not read the database to stay in step', async () => {
  const prev = process.env.BUS_OWNER_MS; process.env.BUS_OWNER_MS = '5000';
  try {
    await start();
    await post([reading(0, 0)]);
    const spy = jest.spyOn(Transport, 'findOne');
    for (let i = 0; i < 5; i += 1) { await sleep(25); await tracking.stateOf(bus._id); }
    expect(spy).not.toHaveBeenCalled();
  } finally { process.env.BUS_OWNER_MS = prev; }
});

test('a reading handled here after another instance moved the bus on continues from the newer position', async () => {
  await start();
  await post([reading(0, 0), reading(50, 1)]);
  await sleep(100);
  const newer = at(6);
  await Transport.updateOne({ _id: bus._id }, { $set: { live: { lat: LAT, lng: LNGS[0] + 300 / M_PER_DEG, heading: 90, speedKmh: 36, avgKmh: 30, accuracy: 8, at: newer, receivedAt: Date.now(), routeMeters: 300, offRoute: false } } });
  const old = await post([reading(150, 3)]);               // older than what the other instance already stored
  expect(old.body.data.reasons).toMatchObject({ old_or_repeat: 1 });
  const next = await post([reading(350, 7)]);              // newer: accepted, and the bus is shown past the other instance's 300 m
  expect(next.body.data.accepted).toBe(1);
  expect((await snap()).position.routeMeters).toBeGreaterThanOrEqual(340);
});

test('when another instance is writing the bus too, this one keeps following the database even while it also writes', async () => {
  await start();
  await post([reading(0, 0)]);
  await sleep(100); // past BUS_OWNER_MS: this instance has to look
  const elsewhere = (m, i) => Transport.updateOne({ _id: bus._id }, { $set: { live: { lat: LAT, lng: LNGS[0] + m / M_PER_DEG, heading: 90, speedKmh: 20, avgKmh: 20, accuracy: 8, at: at(i), receivedAt: Date.now(), routeMeters: m, offRoute: false } } });
  await elsewhere(100, 3);
  await tracking.stateOf(bus._id); // sees a reading it did not write: the bus is now shared
  await post([reading(150, 4)]);   // and it writes one itself, so it would normally think it is in charge
  await elsewhere(250, 5);         // the other instance writes again right away
  await sleep(40);
  expect((await snap()).position.routeMeters).toBe(250);
});
