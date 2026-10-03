const mongoose = require('mongoose');

// The school's list of classes, their sections, subjects and class teachers.
// Once a school has set this up, students and teachers can only be placed in classes that exist here.
// Values use the canonical form from utils/classes.js: class "10", section "A".
const sectionSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true, uppercase: true, maxlength: 10 },
  classTeacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },
  capacity:     { type: Number, min: 1, max: 500, default: null },
}, { _id: false });

const schoolClassSchema = new mongoose.Schema({
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  name:        { type: String, required: true, trim: true, maxlength: 20 },        // "10", "LKG", "11 Science"
  displayName: { type: String, trim: true, maxlength: 40, default: '' },         // "Class 10"
  order:       { type: Number, default: 0 },                                      // for sorting: Nursery < LKG < 1 ... < 12
  sections:    { type: [sectionSchema], default: [] },
  subjects:    [{ type: String, trim: true, maxlength: 60 }],
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

schoolClassSchema.index({ school: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SchoolClass', schoolClassSchema);
