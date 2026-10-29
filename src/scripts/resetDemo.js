/* eslint-disable no-console */
// Resets the HOSTED DEMO database to a fresh set of fictional schools. It can only ever touch a database made for this purpose:
//
//   MONGO_URI="mongodb+srv://.../eduamigo_demo" DEMO_PASSWORD="..." DEMO_RESET_OK=yes node src/scripts/resetDemo.js
//
// Safety rules (every one is checked before anything is deleted; any failure stops with a message):
//   1. The database name in MONGO_URI must end in "_demo". (The seed script for staging uses "_staging"; this one refuses it.)
//   2. DEMO_RESET_OK=yes must be set: the reset is always a deliberate act.
//   3. The MONGO_URI must not point at a host listed in DEMO_RESET_FORBIDDEN_HOSTS (default: the production cluster id "rmyiph4").
//   4. Every school already in the database must be one of this seed's fictional demo schools. A database that holds any other
//      school (real data, a load test, a customer) is never touched.
//   5. Only the collections of this one database are emptied, one at a time (the least-privilege database user needs only readWrite on it).
//   6. The platform owner account gets a random password, so a public demo has no owner login.
// DEMO_PASSWORD (at least 12 characters) becomes the password of every demo account; it is never printed.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const mongoose = require('mongoose');

const DEMO_CODES = ['GVPS', 'SCS', 'LFS', 'HHANORTH', 'HHASOUTH'];

function dbNameOf(uri) {
  return new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://')).pathname.replace('/', '').split('?')[0];
}

function checkSettings(env = process.env) {
  const uri = env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const dbName = dbNameOf(uri);
  if (!/_demo$/.test(dbName)) throw new Error(`Refusing database "${dbName}": its name must end in _demo`);
  if (env.DEMO_RESET_OK !== 'yes') throw new Error('Set DEMO_RESET_OK=yes to confirm this reset');
  const forbidden = (env.DEMO_RESET_FORBIDDEN_HOSTS || 'rmyiph4').split(',').map((s) => s.trim()).filter(Boolean);
  if (forbidden.some((h) => uri.includes(h))) throw new Error('Refusing: MONGO_URI points at a protected cluster');
  if (!env.DEMO_PASSWORD || env.DEMO_PASSWORD.length < 12) throw new Error('Set DEMO_PASSWORD (at least 12 characters)');
  return { uri, dbName };
}

async function main() {
  const { uri, dbName } = checkSettings();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  if (db.databaseName !== dbName) throw new Error(`Connected to "${db.databaseName}" instead of "${dbName}": stopping`);

  const existing = (await db.collection('schools').find({}, { projection: { code: 1 } }).toArray()).map((s) => s.code);
  const strangers = existing.filter((c) => !DEMO_CODES.includes(c));
  if (strangers.length) throw new Error(`Not resetting: the database holds schools that are not demo schools (${strangers.join(', ')})`);

  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  for (const name of collections) await db.collection(name).drop();
  console.log(`Emptied ${collections.length} collections in ${dbName} (it held ${existing.length} demo schools).`);

  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  const { seed } = require('./demo');
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const rows = await seed();
  const User = require('../models/User');
  const { hashPassword } = require('../services/credentials');
  await User.updateOne({ email: 'owner@eduamigo.demo' }, { password: await hashPassword(crypto.randomBytes(24).toString('hex')) });
  console.log(`Seeded ${rows.length} fictional demo accounts into ${dbName}. The platform owner password was randomised.`);
  await mongoose.disconnect();
}

module.exports = { checkSettings, dbNameOf, DEMO_CODES };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
