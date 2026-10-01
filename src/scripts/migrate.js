/* eslint-disable no-console */
// One-time, idempotent data migration for the multi-tenant hardening release.
//
//   node src/scripts/migrate.js            -> dry run: prints what would change, writes nothing
//   node src/scripts/migrate.js --apply    -> applies the changes
//   add --rotate-driver-tokens             -> also issues new (longer) driver codes for every bus
//
// ALWAYS take an Atlas backup/snapshot before running with --apply.

require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const mongoose = require('mongoose');

const User = require('../models/User');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Parent = require('../models/Parent');
const Fee = require('../models/Fee');
const FeeStructure = require('../models/FeeStructure');
const Attendance = require('../models/Attendance');
const ExamResult = require('../models/ExamResult');
const Mark = require('../models/Mark');
const Library = require('../models/Library');
const Note = require('../models/Note');
const NoteEmbedding = require('../models/NoteEmbedding');
const LeaveRequest = require('../models/LeaveRequest');
const Notification = require('../models/Notification');
const Announcement = require('../models/Announcement');
const Event = require('../models/Event');
const Salary = require('../models/Salary');
const StaffLeave = require('../models/StaffLeave');
const Message = require('../models/Message');
const Transport = require('../models/Transport');
const BulkUpload = require('../models/BulkUpload');
const Timetable = require('../models/Timetable');
const Conversation = require('../models/Conversation');
require('../models/School');
require('../models/ExamSchedule');

const { parseClassKey, classKey, normalizeClass, normalizeSection } = require('../utils/classes');
const { toDayKey } = require('../utils/dates');
const { feeStatusFor } = require('../services/feeService');

let APPLY = process.argv.includes('--apply');
let ROTATE = process.argv.includes('--rotate-driver-tokens');
let report = {};
const count = (key, n = 1) => { report[key] = (report[key] || 0) + n; };

// Raw collection access: legacy documents may not match the new schemas.
const col = (Model) => Model.collection;
const missingSchool = { $or: [{ school: { $exists: false } }, { school: null }] };

async function update(Model, id, set, label) {
  count(label);
  if (APPLY) await col(Model).updateOne({ _id: id }, { $set: set });
}
async function remove(Model, filter, label) {
  const n = await col(Model).countDocuments(filter);
  if (n) count(label, n);
  if (APPLY && n) await col(Model).deleteMany(filter);
}

async function userSchoolMap() {
  const users = await col(User).find({}, { projection: { school: 1, role: 1 } }).toArray();
  return new Map(users.map((u) => [String(u._id), u]));
}

