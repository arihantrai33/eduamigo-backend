const Timetable = require('../models/Timetable');
const Student   = require('../models/Student');

const createTimetable = async (req, res) => {
  try {
    const { class: cls, section, day, periods } = req.body;

    const existing = await Timetable.findOne({
      school: req.user.school,
      class: cls,
      section,
      day,
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Is class ka is din ka timetable already exists' });
    }

    const timetable = await Timetable.create({
      school: req.user.school,
      class: cls,
      section,
      day,
      periods,
    });

    res.status(201).json({ success: true, message: 'Timetable created successfully!', data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getClassTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.find({
      school: req.user.school,
      class: req.params.class,
    })
      .populate('periods.teacher', 'name subjects')
      .sort({ day: 1 });

    if (!timetable.length) {
      return res.status(404).json({ success: false, message: 'Is class ka koi timetable nahi mila' });
    }

    res.status(200).json({ success: true, data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getClassDayTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.findOne({
      school: req.user.school,
      class: req.params.class,
      day: req.params.day,
    }).populate('periods.teacher', 'name subjects');

    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found' });
    }

    res.status(200).json({ success: true, data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getTeacherTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.find({
      school: req.user.school,
      'periods.teacher': req.params.teacherId,
    }).sort({ day: 1 });

    const filtered = timetable.map(day => ({
      class:   day.class,
      section: day.section,
      day:     day.day,
      periods: day.periods.filter(p =>
        p.teacher && p.teacher.toString() === req.params.teacherId
      ),
    }));

    res.status(200).json({ success: true, data: filtered });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getMyTimetable = async (req, res) => {
  try {
    const student = await Student.findOne({ userId: req.user._id });
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const { day } = req.query;
    const filter = {
      school:  req.user.school,
      class:   student.class,
      section: student.section,
    };
    if (day) filter.day = day;

    const timetable = await Timetable.find(filter)
      .populate('periods.teacher', 'name')
      .sort({ day: 1 });

    if (day && timetable.length > 0) {
      return res.status(200).json({ success: true, data: timetable[0].periods || [] });
    }

    res.status(200).json({ success: true, data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateTimetable = async (req, res) => {
  try {
    // school override prevent — school field body se nahi aayegi
    const { school, ...updateData } = req.body;

    const timetable = await Timetable.findOneAndUpdate(
      { _id: req.params.id, school: req.user.school },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found' });
    }

    res.status(200).json({ success: true, message: 'Timetable updated successfully!', data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const deleteTimetable = async (req, res) => {
  try {
    const timetable = await Timetable.findOneAndDelete({
      _id: req.params.id,
      school: req.user.school,
    });

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
  getMyTimetable,
  updateTimetable,
  deleteTimetable,
};