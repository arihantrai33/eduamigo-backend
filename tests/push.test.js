const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const User = require('../src/models/User');
const push = require('../src/services/push');
const { notifyParents, broadcast } = require('../src/services/notify');

let A;
let B;
const sent = [];
const fake = {
  sendEachForMulticast: jest.fn(async (msg) => {
    sent.push(msg);
    return { successCount: msg.tokens.filter((t) => !t.startsWith('dead')).length, responses: msg.tokens.map((t) => (t.startsWith('dead') ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true })) };
  }),
};
const settle = () => new Promise((r) => setTimeout(r, 80));
const register = (user, token, platform = 'android') => api().patch('/api/users/fcm-token').set(auth(user)).send({ fcmToken: token, platform });
const devicesOf = async (user) => (await User.findById(user._id).lean()).devices.map((d) => d.token);

beforeAll(connect);
afterAll(async () => { push.setMessaging(undefined); await disconnect(); });
beforeEach(async () => {
  await clear();
  sent.length = 0;
  push.setMessaging(fake);
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

test('a parent notification is pushed to that parent\'s phones only', async () => {
  expect((await register(A.parentUser, 'tok-parent-phone')).status).toBe(200);
  await register(A.parentUser, 'tok-parent-tablet', 'ios');
  await register(B.parentUser, 'tok-other-school');
  await notifyParents(A.student, { title: 'Attendance: Absent', message: 'Aarav was marked Absent today.', type: 'Attendance' });
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0].tokens.sort()).toEqual(['tok-parent-phone', 'tok-parent-tablet']);
  expect(sent[0].notification).toEqual({ title: 'Attendance: Absent', body: 'Aarav was marked Absent today.' });
  expect(sent[0].data.type).toBe('Attendance');
});

test('a broadcast reaches only that role in that school', async () => {
  await register(A.parentUser, 'tok-a-parent');
  await register(A.teacherUser, 'tok-a-teacher');
  await register(B.parentUser, 'tok-b-parent');
  await broadcast(A.school._id, { title: 'Holiday', message: 'School closed tomorrow', targetRole: 'parent' });
  await settle();
  expect(sent.flatMap((m) => m.tokens)).toEqual(['tok-a-parent']);
});

test('a shared phone belongs to whoever signed in last on it', async () => {
  await register(A.parentUser, 'tok-shared');
  await register(A.studentUser, 'tok-shared');
  expect(await devicesOf(A.parentUser)).toEqual([]);
  expect(await devicesOf(A.studentUser)).toEqual(['tok-shared']);
});

test('signing out on a device stops its pushes', async () => {
  await register(A.parentUser, 'tok-1');
  await register(A.parentUser, 'tok-2');
  expect((await api().delete('/api/users/fcm-token').set(auth(A.parentUser)).send({ fcmToken: 'tok-1' })).status).toBe(200);
  expect(await devicesOf(A.parentUser)).toEqual(['tok-2']);
});

test('sign out everywhere silences every registered device', async () => {
  await register(A.parentUser, 'tok-before');
  await api().post('/api/users/logout-all').set(auth(A.parentUser)).expect(200);
  await notifyParents(A.student, { title: 't', message: 'm', type: 'General' });
  await settle();
  expect(sent).toHaveLength(0);
});

test('deactivated accounts get nothing; dead tokens are removed', async () => {
  await register(A.parentUser, 'dead-token');
  await register(A.parentUser, 'tok-ok');
  await notifyParents(A.student, { title: 't', message: 'm', type: 'General' });
  await settle();
  expect(await devicesOf(A.parentUser)).toEqual(['tok-ok']);
  await User.updateOne({ _id: A.parentUser._id }, { isActive: false });
  sent.length = 0;
  await notifyParents(A.student, { title: 't', message: 'm', type: 'General' });
  await settle();
  expect(sent).toHaveLength(0);
});

test('at most five devices are kept, newest first', async () => {
  for (let i = 1; i <= 7; i += 1) await register(A.parentUser, `tok-${i}`);
  expect(await devicesOf(A.parentUser)).toEqual(['tok-7', 'tok-6', 'tok-5', 'tok-4', 'tok-3']);
});

test('with no push service configured nothing is attempted and notifications still work', async () => {
  push.setMessaging(null);
  await register(A.parentUser, 'tok-x');
  const n = await notifyParents(A.student, { title: 't', message: 'm', type: 'General' });
  await settle();
  expect(n).toBe(1);
  expect(sent).toHaveLength(0);
});

test('a token is required, and a person cannot register a device for someone else', async () => {
  expect((await register(A.parentUser, '')).status).toBe(400);
  await register(A.parentUser, 'tok-mine');
  await register(B.parentUser, 'tok-theirs');
  // B removing A's token by guessing it only affects B's own list.
  await api().delete('/api/users/fcm-token').set(auth(B.parentUser)).send({ fcmToken: 'tok-mine' });
  expect(await devicesOf(A.parentUser)).toEqual(['tok-mine']);
});
