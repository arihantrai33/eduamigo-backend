const Parent = require('../models/Parent');
const Student = require('../models/Student');
const User = require('../models/User');
const bcrypt = require('bcryptjs');

const createParent = async (req, res) => {
  try {
    const { name, email, phone, children, gender, address, occupation } = req.body;

    if (!name || !email || !phone) {
      return res.status(400).json({ success: false, message: 'Name, email and phone are required' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(phone, 10);

    const user = await User.create({       // ✅ const added — was missing
      name, email,
      password: hashedPassword,
      role: 'parent',
      school: req.user.school,
    });

    const parent = await Parent.create({
      name, email, phone,
      children: children || [],
      gender, address, occupation,
      school: req.user.school,
      userId: user._id,
    });

    await User.findByIdAndUpdate(user._id, { profileId: parent._id });

    res.status(201).json({
      success: true,
      message: 'Parent created successfully!',
      data: parent,
      loginInfo: {
        email,
        defaultPassword: phone,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ NEW — Parent apna linked child dekhe
const getMyChild = async (req, res) => {
  try {
    const parent = await Parent.findOne({ userId: req.user._id })
      .populate('children', 'name rollNumber class section photo');

    if (!parent) {
      return res.status(404).json({ success: false, message: 'Parent profile not found' });
    }

    if (!parent.children || parent.children.length === 0) {
      return res.status(404).json({ success: false, message: 'No child linked to this parent' });
    }

    res.status(200).json({
      success: true,
      data: {
        parent: {
          name: parent.name,
          email: parent.email,
          phone: parent.phone,
          gender: parent.gender,
          address: parent.address,
          occupation: parent.occupation,
        },
        children: parent.children,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getParentById = async (req, res) => {
  try {
    const parent = await Parent.findById(req.params.parentId)
      .populate('children', 'name rollNumber class section');

    if (!parent) return res.status(404).json({ success: false, message: 'Parent not found' });

    res.status(200).json({ success: true, data: parent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getParentByStudent = async (req, res) => {
  try {
    const parent = await Parent.findOne({ children: req.params.studentId })
      .populate('children', 'name rollNumber class section');

    if (!parent) return res.status(404).json({ success: false, message: 'Parent not found' });

    res.status(200).json({ success: true, data: parent });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getParentDashboard = async (req, res) => {
  try {
    const { studentId } = req.params;
    const student = await Student.findById(studentId)
      .select('name rollNumber class section');

    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    res.status(200).json({
      success: true,
      data: { student, message: 'Use separate APIs for fees, attendance and results' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  createParent,
  getMyChild,        // ✅ exported
  getParentById,
  getParentByStudent,
  getParentDashboard
};