/* eslint-disable no-console */
// Adds ONE fictional demo school, named for a school that is being shown EduAmigo, to a hosted demo/staging database.
// It only ADDS: it never deletes, resets or edits any existing school, user or record.
//
//   MONGO_URI="mongodb+srv://.../eduamigo_staging" DEMO_PASSWORD="..." SEED_DEMO_OK=yes \
//     node src/scripts/addProspectDemo.js --name "Example Public School" --code EXPS --city Patna [--color "#0A7E8C"] [--accent "#F2B705"] [--logo-url https://...] [--principal "Dr. Example Name"]
//
// Rules:
//   * The database name must end in _staging or _demo. The production database ("eduamigo") is refused.
//   * The school code must be new (letters/digits, 3-12 characters) and must not belong to an existing school.
//   * Every person, phone number and number in it is invented. The school name and colours are only what you pass in. Pass --logo-url only
//     if the school has authorised its logo for the demo; there is no logo by default. The tagline says "Demo with sample data".
//   * DEMO_PASSWORD (12+ characters) is the password of the NEW accounts only; it is never printed.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const mongoose = require('mongoose');

const arg = (argv, name) => { const i = argv.indexOf(`--${name}`); return i > -1 ? argv[i + 1] : undefined; };

function parse(argv, env) {
  const uri = env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const dbName = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://')).pathname.replace('/', '').split('?')[0];
  if (!/_(staging|demo)$/.test(dbName)) throw new Error(`Refusing database "${dbName}": its name must end in _staging or _demo`);
  if (env.SEED_DEMO_OK !== 'yes') throw new Error('Set SEED_DEMO_OK=yes to confirm this is a staging/demo database');
  if (!env.DEMO_PASSWORD || env.DEMO_PASSWORD.length < 12) throw new Error('Set DEMO_PASSWORD (at least 12 characters)');
  const name = (arg(argv, 'name') || '').trim();
  const code = (arg(argv, 'code') || '').trim().toUpperCase();
  if (name.length < 3 || name.length > 80) throw new Error('--name must be 3 to 80 characters');
  if (!/^[A-Z0-9]{3,12}$/.test(code)) throw new Error('--code must be 3 to 12 letters or digits');
  const color = arg(argv, 'color') || '#0A7E8C';
  const accent = arg(argv, 'accent') || '';
  if (!/^#[0-9a-fA-F]{6}$/.test(color) || (accent && !/^#[0-9a-fA-F]{6}$/.test(accent))) throw new Error('Colours must look like #0A7E8C');
  const logoUrl = arg(argv, 'logo-url') || '';
  if (logoUrl && !/^https:\/\//.test(logoUrl)) throw new Error('--logo-url must be an https address');
  return { uri, dbName, name, code, city: arg(argv, 'city') || 'Patna', color, accent, logoUrl, principal: arg(argv, 'principal') || 'Dr. Sample Principal' };
}

// Invented phone numbers that are different for each prospect school (so a parent login is unique to this school).
function fakePhones(code) {
  const n = parseInt(crypto.createHash('sha1').update(code).digest('hex').slice(0, 7), 16) % 10000000;
  return [0, 1, 2].map((i) => `91${String(n).padStart(7, '0')}${i}`.slice(0, 10));
}

function prospectOf(o) {
  const [p1, p2] = fakePhones(o.code);
  return {
    name: o.name, code: o.code, city: o.city, plan: 'premium', color: o.color, accent: o.accent, logoUrl: o.logoUrl,
    appName: o.name, tagline: 'Demo with sample data', heroStyle: 'bold', principal: o.principal,
    subscription: { status: 'active', currentPeriodEnd: null },
    classes: ['6', '7'], teacher: 'Sample Teacher',
    stops: ['School Gate', 'Main Road', 'Market Chowk', 'Park Colony'],
    students: [
      { name: 'Aarav Sample', parentName: 'Sample Parent One', parentPhone: p1, gender: 'Male' },
      { name: 'Diya Sample', parentName: 'Sample Parent One', parentPhone: p1, gender: 'Female' },  // sibling: one parent login, two children
      { name: 'Kabir Example', parentName: 'Example Parent Two', parentPhone: p2, gender: 'Male' },
    ],
  };
}

async function main() {
  const o = parse(process.argv, process.env);
  await mongoose.connect(o.uri, { serverSelectionTimeoutMS: 20000 });
  if (mongoose.connection.db.databaseName !== o.dbName) throw new Error('Connected to a different database than the one named: stopping');
  const School = require('../models/School');
  const User = require('../models/User');
  if (await mongoose.connection.db.collection('schools').findOne({ code: o.code })) throw new Error(`A school with code ${o.code} already exists: nothing was changed`);
  const before = await mongoose.connection.db.collection('schools').countDocuments({});
  process.env.NODE_ENV = process.env.NODE_ENV || 'production';
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const { seed } = require('./demo');
  const rows = await seed({ prospect: prospectOf(o) });
  const after = await mongoose.connection.db.collection('schools').countDocuments({});
  if (after !== before + 1) throw new Error(`Expected exactly one new school but the count went from ${before} to ${after}`);
  console.log(`Added "${o.name}" (code ${o.code}) to ${o.dbName}. ${before} existing school(s) were not touched.`);
  console.table(rows.map((r) => ({ role: r.role, loginId: r.loginId })));
  void School; void User;
  await mongoose.disconnect();
}

module.exports = { parse, prospectOf, fakePhones };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
