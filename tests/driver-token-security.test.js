// The driver token is a password in the URL path (the driver screen has no login). It must not reach the logs, and a token
// the school has replaced must stop working at once, not after the 20 seconds the server remembers a token for.

const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Transport = require('../src/models/Transport');
const tracking = require('../src/services/busTracking');
const { loggedPath } = require('../src/utils/logger');

let A;
let bus;
const TOKEN = 'DRIVERTOKEN-SECRET-0001';

beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  tracking.resetForTests();
  A = await seedSchool('Alpha School');
  bus = await Transport.create({
    school: A.school._id, busNumber: 'BR02 AB 1234', driverName: 'Ramesh', driverPhone: '9000011111', routeName: 'Gaya Route',
    driverToken: TOKEN, trackingId: 'trk-sec-1',
    stops: [0, 1].map((i) => ({ name: `Stop ${i + 1}`, latitude: 24.75, longitude: 84.99 + i * 0.006, order: i + 1 })),
  });
});

describe('driver token in the logs', () => {
  test.each([
    ['/api/transport/driver/TOKEN123/location', '/api/transport/driver/:token/location'],
    ['/api/transport/driver/TOKEN123/start-trip', '/api/transport/driver/:token/start-trip'],
    ['/api/transport/driver/TOKEN123', '/api/transport/driver/:token'],
    ['/api/transport/driver/TOKEN123?x=1', '/api/transport/driver/:token'],
  ])('%s is logged without the token', (url, expected) => {
    expect(loggedPath(url)).toBe(expected);
  });

  test('other paths are logged as they are', () => {
    expect(loggedPath('/api/transport/live/abc123')).toBe('/api/transport/live/abc123');
    expect(loggedPath('/api/photos/sometoken')).toBe('/api/photos/:token');
  });

  test('a request log line does not contain the token', async () => {
    process.env.LOG_IN_TESTS = 'true';
    const lines = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      await api().get(`/api/transport/driver/${TOKEN}`);
    } finally {
      spy.mockRestore();
      delete process.env.LOG_IN_TESTS;
    }
    const logged = lines.join('');
    expect(logged).toContain('"path":"/api/transport/driver/:token"');
    expect(logged).not.toContain(TOKEN);
  });
});

describe('replacing a driver token', () => {
  test('the old token stops working immediately, even when the server has just remembered it', async () => {
    const start = await api().patch(`/api/transport/driver/${TOKEN}/start-trip`).send({});
    expect(start.status).toBe(200);
    // A normal GPS reading fills the server's short memory of the token.
    const point = { lat: 24.75, lng: 84.99, accuracy: 8, at: Date.now() - 5000 };
    expect((await api().post(`/api/transport/driver/${TOKEN}/location`).send({ points: [point] })).status).toBe(200);

    const renewed = await api().post(`/api/transport/${bus._id}/regenerate-token`).set(auth(A.admin));
    expect(renewed.status).toBe(200);
    const next = renewed.body.data.driverToken;
    expect(next).not.toBe(TOKEN);

    const stale = await api().post(`/api/transport/driver/${TOKEN}/location`).send({ points: [{ ...point, at: Date.now() - 1000 }] });
    expect(stale.status).toBe(404);
    // The new token works.
    const fresh = await api().post(`/api/transport/driver/${next}/location`).send({ points: [{ ...point, at: Date.now() - 1000 }] });
    expect(fresh.status).toBe(200);
  });
});
