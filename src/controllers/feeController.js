const Fee = require('../models/Fee');
const Parent = require('../models/Parent');
const Student = require('../models/Student');
const Notification = require('../models/Notification');

const addFee = async (req, res) => {
  try {
    const { studentId, amount, month, year, feeType, dueDate } = req.body;
    if (!studentId || !amount || !month || !year || !dueDate) {
      return res.status(400).json({ success: false, message: 'studentId, amount, month, year and dueDate are required' });
    }
    const fee = await Fee.create({
      studentId, amount, month, year,
      feeType: feeType || 'Tuition',
      dueDate: new Date(dueDate),
      status: 'Unpaid'
    });
    res.status(201).json({ success: true, message: 'Fee record created successfully!', data: fee });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getStudentFees = async (req, res) => {
  try {
    const fees = await Fee.find({ studentId: req.params.studentId }).sort({ year: -1, month: -1 });
    const totalDue  = fees.filter(f => f.status === 'Unpaid').reduce((sum, f) => sum + f.amount, 0);
    const totalPaid = fees.filter(f => f.status === 'Paid').reduce((sum, f) => sum + f.amount, 0);
    res.status(200).json({ success: true, summary: { totalPaid, totalDue }, data: fees });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ NEW — Student apni fees dekhe
const getMyFees = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const fees = await Fee.find({ studentId: student._id }).sort({ year: -1, month: -1 });
    const totalDue  = fees.filter(f => f.status === 'Unpaid').reduce((sum, f) => sum + f.amount, 0);
    const totalPaid = fees.filter(f => f.status === 'Paid').reduce((sum, f) => sum + f.amount, 0);
    const total = totalDue + totalPaid;
    res.status(200).json({
      success: true,
      summary: { total, totalPaid, totalDue },
      data: fees
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const markFeePaid = async (req, res) => {
  try {
    const fee = await Fee.findById(req.params.feeId);
    if (!fee) return res.status(404).json({ success: false, message: 'Fee record not found' });
    fee.status    = 'Paid';
    fee.paidDate  = new Date();
    fee.paidAmount = fee.amount;
    await fee.save();
    const parent = await Parent.findOne({ children: fee.studentId });
    if (parent) {
      const student = await Student.findById(fee.studentId);
      await Notification.create({
        title: 'Fee Payment Confirmed',
        message: `Fee payment of ₹${fee.amount} for ${student?.name || 'your child'} (${fee.month} ${fee.year}) has been received successfully.`,
        targetRole: 'parent',
        targetId: parent._id,
        type: 'Fee'
      });
    }
    res.status(200).json({ success: true, message: 'Fee marked as paid successfully!', data: fee });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getAllPendingFees = async (req, res) => {
  try {
    const fees = await Fee.find({ status: 'Unpaid' }).populate('studentId', 'name rollNumber class');
    res.status(200).json({ success: true, count: fees.length, data: fees });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { addFee, getStudentFees, getMyFees, markFeePaid, getAllPendingFees };