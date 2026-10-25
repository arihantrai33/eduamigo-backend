const { can } = require('../services/authorization');
const Event = require('../models/Event');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');

const FIELDS = ['title', 'description', 'date', 'endDate', 'type', 'targetRole', 'color'];

const createEvent = asyncHandler(async (req, res) => {
  const data = pick(req.body, FIELDS);
  if (!data.title || !data.date) throw new HttpError(400, 'Title and date are required');
  if (data.endDate && new Date(data.endDate) < new Date(data.date)) throw new HttpError(400, 'End date cannot be before start date');
  const event = await Event.create({ ...data, createdBy: req.user._id, school: req.schoolId });
  res.status(201).json({ success: true, data: event });
});

// Everyone in the school can read the calendar; non-admins only see events targeted to them.
const getAllEvents = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (!can(req.user, 'communication.manage')) filter.targetRole = { $in: ['all', req.user.role] };
  const { month, year } = req.query;
  if (month && year) {
    const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
    const end = new Date(Date.UTC(Number(year), Number(month), 1));
    filter.$or = [{ date: { $gte: start, $lt: end } }, { date: { $lt: start }, endDate: { $gte: start } }];
  }
  const events = await Event.find(filter).sort({ date: 1 });
  res.json({ success: true, data: events });
});

const updateEvent = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const event = await Event.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, pick(req.body, FIELDS), { returnDocument: 'after', runValidators: true });
  if (!event) throw new HttpError(404, 'Event not found');
  res.json({ success: true, data: event });
});

const deleteEvent = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const event = await Event.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!event) throw new HttpError(404, 'Event not found');
  res.json({ success: true, message: 'Deleted' });
});

module.exports = { createEvent, getAllEvents, updateEvent, deleteEvent };
