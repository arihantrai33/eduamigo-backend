const Student = require('../models/Student');
const Parent = require('../models/Parent');
const User = require('../models/User');
const { HttpError } = require('../utils/http');
const { parseClassKey } = require('../utils/classes');
const { normalizePhone, isMobile } = require('../utils/phone');
const School = require('../models/School');
const { temporaryPassword, hashPassword } = require('./credentials');
const { assertStudentCapacity } = require('./subscription');
const academic = require('./academic');
const StudentEnrollment = require('../models/StudentEnrollment');
const { withKeyLock, isDuplicateKey } = require('../utils/concurrency');

const STUDENT_FIELDS = ['name', 'admissionNo', 'email', 'phone', 'rollNumber', 'gender', 'dateOfBirth', 'address',
  'parentName', 'parentPhone', 'parentEmail', 'photo'];

// Creates a student plus login accounts for the student and (optionally) the parent.
//   Student signs in with the school code + admission number; email is optional.
//   Parent signs in with the school code + mobile number (or email). A parent account is made when a
//   parent email or a valid parent mobile is given. If that parent already has an account in this
//   school (a sibling is enrolled), the new student is linked to it instead of creating another.
async function createOnce(school, input) {
  const data = {};
  for (const key of STUDENT_FIELDS) if (input[key] !== undefined && input[key] !== '') data[key] = input[key];
  const { class: cls, section } = parseClassKey(input.class, input.section);
  data.class = cls;
  data.section = section;
  data.email = String(data.email || '').trim().toLowerCase() || undefined;
  if (data.parentEmail) data.parentEmail = String(data.parentEmail).trim().toLowerCase();
  if (!data.phone && data.parentPhone) data.phone = data.parentPhone;

  if (!data.name || !data.phone || !data.class || !data.section) {
    throw new HttpError(400, 'Name, phone (or parent mobile), class and section are required');
  }
  for (const [key, label] of [['email', 'Student email'], ['parentEmail', 'Parent email']]) {
    if (data[key] && !/^\S+@\S+\.\S+$/.test(data[key])) throw new HttpError(400, `${label} is not valid`);
  }
  if (data.email && await User.exists({ email: data.email }).setOptions({ crossTenant: 'login emails are unique across all schools' })) throw new HttpError(409, 'Student email already registered');
  await assertStudentCapacity(school);
  await academic.assertClassSection(school, data.class, data.section);
  if (data.admissionNo) {
    data.admissionNo = String(data.admissionNo).trim();
    if (await Student.exists({ school, admissionNo: data.admissionNo })) {
      throw new HttpError(409, `Admission number ${data.admissionNo} is already used by another student`);
    }
  }
  data.rollNumber = data.rollNumber ? String(data.rollNumber).trim() : await academic.nextRollNumber(school, data.class, data.section);

  let parentUser = null;
  let parentCreated = false;
  const parentMobile = isMobile(data.parentPhone) ? normalizePhone(data.parentPhone) : null;
  if (data.parentEmail) {
    // Login emails are unique across every school; the check below rejects an address that belongs to another school.
    parentUser = await User.findOne({ email: data.parentEmail }).setOptions({ crossTenant: 'login emails are unique across all schools' });
    if (parentUser && (parentUser.role !== 'parent' || String(parentUser.school) !== String(school))) {
      throw new HttpError(409, 'Parent email is already used by another account');
    }
  } else if (parentMobile) {
    parentUser = await User.findOne({ school, role: 'parent', loginPhone: parentMobile });
  }
  const schoolCode = (await School.findById(school).select('code').lean())?.code || null;

  const created = [];
  const credentials = {};
  try {
    const studentPassword = temporaryPassword();
    const studentUser = await User.create({
      name: data.name, email: data.email, phone: data.phone, role: 'student', school,
      password: await hashPassword(studentPassword), mustChangePassword: true,
    });
    created.push(studentUser);
    credentials.student = { schoolCode, email: data.email || null, password: studentPassword };

    if ((data.parentEmail || parentMobile) && !parentUser) {
      const parentPassword = temporaryPassword();
      parentUser = await User.create({
        name: data.parentName || `Parent of ${data.name}`, email: data.parentEmail, phone: data.parentPhone || null,
        role: 'parent', school, password: await hashPassword(parentPassword), mustChangePassword: true,
      });
      created.push(parentUser);
      parentCreated = true;
      credentials.parent = {
        schoolCode, loginId: parentMobile || data.parentEmail, email: data.parentEmail || null, phone: parentMobile, password: parentPassword,
      };
    }

    if (!data.admissionNo) data.admissionNo = await academic.nextAdmissionNo(school);
    const student = await Student.create({
      ...data, school, userId: studentUser._id, parentUserId: parentUser?._id || null,
    });
    created.push(student);
    credentials.student.admissionNo = student.admissionNo;
    credentials.student.loginId = student.admissionNo;
    await academic.recordPlacement(student);
    await User.updateOne({ _id: studentUser._id, school }, { profileId: student._id });

    if (parentUser) {
      let parent = await Parent.findOne({ userId: parentUser._id, school });
      if (!parent) {
        parent = await Parent.create({
          name: parentUser.name, email: parentUser.email, phone: data.parentPhone || data.phone,
          school, userId: parentUser._id, children: [student._id],
        });
        if (parentCreated) created.push(parent);
      } else {
        await Parent.updateOne({ _id: parent._id, school }, { $addToSet: { children: student._id } });
      }
      if (!parentUser.profileId) await User.updateOne({ _id: parentUser._id, school }, { profileId: parent._id });
    }

    return { student, credentials, linkedExistingParent: !!parentUser && !parentCreated };
  } catch (err) {
    // Roll back anything created in this attempt so no orphan accounts remain.
    await Promise.all(created.map((doc) => doc.constructor.deleteOne({ _id: doc._id, school }).catch(() => {})));
    const student = created.find((doc) => doc instanceof Student);
    if (student) await StudentEnrollment.deleteMany({ school, student: student._id }).catch(() => {});
    throw err;
  }
}

// The next roll number is "highest in the class + 1", so two admissions into the same class at the same moment pick the
// same number and the unique index rejects one. Admissions without a given roll number for one class are therefore run
// one after another in this process, and a clash from another server process is retried (the failed attempt has already
// rolled back its accounts, so nothing is left behind).
const isRollNumberClash = (err) => isDuplicateKey(err) && /roll/i.test(JSON.stringify(err.keyPattern || {}) + String(err.message));

async function createStudentWithAccounts(school, input) {
  if (String(input.rollNumber ?? '').trim()) return createOnce(school, input);
  const { class: cls, section } = parseClassKey(input.class, input.section);
  return withKeyLock(`roll:${school}:${cls}:${section}`, async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await createOnce(school, input);
      } catch (err) {
        if (!isRollNumberClash(err) || attempt >= 4) throw err;
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));
      }
    }
  });
}

module.exports = { createStudentWithAccounts, STUDENT_FIELDS };
