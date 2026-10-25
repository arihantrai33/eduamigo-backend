// Driver trip basics (the live tracking itself is in bus-tracking.test.js). Nothing here needs Firebase any more.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Transport = require('../src/models/Transport');

let A;
let bus;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  bus = (await api().post('/api/transport').set(auth(A.admin))
    .send({ busNumber: 'UP16 1234', driverName: 'Ram', driverPhone: '9', routeName: 'North' })).body.data;
  await api().put(`/api/transport/${bus._id}/stops`).set(auth(A.admin))
    .send({ stops: [{ name: 'Gate 1', latitude: 28.6, longitude: 77.3 }, { name: 'School', latitude: 28.7, longitude: 77.4 }] });
});

test('driver trip lifecycle: start, readings, stop done, end; the driver token is never sent to viewers', async () => {
  const token = bus.driverToken;
  const early = await api().post(`/api/transport/driver/${token}/update-location`).send({ lat: 28.6, lng: 77.3 });
  expect(early.status).toBe(409);
  expect(early.body.code).toBe('TRIP_NOT_ACTIVE');

  await api().patch(`/api/transport/driver/${token}/start-trip`).expect(200);
  const read = await api().post(`/api/transport/driver/${token}/update-location`).send({ lat: 28.6, lng: 77.3 }).expect(200);
  expect(read.body.data.accepted).toBe(1);
  const stop = await api().patch(`/api/transport/driver/${token}/stop-done`).expect(200);
  expect(stop.body.data.currentStopIndex).toBe(1);
  await api().patch(`/api/transport/driver/${token}/end-trip`).expect(200);
  const after = await api().post(`/api/transport/driver/${token}/location`).send({ points: [{ lat: 28.6, lng: 77.3 }] });
  expect(after.status).toBe(409);
});

test('invalid coordinates and unknown driver codes are rejected', async () => {
  await api().patch(`/api/transport/driver/${bus.driverToken}/start-trip`).expect(200);
  await api().post(`/api/transport/driver/${bus.driverToken}/update-location`).send({ lat: 500, lng: 0 }).expect(400);
  await api().get('/api/transport/driver/WRONG-CODE').expect(404);
});

test('driver view does not expose the driver token back', async () => {
  const res = await api().get(`/api/transport/driver/${bus.driverToken}`).expect(200);
  expect(res.body.data.driverToken).toBeUndefined();
  expect(res.body.data.busId).toBe(bus._id);
  expect(res.body.data.route).toBeUndefined();
});

describe('changing a bus\'s capacity', () => {
  test('keeps the free seats in step, and refuses fewer seats than students already assigned', async () => {
    const A = await seedSchool('Capacity School');
    const bus = await Transport.create({
      school: A.school._id, busNumber: 'CAP-1', driverName: 'Ravi', driverPhone: '9000000000', routeName: 'North',
      driverToken: 'CAP-TOKEN-0001', capacity: 40, availableSeats: 39, assignedStudents: [A.student._id],
    });
    const up = await api().put(`/api/transport/${bus._id}`).set(auth(A.admin)).send({ capacity: 30 });
    expect(up.status).toBe(200);
    expect(up.body.data.capacity).toBe(30);
    expect(up.body.data.availableSeats).toBe(29);
    const tooSmall = await api().put(`/api/transport/${bus._id}`).set(auth(A.admin)).send({ capacity: 0 });
    expect(tooSmall.status).toBe(400);
    const stale = await Transport.findById(bus._id);
    expect(stale.capacity).toBe(30);
  });
});
