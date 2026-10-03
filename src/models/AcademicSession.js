const mongoose = require('mongoose');

// A school year, e.g. "2026-27". Exactly one session per school is current; records that belong
// to a year (fees, exams, marks, report cards, enrollments) use its name.
const academicSessionSchema = new mongoose.Schema({
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  name:      { type: String, required: true, trim: true, match: [/^\d{4}-\d{2}$/, 'Session must look like 2026-27'] },
  startDate: { type: Date, required: true },
  endDate:   { type: Date, required: true },
  status:    { type: String, enum: ['upcoming', 'current', 'closed'], default: 'upcoming' },
}, { timestamps: true });

academicSessionSchema.index({ school: 1, name: 1 }, { unique: true });
// At most one current session per school, enforced by the database.
academicSessionSchema.index({ school: 1 }, { unique: true, partialFilterExpression: { status: 'current' }, name: 'one_current_session_per_school' });

module.exports = mongoose.model('AcademicSession', academicSessionSchema);
