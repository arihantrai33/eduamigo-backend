const mongoose = require('mongoose');

// A period stores start and end times; `time` ("09:00 - 09:45") is always derived from them
// so every screen can show one consistent label.
const periodSchema = new mongoose.Schema({
  no:        { type: Number },
  periodNo:  { type: Number },
  subject:   { type: String },
  teacher:   { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  time:      { type: String },
  startTime: { type: String },
  endTime:   { type: String },
});
periodSchema.pre('validate', function setTime() {
  if (this.startTime && this.endTime) this.time = `${this.startTime} - ${this.endTime}`;
});
periodSchema.set('toJSON', {
  transform(doc, ret) {
    if (!ret.time && ret.startTime && ret.endTime) ret.time = `${ret.startTime} - ${ret.endTime}`;
    return ret;
  },
});

const timetableSchema = new mongoose.Schema({
  school:  { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  class:   { type: String, required: true },
  section: { type: String, required: true },
  day:     { type: String, enum: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], required: true },
  classTeacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  periods: [periodSchema],
}, { timestamps: true });
timetableSchema.index({ school: 1, class: 1, section: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('Timetable', timetableSchema);
