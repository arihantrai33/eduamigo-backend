// The assistant must never know more than the person's real access. Custom roles and the staff account type do not widen what
// it answers (it fails closed), and no role it has not been taught about reads school-wide records through it.
process.env.ASSISTANT_AI = 'off';

const { api, connect, disconnect, clear, auth, seedSchool, makeUser } = require('./helpers');
const Fee = require('../src/models/Fee');
const User = require('../src/models/User');
const roles = require('../src/services/roles');

let A;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => {
  await clear();
  A = await seedSchool('Alpha School');
  await Fee.create({ school: A.school._id, studentId: A.student._id, feeType: 'Tuition Term 2', amount: 777777, paidAmount: 0, dueDate: new Date() });
});

const ask = (user, message) => api().post('/api/assistant/ask').set(auth(user)).send({ message });
const text = (res) => JSON.stringify(res.body);

async function withFeeRole(user) {
  const created = await roles.createRole(A.admin, A.school._id, { name: 'Cashier', templateKey: 'fee_collector' });
  await User.updateOne({ _id: user._id }, { $set: { extraRoles: [created._id] } });
}

describe('assistant access follows real access', () => {
  test('a school accountant gets school fee totals (baseline for the checks below)', async () => {
    const accountant = await makeUser(A.school, 'accountant');
    const res = await ask(accountant, 'Which fees are pending in the school?');
    expect(res.status).toBe(200);
    expect(text(res)).toMatch(/7,77,777/);
  });

  test('a staff account with a fee role does not receive school fee data through the assistant', async () => {
    const clerk = await makeUser(A.school, 'staff');
    await withFeeRole(clerk);
    const res = await ask(clerk, 'Which fees are pending in the school?');
    expect(text(res)).not.toMatch(/7,?77,?777/);
  });

  test('a teacher with a fee role does not receive school fee data through the assistant', async () => {
    await withFeeRole(A.teacherUser);
    const res = await ask(A.teacherUser, 'Which fees are pending in the school?');
    expect(text(res)).not.toMatch(/7,?77,?777/);
  });

  test('a staff account without any role gets nothing from school records either', async () => {
    const clerk = await makeUser(A.school, 'staff');
    const res = await ask(clerk, 'Which fees are pending in the school?');
    expect(text(res)).not.toMatch(/7,?77,?777/);
  });
});
