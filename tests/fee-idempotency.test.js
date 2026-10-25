// Recording a fee payment at the office: a retry of the same request (a slow network, a second click, two tabs) must not
// record the money twice. The screen sends one Idempotency-Key for one payment dialog.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const Fee = require('../src/models/Fee');
const Notification = require('../src/models/Notification');

let A;
let fee;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Fee School');
  fee = await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition', amount: 5000, dueDate: new Date(), academicYear: '2026-27' });
});

const pay = (body, key) => {
  const req = api().patch(`/api/fees/${fee._id}/pay`).set(auth(A.admin));
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
};
const stored = () => Fee.findById(fee._id);

describe('the same payment request sent again', () => {
  test('with the same key it is recorded once, and the answer is the same receipt', async () => {
    const first = await pay({ amount: 2000, mode: 'Cash' }, 'dialog-0001');
    const again = await pay({ amount: 2000, mode: 'Cash' }, 'dialog-0001');
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body.payment.receiptNo).toBe(first.body.payment.receiptNo);
    const f = await stored();
    expect(f.payments).toHaveLength(1);
    expect(f.paidAmount).toBe(2000);
  });

  test('parallel requests with one key are recorded once', async () => {
    const results = await Promise.all([1, 2, 3].map(() => pay({ amount: 1000, mode: 'UPI' }, 'dialog-0002')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const f = await stored();
    expect(f.payments).toHaveLength(1);
    expect(f.paidAmount).toBe(1000);
  });

  test('the parents are told once', async () => {
    await pay({ amount: 2000 }, 'dialog-0003');
    await pay({ amount: 2000 }, 'dialog-0003');
    const told = await Notification.countDocuments({ school: A.school._id, title: 'Fee payment received' });
    expect(told).toBe(1);
  });

  test('a different key is a different payment, and a request with no key behaves as before', async () => {
    await pay({ amount: 1000 }, 'dialog-0004');
    await pay({ amount: 1000 }, 'dialog-0005');
    await pay({ amount: 1000 });
    const f = await stored();
    expect(f.payments).toHaveLength(3);
    expect(f.paidAmount).toBe(3000);
  });

  test('a key that is not a short plain string is ignored, not trusted', async () => {
    await pay({ amount: 500 }, 'x'.repeat(200));
    await pay({ amount: 500 }, 'x'.repeat(200));
    expect((await stored()).payments).toHaveLength(2);
  });
});
