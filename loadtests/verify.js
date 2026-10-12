// Run after a load test, against the same throwaway database: checks that the data is still consistent.
//   MONGO_URI=".../eduamigo_loadtest" node loadtests/verify.js
// Exits with a non-zero code if anything is wrong. Read-only.
require('dotenv').config({ quiet: true });
const path = require('path');
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const dbName = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://')).pathname.replace('/', '').split('?')[0];
  if (!/_(loadtest|staging)$/.test(dbName)) throw new Error(`Refusing to read database "${dbName}": its name must end in _loadtest or _staging`);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const problems = [];
  const note = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`); if (!ok) problems.push(label); };

  const dupReceipts = await db.collection('fees').aggregate([
    { $unwind: '$payments' }, { $group: { _id: { s: '$school', r: '$payments.receiptNo' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: 'n' },
  ]).toArray();
  note(!dupReceipts.length, 'no receipt number is used twice in a school', dupReceipts.length ? `${dupReceipts[0].n} duplicates` : '');

  const fees = await db.collection('fees').find({ 'payments.0': { $exists: true } }, { projection: { amount: 1, paidAmount: 1, status: 1, payments: 1 } }).toArray();
  const bad = fees.filter((f) => {
    const sum = Math.round(f.payments.reduce((t, p) => t + p.amount, 0) * 100) / 100;
    const status = sum >= f.amount ? 'Paid' : sum > 0 ? 'Partial' : 'Unpaid';
    return sum !== f.paidAmount || sum > f.amount || f.status !== status;
  });
  note(!bad.length, 'every fee: paid amount equals its payments, never above the fee, status matches', `${fees.length} fees with payments, ${bad.length} wrong`);

  const dupAttendance = await db.collection('attendances').aggregate([
    { $group: { _id: { s: '$studentId', d: '$date' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: 'n' },
  ]).toArray();
  note(!dupAttendance.length, 'one attendance row per student per day', dupAttendance.length ? `${dupAttendance[0].n} duplicates` : '');

  const dupNotices = await db.collection('notifications').aggregate([
    { $match: { type: 'Attendance' } },
    { $group: { _id: { r: '$recipient', t: '$title', m: '$message' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: 'n' },
  ]).toArray();
  note(!dupNotices.length, 'no parent got the same attendance message twice', dupNotices.length ? `${dupNotices[0].n} repeated` : '');

  const rolls = await db.collection('students').aggregate([
    { $match: { isActive: true } }, { $group: { _id: { s: '$school', c: '$class', sec: '$section', r: '$rollNumber' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $count: 'n' },
  ]).toArray();
  note(!rolls.length, 'no two active students share a roll number in a class', rolls.length ? `${rolls[0].n} clashes` : '');

  const orphans = await db.collection('users').aggregate([
    { $match: { role: 'student' } }, { $lookup: { from: 'students', localField: '_id', foreignField: 'userId', as: 's' } }, { $match: { s: { $size: 0 } } }, { $count: 'n' },
  ]).toArray();
  note(!orphans.length, 'no student login without a student record', orphans.length ? `${orphans[0].n} orphans` : '');

  await mongoose.disconnect();
  console.log(problems.length ? `\n${problems.length} check(s) failed` : '\nAll checks passed');
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
