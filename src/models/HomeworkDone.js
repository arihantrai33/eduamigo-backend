const mongoose = require('mongoose');

// A student saying "I have done this homework". One row per homework and student.
const schema = new mongoose.Schema({
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  homework: { type: mongoose.Schema.Types.ObjectId, ref: 'Homework', required: true },
  student:  { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  doneAt:   { type: Date, default: Date.now },
}, { timestamps: true });

schema.index({ homework: 1, student: 1 }, { unique: true });
schema.index({ school: 1, student: 1 });

module.exports = mongoose.model('HomeworkDone', schema);
