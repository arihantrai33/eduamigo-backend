const Student = require('../models/Student');
const User = require('../models/User');
const cloudinary = require('../config/cloudinary');
const streamifier = require('streamifier');
const { HttpError, asyncHandler, assertId, pick, escapeRegex } = require('../utils/http');
const { parseClassKey, normalizeClass, normalizeSection } = require('../utils/classes');
const { createStudentWithAccounts } = require('../services/studentService');
const { studentForUser, resolveChild, teacherForUser } = require('../services/directory');

function uploadPhotoToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'student_photos', resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

const UPDATABLE = ['name', 'phone', 'rollNumber', 'gender', 'dateOfBirth', 'address',
  'parentName', 'parentPhone', 'parentEmail', 'photo', 'class', 'section'];

// GET /students — admin/teacher (teachers only see their assigned classes)
exports.getStudents = asyncHandler(async (req, res) => {
  const { class: cls, section, search } = req.query;
  const query = { isActive: true, school: req.schoolId };
  if (cls || section) {
    const key = parseClassKey(cls, section);
    if (key.class) query.class = key.class;
    if (key.section) query.section = key.section;
  }
  if (search) query.name = { $regex: escapeRegex(search), $options: 'i' };

  if (req.user.role === 'teacher') {
    const teacher = await teacherForUser(req.user);
    const keys = (teacher?.assignedClasses || []).map((k) => parseClassKey(k));
    if (!keys.length) return res.json({ success: true, count: 0, data: [] });
    query.$or = keys.map((k) => (k.section ? { class: k.class, section: k.section } : { class: k.class }));
  }

  const students = await Student.find(query).sort({ class: 1, section: 1, rollNumber: 1 });
  res.json({ success: true, count: students.length, data: students });
});

exports.getClasses = asyncHandler(async (req, res) => {
  const classes = await Student.distinct('class', { isActive: true, school: req.schoolId });
  const sorted = classes.sort((a, b) => {
    const na = Number(a); const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
  res.json({ success: true, data: sorted });
});

exports.getSections = asyncHandler(async (req, res) => {
  if (!req.query.class) throw new HttpError(400, 'class query parameter is required');
  const sections = await Student.distinct('section', {
    class: normalizeClass(req.query.class), isActive: true, school: req.schoolId,
  });
  res.json({ success: true, data: sections.sort() });
});

exports.getMyProfile = asyncHandler(async (req, res) => {
  const student = await studentForUser(req.user);
  if (!student) throw new HttpError(404, 'Profile not found');
  res.json({ success: true, data: student });
});

// GET /students/my-child?studentId= — parent
exports.getMyChild = asyncHandler(async (req, res) => {
  const { child, children } = await resolveChild(req.user, req.query.studentId);
  if (!child) throw new HttpError(404, 'No child is linked to this account');
  res.json({ success: true, data: child, children });
});

exports.getStudent = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const student = await Student.findOne({ _id: req.params.id, school: req.schoolId });
  if (!student) throw new HttpError(404, 'Student not found');
  res.json({ success: true, data: student });
});

exports.createStudent = asyncHandler(async (req, res) => {
  const input = { ...req.body };
  if (req.file) input.photo = (await uploadPhotoToCloudinary(req.file.buffer)).secure_url;
  const { student, credentials, linkedExistingParent } = await createStudentWithAccounts(req.schoolId, input);
  res.status(201).json({ success: true, data: student, credentials, linkedExistingParent });
});

exports.updateStudent = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const update = pick(req.body, UPDATABLE);
  if (update.class !== undefined || update.section !== undefined) {
    const parsed = parseClassKey(update.class, update.section);
    if (update.class !== undefined) update.class = parsed.class;
    if (parsed.section) update.section = parsed.section;
  }
  if (req.file) update.photo = (await uploadPhotoToCloudinary(req.file.buffer)).secure_url;

  const student = await Student.findOneAndUpdate(
    { _id: req.params.id, school: req.schoolId },
    update,
    { returnDocument: 'after', runValidators: true },
  );
  if (!student) throw new HttpError(404, 'Student not found');
  if (update.name && student.userId) await User.updateOne({ _id: student.userId }, { name: update.name });
  res.json({ success: true, data: student });
});

// Soft delete: the student and their login are deactivated. The parent account stays
// active if they still have other active children in the school.
exports.deleteStudent = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const student = await Student.findOneAndUpdate(
    { _id: req.params.id, school: req.schoolId },
    { isActive: false },
    { returnDocument: 'after' },
  );
  if (!student) throw new HttpError(404, 'Student not found');
  if (student.userId) await User.updateOne({ _id: student.userId }, { isActive: false });
  if (student.parentUserId) {
    const siblings = await Student.countDocuments({ parentUserId: student.parentUserId, isActive: true, school: req.schoolId });
    if (!siblings) await User.updateOne({ _id: student.parentUserId }, { isActive: false });
  }
  res.json({ success: true, message: 'Student removed successfully' });
});
