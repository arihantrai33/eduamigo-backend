const Event = require("../models/Event");

const createEvent = async (req, res) => {
  try {
    const event = await Event.create({ ...req.body, createdBy: req.user.id, school: req.user.schoolId });
    res.status(201).json({ success: true, data: event });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getAllEvents = async (req, res) => {
  try {
    const { month, year } = req.query;
    let filter = { school: req.user.schoolId };
    if (month && year) {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0, 23, 59, 59);
      filter.date = { $gte: start, $lte: end };
    }
    const events = await Event.find(filter).sort({ date: 1 });
    res.json({ success: true, data: events });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const updateEvent = async (req, res) => {
  try {
    const event = await Event.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: event });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const deleteEvent = async (req, res) => {
  try {
    await Event.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Deleted" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports = { createEvent, getAllEvents, updateEvent, deleteEvent };
