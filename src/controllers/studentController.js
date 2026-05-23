const Student = require('../models/Student');
const User    = require('../models/User');
const bcrypt  = require('bcryptjs');

// GET /students — Admin: all students
exports.getStudents = async (req, res) => {
  try {
    const { class: cls, section, search } = req.query;
    let query = { isActive: true, school: req.user.school };
    if (cls)     query.class   = cls;
    if (section) query.section = section;
    if (search)  query.name    = { $regex: search, $options: 'i' };

    const students = await Student.find(query).sort({ createdAt: -1 });
    res.json({ success: true, count: students.length, data: students });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /students/my-profile — Student: apna profile
exports.getMyProfile = async (req, res) => {
  try {
    const student = await Student.findOne({
      userId: req.user._id,
      isActive: true
    });
    if (!student) return res.status(404).json({ success: false, message: 'Profile not found' });
    res.json({ success: true, data: student });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /students/my-child — Parent: apne bachche ka profile
exports.getMyChild = async (req, res) => {
  try {
    const student = await Student.findOne({
      parentUserId: req.user._id,
      isActive: true
    });
    if (!student) return res.status(404).json({ success: false, message: 'Child profile not found' });
    res.json({ success: true, data: student });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /students/:id — Admin: single student
exports.getStudent = async (req, res) => {
  try {
    const student = await Student.findOne({ _id: req.params.id, school: req.user.school });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, data: student });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /students — Admin: student add karo
exports.createStudent = async (req, res) => {
  let studentUser = null;
  let parentUser  = null;

  try {
    const {
      name, email, phone, rollNumber,
      class: cls, section, gender, dateOfBirth,
      address, parentName, parentPhone, parentEmail,
      feeStatus
    } = req.body;

    // Validation
    if (!name || !email || !phone || !rollNumber || !cls || !section) {
      return res.status(400).json({ success: false, message: 'Required fields missing' });
    }

    // Email conflict check
    const existingStudent = await User.findOne({ email });
    if (existingStudent) {
      return res.status(400).json({ success: false, message: 'Student email already registered' });
    }
    if (parentEmail) {
      const existingParent = await User.findOne({ email: parentEmail });
      if (existingParent) {
        return res.status(400).json({ success: false, message: 'Parent email already registered' });
      }
    }

    // Student User account — password = phone number
    const hashedStudentPass = await bcrypt.hash(phone, 10);
    studentUser = await User.create({
      name,
      email,
      password: hashedStudentPass,
      role:     'student',
      school:   req.user.school,
    });

    // Parent User account — password = parentPhone (fallback: phone)
    if (parentEmail && parentName) {
      const hashedParentPass = await bcrypt.hash(parentPhone || phone, 10);
      parentUser = await User.create({
        name:   parentName,
        email:  parentEmail,
        password: hashedParentPass,
        role:   'parent',
        school: req.user.school,
      });
    }

    // Student record
    const student = await Student.create({
      name, email, phone, rollNumber,
      class: cls, section, gender, dateOfBirth,
      address, parentName, parentPhone, parentEmail,
      feeStatus:    feeStatus || 'Pending',
      school:       req.user.school,
      userId:       studentUser._id,
      parentUserId: parentUser ? parentUser._id : null,
    });

    // profileId update
    await User.findByIdAndUpdate(studentUser._id, { profileId: student._id });
    if (parentUser) {
      await User.findByIdAndUpdate(parentUser._id, { profileId: student._id });
    }

    res.status(201).json({
      success: true,
      data: student,
      credentials: {
        student: { email, password: phone },
        parent: parentEmail
          ? { email: parentEmail, password: parentPhone || phone }
          : null,
      }
    });

  } catch (err) {
    // Rollback on failure
    if (studentUser) await User.findByIdAndDelete(studentUser._id);
    if (parentUser)  await User.findByIdAndDelete(parentUser._id);
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /students/:id — Admin: student update karo
exports.updateStudent = async (req, res) => {
  try {
    const student = await Student.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      req.body,
      { new: true, runValidators: true }
    );
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    // User name sync
    if (req.body.name && student.userId) {
      await User.findByIdAndUpdate(student.userId, { name: req.body.name });
    }

    res.json({ success: true, data: student });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// DELETE /students/:id — Admin: student deactivate karo
exports.deleteStudent = async (req, res) => {
  try {
    const student = await Student.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      { isActive: false },
      { new: true }
    );
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    if (student.userId)
      await User.findByIdAndUpdate(student.userId,       { isActive: false });
    if (student.parentUserId)
      await User.findByIdAndUpdate(student.parentUserId, { isActive: false });

    res.json({ success: true, message: 'Student removed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};