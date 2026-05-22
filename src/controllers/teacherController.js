const Teacher = require('../models/Teacher');

// GET /api/teachers — Saare teachers (subject/search filter)
exports.getTeachers = async (req, res) => {
  try {
    const { subject, search } = req.query;
    let query = { isActive: true };

    if (subject) query.subjects = subject;
    if (search) query.name = { $regex: search, $options: 'i' };

    const teachers = await Teacher.find(query).sort({ name: 1 });
    res.json({ success: true, count: teachers.length, data: teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/teachers/:id — Ek teacher
exports.getTeacher = async (req, res) => {
  try {
    const teacher = await Teacher.findById(req.params.id);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }
    res.json({ success: true, data: teacher });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/teachers/class/:class — Class ke teachers
exports.getTeachersByClass = async (req, res) => {
  try {
    const teachers = await Teacher.find({ 
      assignedClasses: req.params.class,
      isActive: true 
    });
    res.json({ success: true, count: teachers.length, data: teachers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/teachers — Teacher create
exports.createTeacher = async (req, res) => {
  let user = null;
  try {
    // Duplicate check
    const existing = await Teacher.findOne({
      $or: [{ email: req.body.email }, { employeeId: req.body.employeeId }]
    });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email ya Employee ID already exists' 
      });
    }

    const teacher = await Teacher.create(req.body);
    res.status(201).json({ 
      success: true, 
      message: 'Teacher added successfully!', 
      data: teacher 
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PUT /api/teachers/:id — Teacher update
exports.updateTeacher = async (req, res) => {
  try {
    const teacher = await Teacher.findByIdAndUpdate(
      req.params.id, 
      req.body, 
      { new: true, runValidators: true }
    );
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }
    res.json({ 
      success: true, 
      message: 'Teacher updated successfully!', 
      data: teacher 
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// PATCH /api/teachers/:id/assign-class — Class assign
exports.assignClass = async (req, res) => {
  try {
    const { className } = req.body;
    const teacher = await Teacher.findById(req.params.id);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }
    if (teacher.assignedClasses.includes(className)) {
      return res.status(400).json({ 
        success: false, 
        message: `Class ${className} already assigned` 
      });
    }
    teacher.assignedClasses.push(className);
    await teacher.save();
    res.json({ 
      success: true, 
      message: `Class ${className} assigned successfully!`, 
      data: teacher 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/teachers/:id/remove-class — Class remove
exports.removeClass = async (req, res) => {
  try {
    const { className } = req.body;
    const teacher = await Teacher.findById(req.params.id);
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }
    teacher.assignedClasses = teacher.assignedClasses.filter(c => c !== className);
    await teacher.save();
    res.json({ 
      success: true, 
      message: `Class ${className} removed successfully!`, 
      data: teacher 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/teachers/:id — Soft delete
exports.deleteTeacher = async (req, res) => {
  try {
    const teacher = await Teacher.findByIdAndUpdate(
      req.params.id, 
      { isActive: false }, 
      { new: true }
    );
    if (!teacher) {
      return res.status(404).json({ success: false, message: 'Teacher not found' });
    }
    res.json({ success: true, message: 'Teacher deactivated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};