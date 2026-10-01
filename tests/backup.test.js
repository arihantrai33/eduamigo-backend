const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { connect, disconnect, clear } = require('./helpers');
const { backup, restore } = require('../src/scripts/backup');

beforeAll(connect);
afterAll(disconnect);
beforeEach(clear);

test('backup and restore round-trip keeps ids and dates exact', async () => {
  const db = mongoose.connection.db;
  const _id = new mongoose.Types.ObjectId();
  const when = new Date('2026-09-01T00:00:00Z');
  await db.collection('students').insertOne({ _id, name: 'A', email: 'backup@x.com', joined: when });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));

  const { summary } = await backup(db, dir);
  expect(summary.students).toBe(1);

  await db.collection('students').updateOne({ _id }, { $set: { name: 'Changed' } });
  expect((await restore(db, dir)).students).toBe(1); // dry run
  expect((await db.collection('students').findOne({ _id })).name).toBe('Changed');

  await restore(db, dir, { confirm: true });
  const doc = await db.collection('students').findOne({ _id });
  expect(doc.name).toBe('A');
  expect(doc.joined.toISOString()).toBe(when.toISOString());
});
