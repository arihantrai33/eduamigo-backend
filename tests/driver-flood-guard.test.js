// A flood of guessed driver codes from one address is stopped by a high ceiling per address (the codes themselves are 80-bit random, so
// guessing is hopeless anyway; this only keeps the server from being kept busy). Normal driver traffic is nowhere near it.
process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.API_ANON_PER_MINUTE = '1000';
process.env.DRIVER_IP_PER_MINUTE = '60';

const { api, connect, disconnect, clear } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

test('different guessed driver codes from one address are refused after the ceiling', async () => {
  const statuses = [];
  for (let i = 0; i < 75; i += 1) statuses.push((await api().get(`/api/transport/driver/GUESS-${String(i).padStart(20, '0')}`)).status);
  expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true); // an unknown code is answered
  expect(statuses.slice(60).every((s) => s === 429)).toBe(true);
});
