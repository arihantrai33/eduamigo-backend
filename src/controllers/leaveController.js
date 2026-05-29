const LeaveRequest = require('../models/LeaveRequest');
const Notification = require('../models/Notification');
const Student = require('../models/Student');

const LEAVE_QUOTA = 12;

// POST /api/leaves/apply
const applyLeave = async (req, res) => {
  try {
    const { leaveType, fromDate, toDate, reason } = req.body;
    const user = req.user;

    if (!fromDate || !toDate || !reason || !leaveType) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    if (new Date(toDate) < new Date(fromDate)) {
      return res.status(400).json({ success: false, message: 'End date cannot be before start date.' });
    }

    const leave = await LeaveRequest.create({
      requestedBy: user._id,
      role: user.role,
      name: user.name,
      class: user.role === 'student' ? user.class : undefined,
      leaveType,
      fromDate,
      toDate,
      reason,
      status: 'Pending',
    });

    if (user.role === 'student') {
      const student = await Student.findById(user._id);
      if (student && student.parentId) {
        try {
          await Notification.create({
            userId: student.parentId,
            message: `Leave request submitted for ${user.name} from ${new Date(fromDate).toDateString()} to ${new Date(toDate).toDateString()}. Status: Pending.`,
          });
        } catch (notifErr) {
          console.log('Notification failed:', notifErr.message);
        }
      }

    res.status(201).json({ success: true, message: 'Leave request submitted successfully!', data: leave });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/leaves/my — Auth user ki apni leaves
const getMyLeaves = async (req, res) => {
  try {
    const leaves = await LeaveRequest.find({ requestedBy: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/leaves/quota — Leave balance
const getMyQuota = async (req, res) => {
  try {
    const used = await LeaveRequest.countDocuments({
      requestedBy: req.user._id,
      status: 'Approved',
    });
    res.status(200).json({
      success: true,
      data: { total: LEAVE_QUOTA, used, available: LEAVE_QUOTA - used },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/leaves — Admin only
const getAllLeaves = async (req, res) => {
  try {
    const leaves = await LeaveRequest.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: leaves.length, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/leaves/pending — Admin/Teacher
const getAllPendingLeaves = async (req, res) => {
  try {
    const leaves = await LeaveRequest.find({ status: 'Pending' }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: leaves.length, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/leaves/:id/review
const reviewLeave = async (req, res) => {
  try {
    const { status, reviewNote } = req.body;
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Approved or Rejected' });
    }
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    if (leave.status !== 'Pending') {
      return res.status(400).json({ success: false, message: 'Leave already reviewed' });
    }
    leave.status = status;
    leave.reviewNote = reviewNote || '';
    leave.reviewedBy = req.user._id;
    leave.reviewedAt = new Date();
    await leave.save();

    if (leave.role === 'student') {
      const student = await Student.findById(leave.requestedBy);
      if (student && student.parentId) {
        await Notification.create({
          userId: student.parentId,
          message: `Leave request for ${leave.name} has been ${status}.${reviewNote ? ' Note: ' + reviewNote : ''}`,
        });
      }
    }

    res.status(200).json({ success: true, message: `Leave ${status} successfully!`, data: leave });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/leaves/:id — Admin only, non-pending
const deleteLeave = async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    if (leave.status === 'Pending') {
      return res.status(403).json({ success: false, message: 'Pending leave cannot be deleted.' });
    }
    await LeaveRequest.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Leave deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { applyLeave, getMyLeaves, getMyQuota, getAllLeaves, getAllPendingLeaves, reviewLeave, deleteLeave };