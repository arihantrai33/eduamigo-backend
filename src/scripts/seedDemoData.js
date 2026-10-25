/* eslint-disable no-console */
// Fills a hosted STAGING / DEMO database with the same demo schools as `npm run demo` (GVPS, SCS, LFS and the two Allied campuses), so a
// demo link can be shown to other people. It only ever runs against a database whose name ends in _staging or _demo, and it asks for
// the throwaway demo password explicitly.
//
//   MONGO_URI="mongodb+srv://.../eduamigo_staging" DEMO_PASSWORD="..." SEED_DEMO_OK=yes node src/scripts/seedDemoData.js [--replace-test-schools]
//
// --replace-test-schools drops the database first, but only if every school in it is a load-test school (code LT1, LT2, ...).
// The platform owner account that the demo creates is given a random password, so it cannot be used on a public demo.
require('dotenv').config({ quiet: true });
process.env.DEMO_PASSWORD = process.env.DEMO_PASSWORD || '';
const crypto = require('crypto');
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const dbName = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://')).pathname.replace('/', '').split('?')[0];
  if (!/_(staging|demo)$/.test(dbName)) throw new Error(`Refusing database "${dbName}": its name must end in _staging or _demo`);
  if (process.env.SEED_DEMO_OK !== 'yes') throw new Error('Set SEED_DEMO_OK=yes to confirm this is a staging/demo database');
  if (!process.env.DEMO_PASSWORD || process.env.DEMO_PASSWORD.length < 8) throw new Error('Set DEMO_PASSWORD (at least 8 characters)');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  if (process.argv.includes('--replace-test-schools')) {
    const codes = (await mongoose.connection.db.collection('schools').find({}, { projection: { code: 1 } }).toArray()).map((s) => s.code);
    if (codes.some((c) => !/^LT\d+$/.test(c))) throw new Error(`Not dropping: the database holds schools that are not load-test schools (${codes.join(', ')})`);
    await mongoose.connection.dropDatabase();
    console.log(`Dropped ${dbName} (it held only load-test schools: ${codes.join(', ') || 'none'}).`);
  } else if (await mongoose.connection.db.collection('schools').countDocuments({})) {
    throw new Error('The database already has schools. Use --replace-test-schools if they are only load-test schools.');
  }

  const { seed } = require('./demo'); // sets the demo's local-only environment, but starts nothing
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const rows = await seed();
  // The demo creates a platform owner; a public demo must not have an owner account with a known password.
  const User = require('../models/User');
  const { hashPassword } = require('../services/credentials');
  await User.updateOne({ email: 'owner@eduamigo.demo' }, { password: await hashPassword(crypto.randomBytes(24).toString('hex')) });
  console.log(`\nSeeded ${rows.length} demo accounts into ${dbName}. Platform owner password was randomised.`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
