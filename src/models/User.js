const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  // superadmin = EduAmigo platform owner/staff: no school, signs in only at /api/platform.
  role:      { type: String, enum: ['superadmin', 'admin', 'accountant', 'teacher', 'student', 'parent', 'driver'], required: true },
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  profileId: { type: mongoose.Schema.Types.ObjectId, default: null },
  isActive:  { type: Boolean, default: true },
  fcmToken:  { type: String, default: null },
  phone:     { type: String, default: null },
  mustChangePassword: { type: Boolean, default: false },
  passwordChangedAt:  { type: Date, default: null },
  lastLoginAt:        { type: Date, default: null },
}, { timestamps: true });

userSchema.methods.comparePassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
