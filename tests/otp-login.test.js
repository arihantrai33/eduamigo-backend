// Signing in with a one-time code (by email or SMS) instead of a password, and resetting a password by code.
const { api, connect, disconnect, clear, seedSchool } = require('./helpers');
const School = require('../src/models/School');
const User = require('../src/models/User');
const email = require('../src/services/email');
const smsService = require('../src/services/sms');

let A; let sendSpy; let logSpy;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  await School.updateOne({ _id: A.school._id }, { code: 'ALP' });
  const parent = await User.findById(A.parentUser._id);
  parent.phone = '9876543210';
  await parent.save(); // saving keeps the mobile sign-in field in step
  sendSpy = jest.spyOn(email, 'sendEmail').mockResolvedValue({});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const codeFromEmail = (i = 0) => sendSpy.mock.calls[i][0].text.match(/: (\d{6})/)[1];
const request = (body) => api().post('/api/users/otp/request').send(body);
const verify = (body) => api().post('/api/users/otp/verify').send(body);

describe('sign in with a code', () => {
  test('a code sent by email signs the person in, once', async () => {
    const res = await request({ schoolCode: 'ALP', identifier: A.admin.email });
    expect(res.status).toBe(200);
    expect(sendSpy.mock.calls[0][0].to).toBe(A.admin.email);
    const code = codeFromEmail();
    const ok = await verify({ schoolCode: 'ALP', identifier: A.admin.email, code });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.user || ok.body.data || ok.body).toBeTruthy();
    expect((await verify({ schoolCode: 'ALP', identifier: A.admin.email, code })).status).toBe(401); // single use
  });

  test('every answer is the same whether or not the account exists, and an unknown account is sent nothing', async () => {
    const real = await request({ schoolCode: 'ALP', identifier: A.admin.email });
    const fake = await request({ schoolCode: 'ALP', identifier: 'nobody@nowhere.test' });
    expect(fake.status).toBe(real.status);
    expect(fake.body.message).toBe(real.body.message);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  test('wrong codes: after five tries the code stops working; a new one is not sent again within a minute', async () => {
    await request({ schoolCode: 'ALP', identifier: A.admin.email });
    const code = codeFromEmail();
    for (let i = 0; i < 5; i += 1) expect((await verify({ schoolCode: 'ALP', identifier: A.admin.email, code: '000000' })).status).toBe(401);
    expect((await verify({ schoolCode: 'ALP', identifier: A.admin.email, code })).status).toBe(401);
    await request({ schoolCode: 'ALP', identifier: A.admin.email });
    expect(sendSpy).toHaveBeenCalledTimes(2);                                   // the spent code is gone: a fresh one is sent
    await request({ schoolCode: 'ALP', identifier: A.admin.email });
    expect(sendSpy).toHaveBeenCalledTimes(2);                                   // but not again within a minute
  });

  test('a mobile number with SMS in test mode: the email on file gets it, and with no email the code is shown in the server console only', async () => {
    await User.updateOne({ _id: A.parentUser._id }, { $unset: { email: 1 } });
    await request({ schoolCode: 'ALP', identifier: '9876543210' });
    expect(sendSpy).not.toHaveBeenCalled();
    const shown = logSpy.mock.calls.map((c) => String(c[0])).find((l) => /one-time code/.test(l));
    expect(shown).toMatch(/login/);
    const code = shown.match(/(\d{6})$/)[1];
    const ok = await verify({ schoolCode: 'ALP', identifier: '9876543210', code });
    expect(ok.status).toBe(200);
  });

  test('a live SMS provider is used first for a mobile number', async () => {
    const live = jest.spyOn(smsService, 'loadSms').mockResolvedValue({ config: { provider: 'msg91', mode: 'production' }, enabled: true, secrets: {}, status: {}, save: async () => {} });
    jest.spyOn(smsService, 'goesLive').mockReturnValue(true);
    const send = jest.spyOn(smsService, 'sendCode').mockResolvedValue({ simulated: false });
    await request({ schoolCode: 'ALP', identifier: '9876543210' });
    expect(live).toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe('+919876543210');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('a temporary password no longer has to be changed after signing in with a code', async () => {
    await User.updateOne({ _id: A.admin._id }, { mustChangePassword: true });
    await request({ schoolCode: 'ALP', identifier: A.admin.email });
    const ok = await verify({ schoolCode: 'ALP', identifier: A.admin.email, code: codeFromEmail() });
    expect(ok.status).toBe(200);
    expect((await User.findById(A.admin._id)).mustChangePassword).toBe(false);
  });

  test('a school is needed for a mobile number, a bad code shape is refused, and an inactive account gets nothing', async () => {
    expect((await request({ identifier: '9876543210' })).status).toBe(400);
    expect((await verify({ schoolCode: 'ALP', identifier: A.admin.email, code: 'abc' })).status).toBe(400);
    await User.updateOne({ _id: A.admin._id }, { isActive: false });
    await request({ schoolCode: 'ALP', identifier: A.admin.email });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
