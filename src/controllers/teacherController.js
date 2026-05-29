const Teacher = require('../models/Teacher');
const User    = require('../models/User');
const bcrypt  = require('bcryptjs');

// GET /api/teachers/me
exports.getMe = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({
      userId: req.user._id,
      school: req.user.school._id || req.user.school,
      isActive: true,
    });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher profile not found' });
    res.json({ success: true, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/teachers
exports.getTeachers = async (req, res) => {
  try {
    if (!req.user.school) {
      return res.status(400).json({ success: false, message: 'Admin is not linked to any school' });
    }
    const { subject, search } = req.query;
    const query = { school: req.user.school._id || req.user.school, isActive: true };
    if (subject) query.subjects = subject;
    if (search)  query.name = { $regex: search, $options: 'i' };

    const teachers = await Teacher.find(query).sort({ name: 1 });
    res.json({ success: true, count: teachers.length, data: teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/teachers/:id
exports.getTeacher = async (req, res) => {
  try {
    const schoolId = req.user.school._id || req.user.school;
    const teacher = await Teacher.findOne({ _id: req.params.id, school: schoolId });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    res.json({ success: true, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/teachers/class/:class
exports.getTeachersByClass = async (req, res) => {
  try {
    const schoolId = req.user.school._id || req.user.school;
    const teachers = await Teacher.find({
      assignedClasses: req.params.class,
      school: schoolId,
      isActive: true,
    });
    res.json({ success: true, count: teachers.length, data: teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/teachers
exports.createTeacher = async (req, res) => {
  try {
    if (!req.user.school) {
      return res.status(400).json({ success: false, message: 'Admin is not linked to any school' });
    }
    const schoolId = req.user.school._id || req.user.school;
    const { email, employeeId, name, phone, ...rest } = req.body;

    const existing = await Teacher.findOne({
      school: schoolId,
      $or: [{ email }, { employeeId }],
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email or Employee ID already exists in your school' });
    }

    let user = await User.findOne({ email });
    if (!user) {
      const hashedPassword = await bcrypt.hash(phone || employeeId, 10);
      user = await User.create({
        name, email, phone,
        password: hashedPassword,
        role: 'teacher',
        school: schoolId,
      });
    } else if (!user.school) {
      await User.findByIdAndUpdate(user._id, { school: schoolId });
    }

    const teacher = await Teacher.create({
      ...rest,
      name, email, phone, employeeId,
      userId: user._id,
      school: schoolId,
    });

    res.status(201).json({
      success: true,
      message: 'Teacher added successfully!',
      data: teacher,
      credentials: { email, password: phone || employeeId },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/teachers/:id
exports.updateTeacher = async (req, res) => {
  try {
    const schoolId = req.user.school._id || req.user.school;
    const { school, userId, ...updateData } = req.body;

    const teacher = await Teacher.findOneAndUpdate(
      { _id: req.params.id, school: schoolId },
      updateData,
      { new: true, runValidators: true }
    );
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });

    if (teacher.userId) {
      await User.findByIdAndUpdate(teacher.userId, {
        name:  updateData.name  || undefined,
        email: updateData.email || undefined,
        phone: updateData.phone || undefined,
      });
    }
    res.json({ success: true, message: 'Teacher updated successfully!', data: teacher });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PATCH /api/teachers/:id/assign-class
exports.assignClass = async (req, res) => {
  try {
    const schoolId = req.user.school._id || req.user.school;
    const { className } = req.body;
    const teacher = await Teacher.findOne({ _id: req.params.id, school: schoolId });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    if (teacher.assignedClasses.includes(className)) {
      return res.status(400).json({ success: false, message: `Class ${className} already assigned` });
    }
    teacher.assignedClasses.push(className);
    await teacher.save();
    res.json({ success: true, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/teachers/:id/remove-class
exports.removeClass = async (req, res) => {
  try {
    const schoolId = req.user.school._id || req.user.school;
    const { className } = req.body;
    const teacher = await Teacher.findOne({ _id: req.params.id, school: schoolId });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    teacher.assignedClasses = teacher.assignedClasses.filter(c => c !== className);
    await teacher.save();
    res.json({ success: true, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/teachers/:id
exports.deleteTeacher = async (req, res) => {
  try {
    const schoolId = req.user.school._id || req.user.school;
    const teacher = await Teacher.findOneAndUpdate(
      { _id: req.params.id, school: schoolId },
      { isActive: false },
      { new: true }
    );
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    if (teacher.userId) {
      await User.findByIdAndUpdate(teacher.userId, { isActive: false });
    }
    res.json({ success: true, message: 'Teacher deactivated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};