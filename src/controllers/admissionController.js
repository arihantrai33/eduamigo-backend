const Admission = require('../models/Admission');
const Counter = require('../models/Counter');
const Student = require('../models/Student');
const { HttpError, asyncHandler, assertId, pick, escapeRegex } = require('../utils/http');
const { normalizeClass, normalizeSection } = require('../utils/classes');
const academic = require('../services/academic');
const { createStudentWithAccounts } = require('../services/studentService');
const { toDayKey, formatDay } = require('../utils/dates');

const { STATUSES, SOURCES } = Admission;
const FIELDS = ['classApplied', 'studentName', 'gender', 'dateOfBirth', 'previousSchool', 'parentName', 'parentPhone',
  'parentEmail', 'address', 'source', 'notes', 'followUpDate', 'testDate', 'academicYear'];

// Which status can follow which. "Admitted" is reached only through POST /:id/admit.
const NEXT = {
  Enquiry:          ['Applied', 'Rejected', 'Withdrawn'],
  Applied:          ['Test Scheduled', 'Approved', 'Rejected', 'Withdrawn'],
  'Test Scheduled': ['Approved', 'Rejected', 'Withdrawn'],
  Approved:         ['Rejected', 'Withdrawn'],
  Rejected:         ['Enquiry'],
  Withdrawn:        ['Enquiry'],
  Admitted:         [],
};

