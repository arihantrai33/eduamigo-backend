/* eslint-disable no-console */
// Full database backup to local JSON files (Extended JSON keeps ObjectIds and dates exact).
// Works on every Atlas tier, including the free M0 cluster that has no snapshots.
//
//   node src/scripts/backup.js                      -> writes backups/<timestamp>/<collection>.json
//   node src/scripts/backup.js --restore <folder>   -> lists what would be restored (no writes)
//   node src/scripts/backup.js --restore <folder> --confirm
//                                                   -> REPLACES each collection with the backup copy

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { EJSON } = mongoose.mongo.BSON;
const ROOT = path.join(__dirname, '..', '..', 'backups');

async function backup(db, dir = path.join(ROOT, new Date().toISOString().replace(/[:.]/g, '-'))) {
  fs.mkdirSync(dir, { recursive: true });
  const summary = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const docs = await db.collection(name).find({}).toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), EJSON.stringify(docs, { relaxed: false }));
    summary[name] = docs.length;
  }
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), database: db.databaseName, collections: summary }, null, 2));
  return { dir, summary };
}

async function restore(db, dir, { confirm = false } = {}) {
  if (!fs.existsSync(path.join(dir, '_manifest.json'))) throw new Error(`Not a backup folder: ${dir}`);
  const summary = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
    const name = file.slice(0, -5);
    const docs = EJSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'), { relaxed: false });
    summary[name] = docs.length;
    if (!confirm) continue;
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
  }
  return summary;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);
  const { db } = mongoose.connection;
  const i = process.argv.indexOf('--restore');
  if (i > -1) {
    const dir = path.resolve(process.argv[i + 1] || '');
    const confirm = process.argv.includes('--confirm');
    const summary = await restore(db, dir, { confirm });
    console.table(Object.entries(summary).map(([collection, documents]) => ({ collection, documents })));
    console.log(confirm ? `Restored from ${dir}.` : 'Nothing written. Add --confirm to replace these collections with the backup.');
  } else {
    const { dir, summary } = await backup(db);
    console.table(Object.entries(summary).map(([collection, documents]) => ({ collection, documents })));
    console.log(`Backup saved to ${dir}`);
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Backup failed:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  });
}

module.exports = { backup, restore };
