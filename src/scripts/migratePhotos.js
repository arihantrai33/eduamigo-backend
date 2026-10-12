// Moves existing student photos from public Cloudinary addresses to private, school-scoped assets.
//
//   node src/scripts/migratePhotos.js                    dry run: counts only, changes nothing
//   node src/scripts/migratePhotos.js --apply            stage A: copies each photo to a private asset and sets Student.photoKey
//   node src/scripts/migratePhotos.js --finalize --apply stage B: deletes the old public file and clears Student.photo
//
// Stage A is safe to repeat and easy to undo: the old public file and Student.photo are untouched, so undoing it is
//   db.students.updateMany({ photoKey: { $exists: true } }, { $unset: { photoKey: 1 } })
// (the private copies can then be deleted from Cloudinary under eduamigo/<school>/students/).
// Stage B is NOT reversible: run it only after stage A has been checked in the app (photos show, links open).
// Photos whose address is not one of our Cloudinary student_photos files are only reported, never touched.
// Students are updated one at a time with their school in the filter; a failure on one student does not stop the others.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const Student = require('../models/Student');
const cloudinary = require('../config/cloudinary');
const photos = require('../services/photos');

// https://res.cloudinary.com/<cloud>/image/upload/v123/student_photos/abc123.jpg -> student_photos/abc123
const LEGACY = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:v\d+\/)?(student_photos\/[A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/;
const legacyPublicId = (url) => (String(url || '').match(LEGACY) || [])[1] || null;

async function migratePhotos({ apply = false, finalize = false, quiet = false } = {}) {
  const report = { students_with_photo: 0, already_private: 0, to_copy: 0, copied: 0, copy_failed: 0, foreign_address: 0, to_finalize: 0, finalized: 0, finalize_failed: 0 };
  const log = (...a) => { if (!quiet) console.log(...a); };

  // Raw collection read: nothing here is a tenant request, and each write below carries the student's school.
  const cursor = Student.collection.find({ $or: [{ photo: { $type: 'string', $ne: '' } }, { photoKey: { $type: 'string' } }] }, { projection: { school: 1, photo: 1, photoKey: 1 } });
  for await (const s of cursor) {
    report.students_with_photo += 1;
    const publicId = legacyPublicId(s.photo);

    if (finalize) {
      if (!s.photoKey || !s.photo) continue;
      report.to_finalize += 1;
      if (!apply) continue;
      try {
        await cloudinary.api.resource(s.photoKey, { type: 'authenticated', resource_type: 'image' }); // the private copy must exist
        if (publicId) await cloudinary.uploader.destroy(publicId, { type: 'upload', resource_type: 'image', invalidate: true });
        await Student.collection.updateOne({ _id: s._id, school: s.school }, { $unset: { photo: 1 } });
        report.finalized += 1;
      } catch (err) {
        report.finalize_failed += 1;
        log(`finalize failed for student ${s._id}: ${String(err.message).slice(0, 120)}`);
      }
      continue;
    }

    if (s.photoKey) { report.already_private += 1; continue; }
    if (!publicId) { report.foreign_address += 1; continue; }
    report.to_copy += 1;
    if (!apply) continue;
    const key = photos.newKey(s.school);
    try {
      await cloudinary.uploader.upload(s.photo, { public_id: key, type: 'authenticated', resource_type: 'image', overwrite: false });
      await Student.collection.updateOne({ _id: s._id, school: s.school, photoKey: { $exists: false } }, { $set: { photoKey: key } });
      report.copied += 1;
    } catch (err) {
      report.copy_failed += 1;
      await photos.removePhoto(key); // do not leave a half-finished copy behind
      log(`copy failed for student ${s._id}: ${String(err.message).slice(0, 120)}`);
    }
  }
  if (!quiet) console.table(Object.entries(report).map(([step, count]) => ({ step, count })));
  return report;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);
  const apply = process.argv.includes('--apply');
  const finalize = process.argv.includes('--finalize');
  if (!apply) console.log('Dry run: nothing is changed. Add --apply to do it.');
  if (finalize && apply) console.log('FINALIZE: deleting the old public files. This cannot be undone.');
  await migratePhotos({ apply, finalize });
  await mongoose.disconnect();
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });

module.exports = { migratePhotos, legacyPublicId };
