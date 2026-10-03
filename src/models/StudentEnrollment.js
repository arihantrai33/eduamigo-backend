const mongoose = require('mongoose');

// One row per student per session: where the student studied that year and how the year ended.
// Student.class/section always hold the current placement; this keeps the history.
const ENROLLMENT_STATUSES = ['studying', 'promoted', 'detained', 'left', 'graduated'];

const studentEnrollmentSchema = new mongoose.Schema({
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  student:    { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  session:    { type: String, required: true },
  class:      { type: String, required: true },
  section:    { type: String, required: true },
  rollNumber: { type: String, default: '' },
  status:     { type: String, enum: ENROLLMENT_STATUSES, default: 'studying' },
  startedAt:  { type: Date, default: Date.now },
  endedAt:    { type: Date, default: null },
  note:       { type: String, maxlength: 300, default: '' },
}, { timestamps: true });

studentEnrollmentSchema.index({ student: 1, session: 1 }, { unique: true });
studentEnrollmentSchema.index({ school: 1, session: 1, class: 1, section: 1 });

module.exports = mongoose.model('StudentEnrollment', studentEnrollmentSchema);
module.exports.ENROLLMENT_STATUSES = ENROLLMENT_STATUSES;
