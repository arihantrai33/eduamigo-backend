const mongoose = require('mongoose');
const timetableSchema = new mongoose.Schema({
  school:  { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  class:   { type: String, required: true },
  section: { type: String, required: true },
  day:     { type: String, enum: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], required: true },
  classTeacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  periods: [{
    no:        { type: Number },
    periodNo:  { type: Number },
    subject:   { type: String },
    teacher:   { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    time:      { type: String },
    startTime: { type: String },
    endTime:   { type: String },
  }],
}, { timestamps: true });
timetableSchema.index({ school: 1, class: 1, section: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('Timetable', timetableSchema);
