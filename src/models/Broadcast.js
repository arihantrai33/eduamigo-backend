const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema({
  teacherId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  teacherName: { type: String, required: true },
  class:       { type: String, required: true },
  section:     { type: String },
  text:        { type: String, required: true },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School' },
}, { timestamps: true });

module.exports = mongoose.model('Broadcast', broadcastSchema);
