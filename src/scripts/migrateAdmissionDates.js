/* eslint-disable no-console */
// Adds the student "date of admission" field to existing data (see services/admissionDate.js).
//
//   npm run migrate:admission-dates             -> dry run: prints what would change, writes nothing
//   npm run migrate:admission-dates -- --apply  -> applies it
//
// Backward compatible: the field is optional and older code ignores it. Only students admitted through Admissions
// get a date (the day of the "Admitted" step); every other record is left as it is and shows "Not recorded" until
// the school enters the real date. Nothing is copied from createdAt. Take a backup before --apply.

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { backfillAdmissionDates } = require('../services/admissionDate');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);
  const report = await backfillAdmissionDates({ apply });
  console.log(apply ? 'Applied:' : 'Dry run (nothing written; add --apply to write):');
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
