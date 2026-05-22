const LeaveRequest = require('../models/LeaveRequest');
const Notification = require('../models/Notification');
const Student = require('../models/Student');

// POST /api/leaves/apply — Student, Parent, ya Teacher apply kare
const applyLeave = async (req, res) => {
  try {
    const { requestedBy, role, name, leaveType, fromDate, toDate, reason } = req.body;

    const leave = await LeaveRequest.create({
      requestedBy,
      role,
      name,
      class: role === 'student' ? req.body.class : undefined,
      leaveType: leaveType || 'Personal',
      fromDate,
      toDate,
      reason,
      status: 'Pending'
    });

    // Agar student ne apply kiya toh parent ko notification
    if (role === 'student') {
      const student = await Student.findById(requestedBy);
      if (student && student.parentId) {
        await Notification.create({
          userId: student.parentId,
          message: `Leave request submitted for ${name} from ${new Date(fromDate).toDateString()} to ${new Date(toDate).toDateString()}. Status: Pending.`
        });
      }
    }

    res.status(201).json({
      success: true,
      message: 'Leave request submitted successfully!',
      data: leave
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/leaves/my/:requestedBy — Apni leaves dekho
const getMyLeaves = async (req, res) => {
  try {
    const leaves = await LeaveRequest.find({ requestedBy: req.params.requestedBy })
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/leaves — Saari leaves (Admin only)
const getAllLeaves = async (req, res) => {
  try {
    const leaves = await LeaveRequest.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: leaves.length, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/leaves/pending — Sirf pending leaves (Admin/Teacher)
const getAllPendingLeaves = async (req, res) => {
  try {
    const leaves = await LeaveRequest.find({ status: 'Pending' }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: leaves.length, data: leaves });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/leaves/:id/review — Admin/Teacher approve ya reject kare
const reviewLeave = async (req, res) => {
  try {
    const { status, reviewNote } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Approved or Rejected' });
    }

    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) {
      return res.status(404).json({ success: false, message: 'Leave request not found' });
    }

    // Already reviewed check
    if (leave.status !== 'Pending') {
      return res.status(400).json({ success: false, message: 'Leave already reviewed' });
    }

    leave.status = status;
    leave.reviewNote = reviewNote || '';
    leave.reviewedBy = req.user.id;
    leave.reviewedAt = new Date();
    await leave.save();

    // Parent ko notification agar student ki leave hai
    if (leave.role === 'student') {
      const student = await Student.findById(leave.requestedBy);
      if (student && student.parentId) {
        await Notification.create({
          userId: student.parentId,
          message: `Leave request for ${leave.name} has been ${status}. ${reviewNote ? 'Note: ' + reviewNote : ''}`
        });
      }
    }

    res.status(200).json({
      success: true,
      message: `Leave ${status} successfully!`,
      data: leave
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/leaves/:id — Sirf Admin, sirf Approved/Rejected
const deleteLeave = async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) {
      return res.status(404).json({ success: false, message: 'Leave request not found' });
    }

    // ❌ Pending leave delete nahi hogi kisi ke liye bhi
    if (leave.status === 'Pending') {
      return res.status(403).json({
        success: false,
        message: 'Pending leave cannot be deleted. Wait for approval or rejection first.'
      });
    }

    await LeaveRequest.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Leave deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  applyLeave,
  getMyLeaves,
  getAllLeaves,
  getAllPendingLeaves,
  reviewLeave,
  deleteLeave
};