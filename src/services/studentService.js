const Student = require('../models/Student');
const Parent = require('../models/Parent');
const User = require('../models/User');
const { HttpError } = require('../utils/http');
const { parseClassKey } = require('../utils/classes');
const { temporaryPassword, hashPassword } = require('./credentials');

const STUDENT_FIELDS = ['name', 'email', 'phone', 'rollNumber', 'gender', 'dateOfBirth', 'address',
  'parentName', 'parentPhone', 'parentEmail', 'feeStatus', 'photo'];

// Creates a student plus login accounts for the student and (optionally) the parent.
// If the parent already has an account in this school (a sibling is enrolled),
// the new student is linked to the existing parent instead of failing.
async function createStudentWithAccounts(school, input) {
  const data = {};
  for (const key of STUDENT_FIELDS) if (input[key] !== undefined && input[key] !== '') data[key] = input[key];
  const { class: cls, section } = parseClassKey(input.class, input.section);
  data.class = cls;
  data.section = section;
  data.email = String(data.email || '').trim().toLowerCase();
  if (data.parentEmail) data.parentEmail = String(data.parentEmail).trim().toLowerCase();

  if (!data.name || !data.email || !data.phone || !data.rollNumber || !data.class || !data.section) {
    throw new HttpError(400, 'Name, email, phone, roll number, class and section are required');
  }
  if (await User.exists({ email: data.email })) throw new HttpError(409, 'Student email already registered');

  let parentUser = null;
  let parentCreated = false;
  if (data.parentEmail) {
    parentUser = await User.findOne({ email: data.parentEmail });
    if (parentUser && (parentUser.role !== 'parent' || String(parentUser.school) !== String(school))) {
      throw new HttpError(409, 'Parent email is already used by another account');
    }
  }

  const created = [];
  const credentials = {};
  try {
    const studentPassword = temporaryPassword();
    const studentUser = await User.create({
      name: data.name, email: data.email, phone: data.phone, role: 'student', school,
      password: await hashPassword(studentPassword), mustChangePassword: true,
    });
    created.push(studentUser);
    credentials.student = { email: data.email, password: studentPassword };

    if (data.parentEmail && !parentUser) {
      const parentPassword = temporaryPassword();
      parentUser = await User.create({
        name: data.parentName || `Parent of ${data.name}`, email: data.parentEmail, phone: data.parentPhone || null,
        role: 'parent', school, password: await hashPassword(parentPassword), mustChangePassword: true,
      });
      created.push(parentUser);
      parentCreated = true;
      credentials.parent = { email: data.parentEmail, password: parentPassword };
    }

    const student = await Student.create({
      ...data, school, userId: studentUser._id, parentUserId: parentUser?._id || null,
    });
    created.push(student);
    await User.updateOne({ _id: studentUser._id }, { profileId: student._id });

    if (parentUser) {
      let parent = await Parent.findOne({ userId: parentUser._id, school });
      if (!parent) {
        parent = await Parent.create({
          name: parentUser.name, email: parentUser.email, phone: data.parentPhone || data.phone,
          school, userId: parentUser._id, children: [student._id],
        });
        if (parentCreated) created.push(parent);
      } else {
        await Parent.updateOne({ _id: parent._id }, { $addToSet: { children: student._id } });
      }
      if (!parentUser.profileId) await User.updateOne({ _id: parentUser._id }, { profileId: parent._id });
    }

    return { student, credentials, linkedExistingParent: !!parentUser && !parentCreated };
  } catch (err) {
    // Roll back anything created in this attempt so no orphan accounts remain.
    await Promise.all(created.map((doc) => doc.deleteOne().catch(() => {})));
    throw err;
  }
}

module.exports = { createStudentWithAccounts, STUDENT_FIELDS };
