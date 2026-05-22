const mongoose = require('mongoose');

const examResultSchema = new mongoose.Schema({
  student:    { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  teacher:    { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
  
  examName:   { type: String, required: true }, // e.g. "Mid Term 2026"
  subject:    { type: String, required: true },
  class:      { type: String, required: true },
  section:    { type: String },
  
  totalMarks: { type: Number, required: true },
  marksObtained: { type: Number, required: true },
  grade:      { type: String }, // A, B, C etc.
  percentage: { type: Number },
  
  examDate:   { type: Date },
  remarks:    { type: String },
}, { timestamps: true });

module.exports = mongoose.model('ExamResult', examResultSchema);