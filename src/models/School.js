const mongoose = require('mongoose');

const schoolSchema = new mongoose.Schema({
  name:           { type: String, required: true },
  address:        { type: String, default: '' },
  phone:          { type: String, default: '' },
  email:          { type: String, default: '' },
  isActive:       { type: Boolean, default: true },
  customSubjects: [{ type: String }],
  principal:      { type: String, default: '' },
  workingDays:    { type: String, enum: ['Monday - Saturday', 'Monday - Friday'], default: 'Monday - Saturday' },
  // School gate location, used as the final stop on bus maps.
  location: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
}, { timestamps: true });

module.exports = mongoose.model('School', schoolSchema);