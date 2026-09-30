const updates = [];
jest.mock('../src/config/firebase', () => ({
  db: { ref: (path) => ({ update: async (data) => { updates.push({ path, data }); } }) },
}));

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');

let A;
let bus;

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  updates.length = 0;
  A = await seedSchool('Alpha School');
  bus = (await api().post('/api/transport').set(auth(A.admin))
    .send({ busNumber: 'UP16 1234', driverName: 'Ram', driverPhone: '9', routeName: 'North' })).body.data;
  await api().put(`/api/transport/${bus._id}/stops`).set(auth(A.admin))
    .send({ stops: [{ name: 'Gate 1', latitude: 28.6, longitude: 77.3 }, { name: 'School', latitude: 28.7, longitude: 77.4 }] });
});

test('driver trip lifecycle is published to the tracking path, never the driver token', async () => {
  const token = bus.driverToken;
  const early = await api().post(`/api/transport/driver/${token}/update-location`).send({ lat: 28.6, lng: 77.3 });
  expect(early.status).toBe(409);

  await api().patch(`/api/transport/driver/${token}/start-trip`).expect(200);
  await api().post(`/api/transport/driver/${token}/update-location`).send({ lat: 28.61, lng: 77.31 }).expect(200);
  const stop = await api().patch(`/api/transport/driver/${token}/stop-done`).expect(200);
  expect(stop.body.data.currentStopIndex).toBe(1);
  await api().patch(`/api/transport/driver/${token}/end-trip`).expect(200);

  expect(updates.map((u) => u.path)).toEqual(Array(4).fill(`transport/${bus.trackingId}`));
  expect(updates[1].data.location).toMatchObject({ lat: 28.61, lng: 77.31 });
  expect(updates[3].data).toMatchObject({ busStatus: 'Completed', location: null });
});

test('invalid coordinates and unknown driver codes are rejected', async () => {
  await api().patch(`/api/transport/driver/${bus.driverToken}/start-trip`).expect(200);
  await api().post(`/api/transport/driver/${bus.driverToken}/update-location`).send({ lat: 500, lng: 0 }).expect(400);
  await api().get('/api/transport/driver/WRONG-CODE').expect(404);
});

test('driver view does not expose the driver token back', async () => {
  const res = await api().get(`/api/transport/driver/${bus.driverToken}`).expect(200);
  expect(res.body.data.driverToken).toBeUndefined();
  expect(res.body.data.trackingId).toBe(bus.trackingId);
});
