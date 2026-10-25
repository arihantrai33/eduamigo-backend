/* eslint-disable no-console */
// Removes the records one load-test run created, and only those: it reads results/<run>/created.json (the ids the k6 script printed as it
// created them) and deletes exactly those ids. Nothing is deleted unless you pass --confirm, and it refuses any database whose name does not
// end in _loadtest or _staging.
//
//   MONGO_URI="mongodb://127.0.0.1:27017/mytest_loadtest" node loadtests/cleanup.js --run A-20261025T1021            (shows what it would delete)
//   MONGO_URI=...                                           node loadtests/cleanup.js --run A-20261025T1021 --confirm
//
// The staged runner (stage.js) uses a throwaway in-memory database that disappears when the run ends, so there is nothing to clean up after
// a normal run. This command is for runs against a persistent local test database.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };
const ALLOWED = new Set(['homeworks', 'announcements']);   // the only kinds of record the load test creates

async function main() {
  const run = arg('run');
  if (!run || !/^[A-Z]-\d{8}T\d{4}$/.test(run)) throw new Error('Give the run name, for example --run A-20261025T1021');
  const file = path.join(__dirname, 'results', run, 'created.json');
  if (!fs.existsSync(file)) throw new Error(`No record list for ${run}: ${file}`);
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const dbName = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://')).pathname.replace('/', '').split('?')[0];
  if (!/_(loadtest|staging)$/.test(dbName)) throw new Error(`Refusing database "${dbName}": its name must end in _loadtest or _staging`);
  if (dbName !== list.database) throw new Error(`This run was recorded in database "${list.database}", not "${dbName}"`);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  let removed = 0;
  for (const { collection, id } of list.items) {
    if (!ALLOWED.has(collection) || !mongoose.isValidObjectId(id)) { console.log(`skipped ${collection} ${id} (not something the load test creates)`); continue; }
    const _id = new mongoose.Types.ObjectId(id);
    const doc = await db.collection(collection).findOne({ _id }, { projection: { title: 1 } });
    if (!doc) { console.log(`gone    ${collection} ${id}`); continue; }
    if (!String(doc.title || '').startsWith(`LOADTEST ${run}`)) { console.log(`skipped ${collection} ${id} (its title is not marked LOADTEST ${run})`); continue; }
    if (process.argv.includes('--confirm')) { await db.collection(collection).deleteOne({ _id }); removed += 1; console.log(`deleted ${collection} ${id}`); }
    else console.log(`would delete ${collection} ${id}  "${doc.title}"`);
  }
  console.log(process.argv.includes('--confirm') ? `${removed} records deleted.` : 'Nothing deleted. Add --confirm to delete the records listed above.');
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
