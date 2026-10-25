const mongoose = require('mongoose');

// Who teaches what, where: one row per teacher, class (and section), and subject. This replaces guessing from two separate lists
// on the teacher (classes, subjects), which allowed every combination of the two: a teacher of Maths in 10-A and English in 9-B
// could mark English in 10-A. A teacher with no rows here still falls back to those lists (services/teaching.js), so schools
// move over one teacher at a time.
const teachingAssignmentSchema = new mongoose.Schema({
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  teacher:  { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  class:    { type: String, required: true, trim: true },
  section:  { type: String, default: '', trim: true },   // '' = every section of the class
  subject:  { type: String, required: true, trim: true },
  isClassTeacher: { type: Boolean, default: false },      // class teacher of this class-section (informational: shown on the profile)
}, { timestamps: true });

teachingAssignmentSchema.index({ school: 1, teacher: 1, class: 1, section: 1, subject: 1 }, { unique: true });
teachingAssignmentSchema.index({ school: 1, class: 1, section: 1 });

module.exports = mongoose.model('TeachingAssignment', teachingAssignmentSchema);
