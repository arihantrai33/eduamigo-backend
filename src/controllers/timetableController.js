const Timetable = require('../models/Timetable');

// POST /api/timetable — Timetable create
const createTimetable = async (req, res) => {
  try {
    const { class: cls, section, day, periods } = req.body;

    const existing = await Timetable.findOne({ class: cls, section, day });
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Is class ka is din ka timetable already exists' 
      });
    }

    const timetable = await Timetable.create({ class: cls, section, day, periods });
    res.status(201).json({ 
      success: true, 
      message: 'Timetable created successfully!', 
      data: timetable 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/timetable/class/:class — Class ka pura timetable (saare din)
const getClassTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.find({ class: req.params.class })
      .populate('periods.teacher', 'name subjects')
      .sort({ day: 1 });

    if (!timetable.length) {
      return res.status(404).json({ 
        success: false, 
        message: 'Is class ka koi timetable nahi mila' 
      });
    }

    res.status(200).json({ success: true, data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/timetable/class/:class/:day — Class ka ek din ka timetable
const getClassDayTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.findOne({ 
      class: req.params.class,
      day: req.params.day 
    }).populate('periods.teacher', 'name subjects');

    if (!timetable) {
      return res.status(404).json({ 
        success: false, 
        message: 'Timetable not found' 
      });
    }

    res.status(200).json({ success: true, data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/timetable/teacher/:teacherId — Teacher ka apna schedule
const getTeacherTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.find({ 
      'periods.teacher': req.params.teacherId 
    }).sort({ day: 1 });

    // Sirf us teacher ke periods filter karo
    const filtered = timetable.map(day => ({
      class: day.class,
      section: day.section,
      day: day.day,
      periods: day.periods.filter(p => 
        p.teacher && p.teacher.toString() === req.params.teacherId
      )
    }));

    res.status(200).json({ success: true, data: filtered });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/timetable/:id — Timetable update
const updateTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.findByIdAndUpdate(
      req.params.id, 
      { $set: req.body }, 
      { new: true, runValidators: true }
    );
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found' });
    }
    res.status(200).json({ 
      success: true, 
      message: 'Timetable updated successfully!', 
      data: timetable 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/timetable/:id — Timetable delete
const deleteTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.findByIdAndDelete(req.params.id);
    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found' });
    }
    res.status(200).json({ success: true, message: 'Timetable deleted successfully!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { 
  createTimetable, 
  getClassTimetable, 
  getClassDayTimetable,
  getTeacherTimetable,
  updateTimetable,
  deleteTimetable
};