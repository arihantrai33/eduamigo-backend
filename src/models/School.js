const mongoose = require('mongoose');

const schoolSchema = new mongoose.Schema({
  name:           { type: String, required: true },
  address:        { type: String, default: '' },
  phone:          { type: String, default: '' },
  email:          { type: String, default: '' },
  isActive:       { type: Boolean, default: true },
  customSubjects: [{ type: String }],
}, { timestamps: true });

module.exports = mongoose.model('School', schoolSchema);