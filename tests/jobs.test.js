const { connect, disconnect, clear, seedSchool, api, auth } = require('./helpers');
const Fee = require('../src/models/Fee');
const Notification = require('../src/models/Notification');
const { sendFeeReminders } = require('../src/jobs/feeReminder');
const Message = require('../src/models/Message');
const Conversation = require('../src/models/Conversation');

let A;
let B;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  B = await seedSchool('Beta School');
});

const NOW = new Date('2026-10-01T04:00:00Z'); // 09:30 IST
const day = (s) => new Date(`${s}T00:00:00Z`);

describe('fee reminder job', () => {
  test('reminds only the parents of that student, inside the right school, 7 and 2 days ahead', async () => {
    await Fee.create([
      { school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 5000, paidAmount: 0, status: 'Unpaid', dueDate: day('2026-10-08') },
      { school: A.school._id, studentId: A.student._id, feeType: 'Transport', amount: 1000, paidAmount: 400, status: 'Partial', dueDate: day('2026-10-03') },
      { school: A.school._id, studentId: A.student._id, feeType: 'Lab', amount: 500, paidAmount: 500, status: 'Paid', dueDate: day('2026-10-08') },
      { school: A.school._id, studentId: A.student._id, feeType: 'Sports', amount: 300, status: 'Unpaid', dueDate: day('2026-10-05') },
    ]);
    const sent = await sendFeeReminders(NOW);
    expect(sent).toBe(2);

    const notes = await Notification.find({}).sort({ title: 1 });
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => String(n.school) === String(A.school._id))).toBe(true);
    expect(notes.every((n) => String(n.recipient) === String(A.parentUser._id))).toBe(true);
    expect(notes.map((n) => n.title)).toEqual(['Fee due in 2 days', 'Fee due in 7 days']);
    expect(notes.find((n) => n.title === 'Fee due in 2 days').message).toContain('Rs 600');

    // The parent sees them; another school's parent does not.
    const mine = await api().get('/api/notifications/my').set(auth(A.parentUser));
    expect(mine.body.data.length).toBe(2);
    const other = await api().get('/api/notifications/my').set(auth(B.parentUser));
    expect(other.body.data.length).toBe(0);
  });
});

describe('chat inbox is school scoped', () => {
  test('a conversation row from another school never leaks into the inbox preview', async () => {
    // Forge a conversation in school B that reuses a room id the admin of A would compute.
    const contacts = await api().get('/api/chat/admin-contacts').set(auth(A.admin));
    expect(contacts.status).toBe(200);
    const roomId = contacts.body.data[0].roomId;
    await Conversation.create({ school: B.school._id, roomId, participants: [], lastText: 'secret from B', lastAt: new Date() });
    await Message.create({ school: B.school._id, roomId, senderId: B.admin._id, receiverId: A.admin._id, text: 'secret from B' });
    const again = await api().get('/api/chat/admin-contacts').set(auth(A.admin));
    const row = again.body.data.find((c) => c.roomId === roomId);
    expect(row.lastMsg).not.toBe('secret from B');
    expect(row.unread).toBe(0);
  });
});

describe('fee reminders are sent once', () => {
  const fees = () => Fee.create([
    { school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 5000, paidAmount: 0, status: 'Unpaid', dueDate: day('2026-10-08') },
    { school: A.school._id, studentId: A.student._id, feeType: 'Transport', amount: 1000, paidAmount: 400, status: 'Partial', dueDate: day('2026-10-03') },
  ]);

  test('running the job again the same day sends nothing new', async () => {
    await fees();
    expect(await sendFeeReminders(NOW)).toBe(2);
    expect(await sendFeeReminders(NOW)).toBe(0);
    expect(await Notification.countDocuments({})).toBe(2);
  });

  test('two instances running at the same moment send each reminder once', async () => {
    await fees();
    const [a, b] = await Promise.all([sendFeeReminders(NOW), sendFeeReminders(NOW)]);
    expect(a + b).toBe(2);
    expect(await Notification.countDocuments({})).toBe(2);
  });

  test('a changed due date is a new reminder', async () => {
    const [tuition] = await fees();
    await sendFeeReminders(NOW);
    await Fee.updateOne({ _id: tuition._id }, { dueDate: day('2026-10-03') }); // now due in 2 days
    expect(await sendFeeReminders(NOW)).toBe(1);
  });

  test('if sending fails, the reminder is released for the next run', async () => {
    await fees();
    const spy = jest.spyOn(Notification, 'create').mockRejectedValueOnce(new Error('push service down'));
    await expect(sendFeeReminders(NOW)).rejects.toThrow('push service down');
    spy.mockRestore();
    expect(await sendFeeReminders(NOW)).toBe(2);
  });
});
