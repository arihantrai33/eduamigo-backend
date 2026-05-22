const mongoose = require('mongoose');

const timetableSchema = new mongoose.Schema({
  class:    { type: String, required: true },
  section:  { type: String, required: true },
  day:      { type: String, enum: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], required: true },
  
  periods: [{
    periodNo:  { type: Number },
    subject:   { type: String },
    teacher:   { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    startTime: { type: String }, // e.g. "09:00"
    endTime:   { type: String }, // e.g. "09:45"
  }],
}, { timestamps: true });

module.exports = mongoose.model('Timetable', timetableSchema);