const mongoose = require('mongoose');

const parentSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  email:      { type: String, set: (v) => (v ? String(v).trim().toLowerCase() : undefined) },
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

parentSchema.index({ school: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'school_email_unique_when_set' });
parentSchema.index({ children: 1 });

module.exports = mongoose.model('Parent', parentSchema);