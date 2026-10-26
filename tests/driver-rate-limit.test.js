// Driver phones have no sign-in, so the general limiter used to count them per network address. Buses that share one public address
// (mobile carriers, a bus depot's wifi) then shut each other out. They are now counted per driver code.
// Set before anything loads the limiters: they read these once, at startup.
process.env.ENABLE_RATE_LIMIT_IN_TESTS = 'true';
process.env.RATE_LIMIT_STORE = 'memory';
process.env.API_ANON_PER_MINUTE = '10';
process.env.DRIVER_IP_PER_MINUTE = '1000';

const { api, connect, disconnect, clear } = require('./helpers');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

const codes = ['BUS1-AAAAAAAAAAAAAAAAAAAA', 'BUS2-BBBBBBBBBBBBBBBBBBBB', 'BUS3-CCCCCCCCCCCCCCCCCCCC'];
const statusOf = (path) => api().get(path).then((r) => r.status);

describe('rate limits for driver phones', () => {
  test('several buses behind one address are not counted together', async () => {
    const statuses = [];
    for (let round = 0; round < 8; round += 1) for (const c of codes) statuses.push(await statusOf(`/api/transport/driver/${c}`)); // 24 requests from one address
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    expect(new Set(statuses)).toEqual(new Set([404])); // an unknown code is answered, not limited
  });

  test('one driver code that keeps sending is still limited', async () => {
    const statuses = [];
    for (let i = 0; i < 13; i += 1) statuses.push(await statusOf('/api/transport/driver/BUS9-DDDDDDDDDDDDDDDDDDDD'));
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  test('requests that are not driver requests are still counted per address', async () => {
    const statuses = [];
    for (let i = 0; i < 13; i += 1) statuses.push(await statusOf('/api/public/schools/NOSUCH'));
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
