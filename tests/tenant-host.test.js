// A school's own address. Two kinds, both resolved from registered records, never from what the visitor typed:
//   - a custom domain stored on the school (erp.greenvalley.edu.in)
//   - {school code}.{PLATFORM_BASE_DOMAIN} (alp.eduamigo.test), only when the platform owner sets that base domain
// The answer is the public sign-in profile and nothing else. It never grants anything: who the user is still comes from sign-in.
const { api, connect, disconnect, clear, seedSchool } = require('./helpers');
const School = require('../src/models/School');
const directory = require('../src/services/schoolDirectory');

let A;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  directory.clearDomainCache();
  process.env.PLATFORM_BASE_DOMAIN = 'eduamigo.test';
  A = await seedSchool('Alpha School'); // code ALP
});
afterAll(() => { delete process.env.PLATFORM_BASE_DOMAIN; });

const byHost = (host) => api().get('/api/public/schools/by-domain').query({ host });

describe('{code}.{base domain}', () => {
  test('a registered school code resolves to that school\'s public profile', async () => {
    const res = await byHost('alp.eduamigo.test');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ code: 'ALP', name: 'Alpha School' });
    expect(Object.keys(res.body.data)).not.toContain('_id');
  });

  test('case and a port do not matter', async () => {
    expect((await byHost('ALP.EduAmigo.Test:5173')).status).toBe(200);
  });

  test.each([
    ['an unknown code', 'nope.eduamigo.test'],
    ['the base domain itself', 'eduamigo.test'],
    ['two labels deep', 'x.alp.eduamigo.test'],
    ['a look-alike suffix', 'alp.eduamigo.test.evil.com'],
    ['a look-alike without the dot', 'alpeduamigo.test'],
    ['another base domain', 'alp.eduamigo.com'],
    ['a code that is too short', 'ab.eduamigo.test'],
    ['characters a code cannot have', 'a_p.eduamigo.test'],
  ])('%s is not a school', async (_name, host) => {
    expect((await byHost(host)).status).toBe(404);
  });

  test.each(['admin', 'www', 'api', 'app', 'console', 'platform', 'support'])('"%s" is reserved even if a school has that code', async (label) => {
    await School.create({ name: `Reserved ${label}`, code: label.toUpperCase() });
    expect((await byHost(`${label}.eduamigo.test`)).status).toBe(404);
  });

  test('a suspended school is not resolved', async () => {
    await School.updateOne({ _id: A.school._id }, { 'subscription.status': 'suspended' });
    expect((await byHost('alp.eduamigo.test')).status).toBe(404);
  });

  test('without a base domain configured this kind of address is not used at all', async () => {
    delete process.env.PLATFORM_BASE_DOMAIN;
    expect((await byHost('alp.eduamigo.test')).status).toBe(404);
  });
});

describe('custom domains still work', () => {
  test('a registered custom domain resolves; an unregistered one does not', async () => {
    await School.updateOne({ _id: A.school._id }, { customDomain: 'erp.alpha.example' });
    expect((await byHost('erp.alpha.example')).body.data.code).toBe('ALP');
    expect((await byHost('erp.beta.example')).status).toBe(404);
  });
});

describe('CORS for a school address', () => {
  test('https addresses of registered schools are allowed, nobody else\'s', async () => {
    expect(await directory.isSchoolDomainOrigin('https://alp.eduamigo.test')).toBe(true);
    expect(await directory.isSchoolDomainOrigin('http://alp.eduamigo.test')).toBe(false);
    expect(await directory.isSchoolDomainOrigin('https://nope.eduamigo.test')).toBe(false);
    expect(await directory.isSchoolDomainOrigin('https://admin.eduamigo.test')).toBe(false);
    expect(await directory.isSchoolDomainOrigin('https://alp.eduamigo.test.evil.com')).toBe(false);
  });
});
