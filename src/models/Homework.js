const mongoose = require('mongoose');

// Homework given by a teacher (or the office) to a class, to some students of a class, or to one student.
//   audience 'class'    : every active student of the class (and the section, when one is named)
//   audience 'students' : only the students listed in `students` (one or several), all from that class
const homeworkSchema = new mongoose.Schema({
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  title:       { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 4000, default: '' },
  subject:     { type: String, required: true, trim: true, maxlength: 80 },
  class:       { type: String, required: true },
  section:     { type: String, default: '' }, // empty = every section of the class
  audience:    { type: String, enum: ['class', 'students'], default: 'class' },
  students:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  dueDate:     { type: Date, required: true },
  attachments: [new mongoose.Schema({ key: String, name: String, type: { type: String }, size: Number, kind: String }, { _id: false })],
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  teacherName: { type: String, default: '' },
}, { timestamps: true });

homeworkSchema.index({ school: 1, class: 1, section: 1, dueDate: -1 });
homeworkSchema.index({ school: 1, createdBy: 1, createdAt: -1 });
homeworkSchema.index({ school: 1, students: 1 });

module.exports = mongoose.model('Homework', homeworkSchema);