function clean(body) {
  const data = pick(body || {}, FIELDS);
  if (data.classApplied !== undefined) data.classApplied = normalizeClass(data.classApplied);
  if (data.parentPhone !== undefined) {
    data.parentPhone = String(data.parentPhone).replace(/[\s-]/g, '');
    if (!/^(\+91)?[6-9]\d{9}$/.test(data.parentPhone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number for the parent');
  }
  if (data.parentEmail && !/^\S+@\S+\.\S+$/.test(data.parentEmail)) throw new HttpError(400, 'Enter a valid parent email');
  if (data.source !== undefined && !SOURCES.includes(data.source)) throw new HttpError(400, 'Invalid enquiry source');
  for (const d of ['dateOfBirth', 'followUpDate', 'testDate']) {
    if (data[d] === '' || data[d] === null) data[d] = undefined;
    else if (data[d] !== undefined && Number.isNaN(new Date(data[d]).getTime())) throw new HttpError(400, `Invalid ${d}`);
  }
  return data;
}

async function findOwn(req) {
  assertId(req.params.id);
  const a = await Admission.findOne({ _id: req.params.id, school: req.schoolId });
  if (!a) throw new HttpError(404, 'Admission record not found');
  return a;
}

// GET /api/admissions?status=&class=&search=&academicYear=
exports.list = asyncHandler(async (req, res) => {
  const academicYear = String(req.query.academicYear || await academic.currentSessionName(req.schoolId));
  const filter = { school: req.schoolId, academicYear };
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.class) filter.classApplied = normalizeClass(req.query.class);
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
    filter.$or = [{ studentName: rx }, { parentName: rx }, { parentPhone: rx }, { applicationNo: rx }];
  }
  const [rows, counts] = await Promise.all([
    Admission.find(filter).sort({ updatedAt: -1 }).limit(500).populate('student', 'name class section rollNumber'),
    Admission.aggregate([{ $match: { school: req.schoolId, academicYear } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({
    success: true,
    academicYear,
    counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n || 0])),
    options: { statuses: STATUSES, sources: SOURCES, next: NEXT },
    data: rows,
  });
});

// POST /api/admissions — a new enquiry
exports.create = asyncHandler(async (req, res) => {
  const data = clean(req.body);
  if (!data.studentName || !data.classApplied || !data.parentName || !data.parentPhone) {
    throw new HttpError(400, 'Student name, class, parent name and parent mobile are required');
  }
  data.academicYear = data.academicYear || await academic.currentSessionName(req.schoolId);
  const seq = await Counter.next(req.schoolId, `admission:${data.academicYear}`);
  const applicationNo = `ADM-${data.academicYear.slice(0, 4)}-${String(seq).padStart(4, '0')}`;
  const doc = await Admission.create({
    ...data, school: req.schoolId, applicationNo, status: 'Enquiry', createdBy: req.user._id,
    history: [{ status: 'Enquiry', note: 'Enquiry recorded', by: req.user._id }],
  });
  res.status(201).json({ success: true, data: doc });
});

// PUT /api/admissions/:id — edit details (not once admitted)
exports.update = asyncHandler(async (req, res) => {
  const a = await findOwn(req);
  if (a.status === 'Admitted') throw new HttpError(409, 'This student is already admitted; edit the student record instead');
  Object.assign(a, clean(req.body));
  await a.save();
  res.json({ success: true, data: a });
});

// PATCH /api/admissions/:id/status { status, note, testDate?, followUpDate? }
exports.setStatus = asyncHandler(async (req, res) => {
  const a = await findOwn(req);
  const status = String(req.body?.status || '');
  if (!(NEXT[a.status] || []).includes(status)) throw new HttpError(400, `An application that is ${a.status} cannot move to ${status || 'that status'}`);
  if (status === 'Test Scheduled' && !req.body?.testDate && !a.testDate) throw new HttpError(400, 'Choose the test date');
  const extra = clean(pick(req.body, ['testDate', 'followUpDate']));
  Object.assign(a, extra, { status });
  a.history.push({ status, note: String(req.body?.note || '').slice(0, 500), by: req.user._id });
  await a.save();
  res.json({ success: true, data: a });
});

// GET /api/admissions/:id/admit-defaults?section=A — suggested roll number for the class-section
exports.admitDefaults = asyncHandler(async (req, res) => {
  const a = await findOwn(req);
  const master = (await academic.listClasses(req.schoolId)).find((c) => c.name === a.classApplied);
  const sections = master
    ? master.sections.map((s) => s.name).sort()
    : (await Student.distinct('section', { school: req.schoolId, class: a.classApplied, isActive: true })).sort();
  const section = normalizeSection(req.query.section || sections[0] || 'A');
  const rollNumber = await academic.nextRollNumber(req.schoolId, a.classApplied, section);
  res.json({ success: true, data: { sections, section, rollNumber } });
});

// POST /api/admissions/:id/admit { section, rollNumber?, admissionNo?, studentEmail?, studentPhone? }
// Creates the student and their login (and the parent's, unless a sibling already has one).
exports.admit = asyncHandler(async (req, res) => {
  const a = await findOwn(req);
  if (a.status === 'Admitted') throw new HttpError(409, 'This student is already admitted');
  if (a.status !== 'Approved') throw new HttpError(400, 'Approve the application before admitting the student');
  const section = normalizeSection(req.body?.section);
  if (!section) throw new HttpError(400, 'Choose a section');
  // Optional: students sign in with their admission number.
  const studentEmail = String(req.body?.studentEmail || '').trim().toLowerCase() || undefined;
  if (studentEmail && !/^\S+@\S+\.\S+$/.test(studentEmail)) throw new HttpError(400, 'Student email is not valid');
  const rollNumber = String(req.body?.rollNumber || '').trim() || undefined; // assigned automatically when empty

  // Claim the application so two clicks cannot create two students.
  const claimed = await Admission.findOneAndUpdate({ _id: a._id, school: req.schoolId, status: 'Approved' }, { status: 'Admitted' }, { returnDocument: 'after' });
  if (!claimed) throw new HttpError(409, 'This application is already being admitted');
  try {
    const { student, credentials, linkedExistingParent } = await createStudentWithAccounts(req.schoolId, {
      name: a.studentName, email: studentEmail, phone: String(req.body?.studentPhone || a.parentPhone).replace(/[\s-]/g, ''),
      rollNumber, admissionNo: req.body?.admissionNo || undefined, gender: a.gender || undefined, dateOfBirth: a.dateOfBirth, address: a.address,
      parentName: a.parentName, parentPhone: a.parentPhone, parentEmail: a.parentEmail,
      class: a.classApplied, section,
      admittedOn: formatDay(toDayKey()), // admitted today, by this action
    });
    claimed.student = student._id;
    claimed.history.push({ status: 'Admitted', note: `Admitted to Class ${student.class}-${student.section}, roll ${student.rollNumber}`, by: req.user._id });
    await claimed.save();
    res.status(201).json({ success: true, data: claimed, student, credentials, linkedExistingParent });
  } catch (err) {
    await Admission.updateOne({ _id: a._id, school: req.schoolId }, { status: 'Approved' }); // nothing was created; allow another try
    throw err;
  }
});
