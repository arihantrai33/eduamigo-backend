// A student's date of admission (Student.admittedOn). It is a real date the school records; when it is not known it
// stays null and documents say so. It is never taken from createdAt (when the record was made in EduAmigo).
const { HttpError } = require('../utils/http');
const { toDayKey } = require('../utils/dates');

// Checks a value sent by a form, an upload row or an API call.
//   undefined -> undefined (not being changed); '' or null -> null (clear it); 'YYYY-MM-DD' -> that calendar day.
// Not in the future (school calendar day), not before the date of birth.
function parseAdmittedOn(value, dateOfBirth) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) throw new HttpError(400, 'Date of admission must be a date (YYYY-MM-DD)');
  const day = toDayKey(text.slice(0, 10));
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text.slice(0, 10)) {
    throw new HttpError(400, 'Date of admission is not a valid date');
  }
  if (day > toDayKey()) throw new HttpError(400, 'Date of admission cannot be in the future');
  if (dateOfBirth) {
    const born = toDayKey(new Date(dateOfBirth));
    if (born && day < born) throw new HttpError(400, 'Date of admission cannot be before the date of birth');
  }
  return day;
}

// The day an Admissions application was admitted: the last "Admitted" step of its history (a real record made by
// the school when it admitted the student). null when the history has no such step with a date.
function admittedDayFromApplication(application) {
  const steps = (application?.history || []).filter((h) => h?.status === 'Admitted' && h.at);
  if (!steps.length) return null;
  return toDayKey(steps[steps.length - 1].at);
}

// Migration for the new field (src/scripts/migrateAdmissionDates.js). Existing records stay as they are, except one
// case where the real date is on record: a student created by admitting an Admissions application gets the day of
// that "Admitted" step. Students that already have a date are not touched; everyone else stays "not recorded".
// Dry run unless apply is true. Safe to run again. Raw collections: runs outside a request, across all schools.
async function backfillAdmissionDates({ apply = false } = {}) {
  const Admission = require('../models/Admission');
  const Student = require('../models/Student');
  const report = { applications: 0, set: 0, alreadyRecorded: 0, noAdmittedStep: 0, studentMissing: 0, otherSchool: 0, studentsWithoutDate: 0 };
  const cursor = Admission.collection.find({ status: 'Admitted', student: { $type: 'objectId' } }, { projection: { school: 1, student: 1, history: 1 } });
  for await (const app of cursor) {
    report.applications += 1;
    const day = admittedDayFromApplication(app);
    if (!day) { report.noAdmittedStep += 1; continue; }
    const student = await Student.collection.findOne({ _id: app.student }, { projection: { school: 1, admittedOn: 1 } });
    if (!student) { report.studentMissing += 1; continue; }
    if (String(student.school) !== String(app.school)) { report.otherSchool += 1; continue; }
    if (student.admittedOn) { report.alreadyRecorded += 1; continue; }
    report.set += 1;
    if (apply) await Student.collection.updateOne({ _id: student._id, admittedOn: { $in: [null, undefined] } }, { $set: { admittedOn: day } });
  }
  report.studentsWithoutDate = await Student.collection.countDocuments({ $or: [{ admittedOn: null }, { admittedOn: { $exists: false } }] });
  if (!apply) report.studentsWithoutDate -= report.set;
  return report;
}

module.exports = { parseAdmittedOn, admittedDayFromApplication, backfillAdmissionDates };
