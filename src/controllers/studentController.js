const Student = require('../models/Student');
const User = require('../models/User');
const bcrypt = require('bcryptjs');

exports.getStudents = async (req, res) => {
  try {
    const { class: cls, section, search } = req.query;
    let query = { isActive: true, school: req.user.school };
    if (cls) query.class = cls;
    if (section) query.section = section;
    if (search) query.name = { $regex: search, $options: 'i' };
    const students = await Student.find(query).sort({ createdAt: -1 });
    res.json({ success: true, count: students.length, data: students });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getStudent = async (req, res) => {
  try {
    const student = await Student.findOne({ _id: req.params.id, school: req.user.school });
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, data: student });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.createStudent = async (req, res) => {
  let user = null;
  try {
    const {
      name, email, phone, rollNumber, class: cls, section,
      gender, dateOfBirth, address, parentName, parentPhone, feeStatus
    } = req.body;

    // Student ka User account bhi banao (login ke liye)
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(phone, 10); // default password = phone number
    user = await User.create({
      name, email,
      password: hashedPassword,
      role: 'student',
      school: req.user.school,
    });

    const student = await Student.create({
      name, email, phone, rollNumber,
      class: cls, section, gender, dateOfBirth,
      address, parentName, parentPhone,
      feeStatus: feeStatus || 'Pending',
      school: req.user.school,
      userId: user._id,
    });

    // User ke profileId mein student ka id save karo
    await User.findByIdAndUpdate(user._id, { profileId: student._id });

    res.status(201).json({ success: true, data: student });
  } catch (err) {
    if (user) await User.findByIdAndDelete(user._id);
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.updateStudent = async (req, res) => {
  try {
    const student = await Student.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      req.body,
      { new: true, runValidators: true }
    );
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, data: student });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

exports.deleteStudent = async (req, res) => {
  try {
    const student = await Student.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      { isActive: false },
      { new: true }
    );
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });
    // Student ka user account bhi deactivate karo
    if (student.userId) {
      await User.findByIdAndUpdate(student.userId, { isActive: false });
    }
    res.json({ success: true, message: 'Student deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};