async function migrate({ apply = APPLY, rotate = ROTATE, quiet = false } = {}) {
  APPLY = apply;
  ROTATE = rotate;
  report = {};

  const users = await userSchoolMap();
  const students = await col(Student).find({}, { projection: { school: 1, class: 1, section: 1 } }).toArray();
  const studentSchool = new Map(students.map((s) => [String(s._id), s.school]));
  const teachers = await col(Teacher).find({}, { projection: { school: 1 } }).toArray();
  const teacherSchool = new Map(teachers.map((t) => [String(t._id), t.school]));
  const schoolOfUser = (id) => (id ? users.get(String(id))?.school : null);

  // 1. Users: lowercase emails
  for (const u of await col(User).find({ email: /[A-Z]/ }).toArray()) {
    await update(User, u._id, { email: u.email.toLowerCase().trim() }, 'users.email_lowercased');
  }

  // 2. Canonical class/section on students and teachers
  for (const s of await col(Student).find({}).toArray()) {
    const cls = normalizeClass(s.class);
    const sec = normalizeSection(s.section);
    if (cls !== s.class || sec !== s.section) await update(Student, s._id, { class: cls, section: sec }, 'students.class_normalized');
  }
  for (const t of await col(Teacher).find({}).toArray()) {
    const keys = [...new Set((t.assignedClasses || []).map((k) => { const p = parseClassKey(k); return classKey(p.class, p.section); }).filter(Boolean))];
    const email = String(t.email || '').toLowerCase().trim();
    if (JSON.stringify(keys) !== JSON.stringify(t.assignedClasses || []) || email !== t.email) {
      await update(Teacher, t._id, { assignedClasses: keys, email }, 'teachers.classes_normalized');
    }
  }

  // 3. Backfill school on records linked to a student
  for (const [Model, field, label] of [[Fee, 'studentId', 'fees'], [Attendance, 'studentId', 'attendance'], [ExamResult, 'student', 'examResults'], [Mark, 'student', 'marks']]) {
    for (const doc of await col(Model).find(missingSchool, { projection: { [field]: 1 } }).toArray()) {
      const school = studentSchool.get(String(doc[field]));
      if (school) await update(Model, doc._id, { school }, `${label}.school_backfilled`);
      else count(`${label}.orphaned_no_student`);
    }
  }

  // 4. Backfill school from the user who created the record
  for (const [Model, field, label] of [
    [FeeStructure, 'createdBy', 'feeStructures'], [Library, 'addedBy', 'library'], [Note, 'uploadedBy', 'notes'],
    [LeaveRequest, 'requestedBy', 'leaves'], [Announcement, 'createdBy', 'announcements'], [Event, 'createdBy', 'events'],
    [Message, 'senderId', 'messages'], [BulkUpload, 'uploadedBy', 'bulkUploads'],
  ]) {
    for (const doc of await col(Model).find(missingSchool, { projection: { [field]: 1 } }).toArray()) {
      const school = schoolOfUser(doc[field]);
      if (school) await update(Model, doc._id, { school }, `${label}.school_backfilled`);
      else count(`${label}.orphaned_no_owner`);
    }
  }
  for (const [Model, label] of [[Salary, 'salaries'], [StaffLeave, 'staffLeaves']]) {
    for (const doc of await col(Model).find(missingSchool, { projection: { teacher: 1 } }).toArray()) {
      const school = teacherSchool.get(String(doc.teacher));
      if (school) await update(Model, doc._id, { school }, `${label}.school_backfilled`);
    }
  }

  // 5. Leave requests: old records stored the student's User id; link studentId/class for student leaves
  for (const l of await col(LeaveRequest).find({ role: 'student', studentId: { $exists: false } }).toArray()) {
    const s = await col(Student).findOne({ userId: l.requestedBy });
    if (s) await update(LeaveRequest, l._id, { studentId: s._id, class: s.class, section: s.section }, 'leaves.student_linked');
  }

  // 6. Notifications: legacy personal notifications lost their recipient and were visible to everyone.
  //    Keep admin broadcasts (attach school); delete the rest.
  for (const n of await col(Notification).find(missingSchool).toArray()) {
    const creator = n.createdBy ? users.get(String(n.createdBy)) : null;
    if (creator && creator.role === 'admin' && creator.school) {
      await update(Notification, n._id, { school: creator.school, recipient: null }, 'notifications.broadcast_kept');
    } else {
      count('notifications.legacy_deleted');
      if (APPLY) await col(Notification).deleteOne({ _id: n._id });
    }
  }

  // 7. Notes: canonical class/section; re-embed everything with the new pipeline
  for (const n of await col(Note).find({}).toArray()) {
    const key = parseClassKey(n.class, n.section);
    await update(Note, n._id, {
      class: key.class, section: key.section,
      processing: { status: n.type === 'Notes' || !n.type ? 'pending' : 'skipped', attempts: 0, chunks: 0, error: null, lockedUntil: null },
    }, 'notes.requeued_for_ai');
  }
  await remove(NoteEmbedding, {}, 'noteEmbeddings.cleared_for_reembedding');

  // 8. Attendance: one record per student per day
  const seen = new Map();
  const atts = await col(Attendance).find({}).sort({ updatedAt: -1 }).toArray();
  for (const a of atts) {
    const day = toDayKey(a.date);
    const key = `${a.studentId}_${day.toISOString()}`;
    if (seen.has(key)) {
      count('attendance.duplicates_removed');
      if (APPLY) await col(Attendance).deleteOne({ _id: a._id });
      continue;
    }
    seen.set(key, true);
    if (day.getTime() !== new Date(a.date).getTime()) await update(Attendance, a._id, { date: day }, 'attendance.date_normalized');
    if (a.status === undefined) count('attendance.missing_status');
  }

  // 9. Transport: tracking ids (and optionally new driver codes)
  for (const b of await col(Transport).find({}).toArray()) {
    const set = {};
    if (!b.trackingId) { set.trackingId = crypto.randomBytes(12).toString('hex'); set.firebaseKey = `transport/${set.trackingId}`; }
    if (ROTATE) set.driverToken = `${String(b.busNumber).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8)}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
    if (Object.keys(set).length) await update(Transport, b._id, set, ROTATE ? 'buses.tracking_and_driver_code' : 'buses.tracking_id_added');
  }

  // 10. Timetables: ensure school refs point to School (older docs may hold the admin User id)
  for (const t of await col(Timetable).find({}).toArray()) {
    const u = users.get(String(t.school));
    if (u && u.school) await update(Timetable, t._id, { school: u.school }, 'timetables.school_fixed');
  }

  // 10b. Chat inbox index: one Conversation per room with its latest message
  const seenRooms = new Set();
  const cursor = col(Message).find({}, { projection: { roomId: 1, school: 1, senderId: 1, receiverId: 1, text: 1, fileName: 1, createdAt: 1 } }).sort({ createdAt: -1 });
  for await (const m of cursor) {
    if (seenRooms.has(m.roomId)) continue;
    seenRooms.add(m.roomId);
    if (await col(Conversation).countDocuments({ roomId: m.roomId })) continue;
    const school = m.school || schoolOfUser(m.senderId);
    if (!school) continue;
    count('conversations.created');
    if (APPLY) {
      await col(Conversation).insertOne({
        roomId: m.roomId, school, participants: [m.senderId, m.receiverId],
        lastText: m.text || (m.fileName ? `Attachment: ${m.fileName}` : ''), lastAt: m.createdAt, lastSender: m.senderId,
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
  }

  // 10c. Student fee status is derived from fee records (it used to be typed in by hand)
  const feesByStudent = new Map();
  for (const f of await col(Fee).find({}, { projection: { studentId: 1, amount: 1, paidAmount: 1 } }).toArray()) {
    const k = String(f.studentId);
    if (!feesByStudent.has(k)) feesByStudent.set(k, []);
    feesByStudent.get(k).push(f);
  }
  for (const s of await col(Student).find({}, { projection: { feeStatus: 1 } }).toArray()) {
    const status = feeStatusFor(feesByStudent.get(String(s._id)) || []);
    if (s.feeStatus !== status) await update(Student, s._id, { feeStatus: status }, 'students.fee_status_recalculated');
  }

  // 10d. Report (do not delete) login accounts with no matching profile; review them by hand
  const linked = new Set();
  for (const Model of [Student, Teacher, Parent]) {
    for (const d of await col(Model).find({}, { projection: { userId: 1, parentUserId: 1 } }).toArray()) {
      if (d.userId) linked.add(String(d.userId));
      if (d.parentUserId) linked.add(String(d.parentUserId));
    }
  }
  for (const u of await col(User).find({ role: { $in: ['student', 'teacher', 'parent'] } }, { projection: { role: 1 } }).toArray()) {
    if (!linked.has(String(u._id))) count(`users.no_profile.${u.role} (review only)`);
  }

  // 11. Indexes: drop old global-unique indexes, then build the new per-school ones
  const obsolete = [
    [Student, 'rollNumber_1_class_1_section_1'], [Teacher, 'email_1'], [Teacher, 'employeeId_1'],
    [Parent, 'email_1'], [FeeStructure, 'academicYear_1_class_1_section_1_feeType_1'],
  ];
  for (const [Model, name] of obsolete) {
    const exists = (await col(Model).indexes()).some((i) => i.name === name);
    if (exists) {
      count(`indexes.dropped.${Model.modelName}.${name}`);
      if (APPLY) await col(Model).dropIndex(name);
    }
  }
  if (APPLY) {
    for (const Model of Object.values(mongoose.models)) {
      try {
        await Model.syncIndexes();
      } catch (err) {
        if (!quiet) console.error(`Index build failed for ${Model.modelName}: ${err.message}`);
        count(`indexes.failed.${Model.modelName}`);
      }
    }
  }

  if (!quiet) console.table(Object.entries(report).map(([change, n]) => ({ change, count: n })));
  return report;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}\n`);
  await migrate();
  console.log(APPLY ? '\nMigration applied.' : '\nDry run complete. Re-run with --apply to write these changes.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Migration failed:', err);
    await mongoose.disconnect();
    process.exit(1);
  });
}

module.exports = { migrate };
