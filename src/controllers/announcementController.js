const Announcement = require('../models/Announcement');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');

const FIELDS = ['title', 'message', 'targetRole', 'priority', 'isPinned'];

const createAnnouncement = asyncHandler(async (req, res) => {
  const data = pick(req.body, FIELDS);
  if (!data.title || !data.message) throw new HttpError(400, 'Title and message are required');
  const ann = await Announcement.create({ ...data, createdBy: req.user._id, school: req.schoolId });
  res.status(201).json({ success: true, data: ann });
});

const getAllAnnouncements = asyncHandler(async (req, res) => {
  const anns = await Announcement.find({ school: req.schoolId }).populate('createdBy', 'name').sort({ isPinned: -1, createdAt: -1 });
  res.json({ success: true, data: anns });
});

const getMyAnnouncements = asyncHandler(async (req, res) => {
  const anns = await Announcement.find({ school: req.schoolId, targetRole: { $in: ['all', req.user.role] } })
    .sort({ isPinned: -1, createdAt: -1 });
  res.json({ success: true, data: anns });
});

const togglePin = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const ann = await Announcement.findOne({ _id: req.params.id, school: req.schoolId });
  if (!ann) throw new HttpError(404, 'Announcement not found');
  ann.isPinned = !ann.isPinned;
  await ann.save();
  res.json({ success: true, data: ann });
});

const updateAnnouncement = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const ann = await Announcement.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, pick(req.body, FIELDS), { returnDocument: 'after', runValidators: true });
  if (!ann) throw new HttpError(404, 'Announcement not found');
  res.json({ success: true, data: ann });
});

const deleteAnnouncement = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const ann = await Announcement.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!ann) throw new HttpError(404, 'Announcement not found');
  res.json({ success: true, message: 'Deleted' });
});

module.exports = { createAnnouncement, getAllAnnouncements, getMyAnnouncements, togglePin, deleteAnnouncement, updateAnnouncement };
