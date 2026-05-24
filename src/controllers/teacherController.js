const Teacher = require('../models/Teacher');
const User    = require('../models/User');
const bcrypt  = require('bcryptjs');

// GET /api/teachers
exports.getTeachers = async (req, res) => {
  try {
    const { subject, search } = req.query;
    let query = { isActive: true, school: req.user.school };
    if (subject) query.subjects = subject;
    if (search) query.name = { $regex: search, $options: 'i' };
    const teachers = await Teacher.find(query).sort({ name: 1 });
    res.json({ success: true, count: teachers.length, data: teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/teachers/:id
exports.getTeacher = async (req, res) => {
  try {
    const teacher = await Teacher.findOne({ _id: req.params.id, school: req.user.school });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    res.json({ success: true, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/teachers/class/:class
exports.getTeachersByClass = async (req, res) => {
  try {
    const teachers = await Teacher.find({
      assignedClasses: req.params.class,
      isActive: true,
      school: req.user.school,
    });
    res.json({ success: true, count: teachers.length, data: teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/teachers — Teacher + User account create
exports.createTeacher = async (req, res) => {
  try {
    const { email, employeeId, name, phone, password, ...rest } = req.body;

    // Duplicate check
    const existing = await Teacher.findOne({
      $or: [{ email }, { employeeId }],
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Email ya Employee ID already exists' });
    }

    // User account bano (login ke liye)
    const hashedPassword = await bcrypt.hash(password || employeeId, 10);
    const user = await User.create({
      name,
      email,
      phone,
      password: hashedPassword,
      role:     'teacher',
      school:   req.user.school,
    });

    // Teacher document bano with userId linked
    const teacher = await Teacher.create({
      ...rest,
      name,
      email,
      phone,
      employeeId,
      userId: user._id,
      school: req.user.school,
    });

    res.status(201).json({ success: true, message: 'Teacher added successfully!', data: teacher });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/teachers/:id
exports.updateTeacher = async (req, res) => {
  try {
    const { school, userId, ...updateData } = req.body; // school/userId override prevent

    const teacher = await Teacher.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      updateData,
      { new: true, runValidators: true }
    );
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });

    // User account bhi sync karo
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
    const { className } = req.body;
    const teacher = await Teacher.findOne({ _id: req.params.id, school: req.user.school });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    if (teacher.assignedClasses.includes(className)) {
      return res.status(400).json({ success: false, message: `Class ${className} already assigned` });
    }
    teacher.assignedClasses.push(className);
    await teacher.save();
    res.json({ success: true, message: `Class ${className} assigned successfully!`, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/teachers/:id/remove-class
exports.removeClass = async (req, res) => {
  try {
    const { className } = req.body;
    const teacher = await Teacher.findOne({ _id: req.params.id, school: req.user.school });
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    teacher.assignedClasses = teacher.assignedClasses.filter(c => c !== className);
    await teacher.save();
    res.json({ success: true, message: `Class ${className} removed successfully!`, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/teachers/:id — Soft delete
exports.deleteTeacher = async (req, res) => {
  try {
    const teacher = await Teacher.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      { isActive: false },
      { new: true }
    );
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });

    // User account bhi deactivate karo
    if (teacher.userId) {
      await User.findByIdAndUpdate(teacher.userId, { isActive: false });
    }

    res.json({ success: true, message: 'Teacher deactivated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};