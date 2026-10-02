const mongoose = require('mongoose');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const buildApp = require('../src/app');
const School = require('../src/models/School');
const User = require('../src/models/User');
const Student = require('../src/models/Student');
const Teacher = require('../src/models/Teacher');
const Parent = require('../src/models/Parent');
const { hashPassword } = require('../src/services/credentials');

const app = buildApp();
const api = () => request(app);

async function connect() {
  const base = process.env.MONGO_TEST_URI;
  const dbName = `eduamigo_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  await mongoose.connect(url.toString());
  // Build unique indexes up front so duplicate checks behave like production.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}

async function disconnect() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

async function clear() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });

let seq = 0;
async function makeUser(school, role, extra = {}) {
  seq += 1;
  return User.create({
    name: extra.name || `${role} ${seq}`,
    email: extra.email || `${role}${seq}_${Date.now()}@test.local`,
    password: await hashPassword(extra.password || 'Password123'),
    role, school: school._id, ...extra.fields,
  });
}

// A school with an admin, a teacher of 10-A, a student in 10-A with a parent, and a student in 10-B.
async function seedSchool(name = 'Alpha School') {
  const school = await School.create({ name });
  const admin = await makeUser(school, 'admin');

  const teacherUser = await makeUser(school, 'teacher');
  const teacher = await Teacher.create({
    name: teacherUser.name, email: teacherUser.email, phone: '9000000001', employeeId: `E${seq}`,
    subjects: ['Mathematics'], assignedClasses: ['10-A'], school: school._id, userId: teacherUser._id, salary: 30000,
  });

  const parentUser = await makeUser(school, 'parent');
  const studentUser = await makeUser(school, 'student');
  const student = await Student.create({
    name: 'Aarav', email: studentUser.email, phone: '9000000002', rollNumber: '1', class: '10', section: 'A',
    school: school._id, userId: studentUser._id, parentUserId: parentUser._id,
  });
  await Parent.create({ name: parentUser.name, email: parentUser.email, phone: '9000000003', school: school._id, userId: parentUser._id, children: [student._id] });

  const otherStudentUser = await makeUser(school, 'student');
  const otherStudent = await Student.create({
    name: 'Diya', email: otherStudentUser.email, phone: '9000000004', rollNumber: '1', class: '10', section: 'B',
    school: school._id, userId: otherStudentUser._id,
  });

  return { school, admin, teacherUser, teacher, parentUser, studentUser, student, otherStudentUser, otherStudent };
}

// Schedules a held exam (yesterday by default) for a seeded school.
async function scheduleExam(ctx, overrides = {}) {
  const ExamSchedule = require('../src/models/ExamSchedule');
  const yesterday = new Date(Date.now() - 86400000);
  return ExamSchedule.create({
    school: ctx.school._id, title: 'Mid Term', examType: 'Mid Term', subject: 'Mathematics',
    class: '10', section: 'A', date: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())),
    totalMarks: 100, academicYear: '2026-27', term: 'Term 1', ...overrides,
  });
}

module.exports = {
  scheduleExam, app, api, connect, disconnect, clear, auth, tokenFor, makeUser, seedSchool };
