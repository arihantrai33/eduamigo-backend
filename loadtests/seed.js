// Creates synthetic data for load tests: 3 schools, each with ~1,000 students, their parents, teachers and fees.
// Nothing here comes from real data. It refuses to run unless the database name ends in _loadtest or _staging and you confirm:
//
//   LOADTEST_SEED_OK=yes MONGO_URI="mongodb+srv://.../eduamigo_loadtest" node loadtests/seed.js [--students 1000] [--schools 3] [--out loadtests/data/seed.json]
//
// Output (loadtests/data/seed.json, git-ignored) lists sign-in details and ids that the k6 scripts use. Every account has the same
// throwaway password, which is only valid on that database.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const PER_SCHOOL = Number(arg('students', 1000));
const SCHOOLS = Number(arg('schools', 3));
const OUT = arg('out', path.join(__dirname, 'data/seed.json'));
const PASSWORD = process.env.LOADTEST_PASSWORD || 'LoadTest@2026'; // a public test server should set LOADTEST_PASSWORD to something private
const SECTIONS = ['A', 'B', 'C', 'D', 'E'];

const t0 = Date.now();
const step = async (name, promise) => { const r = await promise; console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${name}`); return r; };

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const dbName = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://')).pathname.replace('/', '').split('?')[0];
  if (!/_(loadtest|staging)$/.test(dbName)) throw new Error(`Refusing to seed database "${dbName}": its name must end in _loadtest or _staging`);
  if (process.env.LOADTEST_SEED_OK !== 'yes') throw new Error('Set LOADTEST_SEED_OK=yes to confirm that this is a throwaway database');
  if (await mongoose.connect(uri).then(() => mongoose.connection.db.collection('students').countDocuments({}))) {
    if (process.env.LOADTEST_ALLOW_NONEMPTY !== 'yes') throw new Error('The database already has students. Use an empty database (or set LOADTEST_ALLOW_NONEMPTY=yes)');
  }
  process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';
  // Build every index before the first write, as the application's own tests do.
  for (const file of fs.readdirSync(path.join(__dirname, '../src/models'))) require(path.join(__dirname, '../src/models', file));
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  console.log(`Seeding ${SCHOOLS} schools x ${PER_SCHOOL} students into ${dbName}`);

  const root = path.join(__dirname, '..');
  const User = require(`${root}/src/models/User`);
  const Student = require(`${root}/src/models/Student`);
  const Teacher = require(`${root}/src/models/Teacher`);
  const Parent = require(`${root}/src/models/Parent`);
  const Fee = require(`${root}/src/models/Fee`);
  const SchoolClass = require(`${root}/src/models/SchoolClass`);
  const AcademicSession = require(`${root}/src/models/AcademicSession`);
  const { onboardSchool } = require(`${root}/src/services/schoolOnboarding`);
  const { hashPassword } = require(`${root}/src/services/credentials`);
  const hash = await hashPassword(PASSWORD);
  console.log('Password hashed');
  const out = { password: PASSWORD, schools: [] };
  let phone = 7000000000;
  const nextPhone = () => String((phone += 1));

  for (let s = 1; s <= SCHOOLS; s += 1) {
    const created = await step('onboard', onboardSchool({ name: `Load Test School ${s}`, code: `LT${s}`, adminName: `Admin ${s}`, adminEmail: `admin${s}@loadtest.invalid`, plan: 'premium', trialDays: 365 }));
    const school = created.school._id;
    console.log(`${new Date().toISOString().slice(11,19)} School ${s} created`);
    await User.updateOne({ _id: created.admin._id }, { password: hash, mustChangePassword: false });

    // Sections hold 20 students each: classes 1.. with sections A-E.
    const sections = [];
    for (let i = 0; i < Math.ceil(PER_SCHOOL / 20); i += 1) sections.push({ class: String(Math.floor(i / SECTIONS.length) + 1), section: SECTIONS[i % SECTIONS.length] });
    const classNames = [...new Set(sections.map((x) => x.class))];
    await step('classes', SchoolClass.insertMany(classNames.map((name, i) => ({ school, name, order: i, sections: SECTIONS.map((n) => ({ name: n })) }))));

    const year = new Date().getUTCFullYear();
    await step('sessions', AcademicSession.insertMany([
      { school, name: `${year}-${String(year + 1).slice(2)}`, startDate: new Date(Date.UTC(year, 3, 1)), endDate: new Date(Date.UTC(year + 1, 2, 31)), status: 'current' },
      { school, name: `${year + 1}-${String(year + 2).slice(2)}`, startDate: new Date(Date.UTC(year + 1, 3, 1)), endDate: new Date(Date.UTC(year + 2, 2, 31)), status: 'upcoming' },
    ]));
    const teacherCount = Math.max(1, Math.round(PER_SCHOOL / 25));
    const teacherUsers = await step('teacher users', User.insertMany(Array.from({ length: teacherCount }, (_, i) => ({
      name: `Teacher ${s}-${i + 1}`, email: `teacher${s}-${i + 1}@loadtest.invalid`, phone: nextPhone(), password: hash, role: 'teacher', school, mustChangePassword: false,
    }))));
    const teachers = await step('teachers', Teacher.insertMany(teacherUsers.map((u, i) => ({
      name: u.name, email: u.email, phone: u.phone, employeeId: `T${s}-${i + 1}`, subjects: ['Mathematics'], salary: 30000, school, userId: u._id,
      assignedClasses: sections.filter((_, k) => k % teacherCount === i).map((x) => `${x.class}-${x.section}`),
    }))));

    const studentRows = [];
    for (let n = 0; n < PER_SCHOOL; n += 1) {
      const sec = sections[Math.floor(n / 20)];
      studentRows.push({ n, class: sec.class, section: sec.section, roll: String((n % 20) + 1), admissionNo: `LT${s}-${String(n + 1).padStart(5, '0')}`, phone: nextPhone() });
    }
    const studentUsers = await step('student users', User.insertMany(studentRows.map((r) => ({ name: `Student ${s}-${r.n + 1}`, phone: r.phone, password: hash, role: 'student', school, mustChangePassword: false, loginPhone: null }))));
    const parentUsers = await step('parent users', User.insertMany(studentRows.map((r) => ({ name: `Parent ${s}-${r.n + 1}`, phone: r.phone, password: hash, role: 'parent', school, mustChangePassword: false, loginPhone: r.phone }))));
    const students = await step('students', Student.insertMany(studentRows.map((r, i) => ({
      name: `Student ${s}-${r.n + 1}`, phone: r.phone, class: r.class, section: r.section, rollNumber: r.roll, admissionNo: r.admissionNo, school,
      userId: studentUsers[i]._id, parentUserId: parentUsers[i]._id,
    }))));
    await step('parents', Parent.insertMany(students.map((st, i) => ({ name: parentUsers[i].name, phone: studentRows[i].phone, school, userId: parentUsers[i]._id, children: [st._id] }))));
    const due = new Date(Date.now() + 14 * 86400000);
    const fees = await step('fees', Fee.insertMany(students.flatMap((st) => ['Tuition', 'Transport'].map((feeType) => ({ school, studentId: st._id, feeType, amount: 5000, dueDate: due, academicYear: `${year}-${String(year + 1).slice(2)}` })))));

    out.schools.push({
      code: `LT${s}`, id: String(school), admin: { identifier: `admin${s}@loadtest.invalid` },
      teachers: teachers.map((t, i) => ({ identifier: t.email, sections: sections.filter((_, k) => k % teacherCount === i) })),
      students: students.map((st, i) => ({ id: String(st._id), admissionNo: studentRows[i].admissionNo, parentMobile: studentRows[i].phone, class: studentRows[i].class, section: studentRows[i].section })),
      sectionStudents: sections.map((x) => ({ ...x, ids: students.filter((st) => st.class === x.class && st.section === x.section).map((st) => String(st._id)) })),
      feeIds: fees.map((f) => String(f._id)),
      nextSession: `${year + 1}-${String(year + 2).slice(2)}`,
    });
    console.log(`${new Date().toISOString().slice(11,19)} School ${s}: ${students.length} students, ${teachers.length} teachers, ${fees.length} fees`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT}`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
