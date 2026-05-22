const mongoose = require('mongoose');

const parentSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  email:      { type: String, required: true, unique: true },
  phone:      { type: String, required: true },
  children:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  gender:     { type: String, enum: ['Male', 'Female', 'Other'] },
  address:    { type: String },
  occupation: { type: String },
  photo:      { type: String },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  isActive:   { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Parent', parentSchema);