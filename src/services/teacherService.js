const Teacher = require('../models/Teacher');
const User = require('../models/User');
const { HttpError } = require('../utils/http');
const { classKey, parseClassKey } = require('../utils/classes');
const { temporaryPassword, hashPassword } = require('./credentials');

const TEACHER_FIELDS = ['name', 'email', 'phone', 'employeeId', 'subjects', 'assignedClasses', 'qualification',
  'experience', 'joiningDate', 'gender', 'dateOfBirth', 'address', 'photo', 'salary'];

function normalizeTeacherInput(input) {
  const data = {};
  for (const key of TEACHER_FIELDS) if (input[key] !== undefined && input[key] !== '') data[key] = input[key];
  if (data.email) data.email = String(data.email).trim().toLowerCase();
  if (typeof data.subjects === 'string') data.subjects = data.subjects.split(',').map((s) => s.trim()).filter(Boolean);
  if (typeof data.assignedClasses === 'string') data.assignedClasses = data.assignedClasses.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(data.assignedClasses)) {
    data.assignedClasses = [...new Set(data.assignedClasses.map((k) => {
      const p = parseClassKey(k);
      return classKey(p.class, p.section);
    }).filter(Boolean))];
  }
  return data;
}

async function createTeacherWithAccount(school, input) {
  const data = normalizeTeacherInput(input);
  if (!data.name || !data.email || !data.phone || !data.employeeId) {
    throw new HttpError(400, 'Name, email, phone and employee ID are required');
  }
  if (await Teacher.exists({ school, $or: [{ email: data.email }, { employeeId: data.employeeId }] })) {
    throw new HttpError(409, 'Email or employee ID already exists in your school');
  }
  if (await User.exists({ email: data.email })) throw new HttpError(409, 'Email already registered');

  const password = temporaryPassword();
  const user = await User.create({
    name: data.name, email: data.email, phone: data.phone, role: 'teacher', school,
    password: await hashPassword(password), mustChangePassword: true,
  });
  try {
    const teacher = await Teacher.create({ ...data, school, userId: user._id });
    await User.updateOne({ _id: user._id }, { profileId: teacher._id });
    return { teacher, credentials: { email: data.email, password } };
  } catch (err) {
    await user.deleteOne().catch(() => {});
    throw err;
  }
}

module.exports = { createTeacherWithAccount, normalizeTeacherInput, TEACHER_FIELDS };
