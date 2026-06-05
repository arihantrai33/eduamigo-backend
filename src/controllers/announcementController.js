const Announcement = require('../models/Announcement');

// Create
const createAnnouncement = async (req, res) => {
  try {
    const { title, message, targetRole, priority, isPinned } = req.body;
    const ann = await Announcement.create({
      title, message,
      targetRole: targetRole || 'all',
      priority: priority || 'normal',
      isPinned: isPinned || false,
      createdBy: req.user.id,
      school: req.user.schoolId,
    });
    res.status(201).json({ success: true, data: ann });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Get all (admin)
const getAllAnnouncements = async (req, res) => {
  try {
    const anns = await Announcement.find({ school: req.user.schoolId })
      .populate('createdBy', 'name')
      .sort({ isPinned: -1, createdAt: -1 });
    res.json({ success: true, data: anns });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Get by role (for student/teacher/parent portals)
const getMyAnnouncements = async (req, res) => {
  try {
    const role = req.user.role;
    const anns = await Announcement.find({
      school: req.user.schoolId,
      $or: [{ targetRole: 'all' }, { targetRole: role }]
    }).sort({ isPinned: -1, createdAt: -1 });
    res.json({ success: true, data: anns });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Toggle pin
const togglePin = async (req, res) => {
  try {
    const ann = await Announcement.findById(req.params.id);
    if (!ann) return res.status(404).json({ success: false, message: 'Not found' });
    ann.isPinned = !ann.isPinned;
    await ann.save();
    res.json({ success: true, data: ann });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Delete
const deleteAnnouncement = async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

// Update
const updateAnnouncement = async (req, res) => {
  try {
    const ann = await Announcement.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: ann });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports = { createAnnouncement, getAllAnnouncements, getMyAnnouncements, togglePin, deleteAnnouncement, updateAnnouncement };
