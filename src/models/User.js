const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { normalizePhone } = require('../utils/phone');

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  // Required for staff. Students sign in with their admission number and parents with their mobile,
  // so for them email is optional. Unique across the platform when present.
  email:     { type: String, set: (v) => (v ? String(v).trim().toLowerCase() : undefined) },
  password:  { type: String, required: true },
  // superadmin = EduAmigo platform owner/staff: no school, signs in only at /api/platform.
  role:      { type: String, enum: ['superadmin', 'admin', 'accountant', 'teacher', 'student', 'parent', 'driver'], required: true },
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  profileId: { type: mongoose.Schema.Types.ObjectId, default: null },
  isActive:  { type: Boolean, default: true },
  fcmToken:  { type: String, default: null },
  phone:     { type: String, default: null },
  // Last 10 digits of phone, kept in sync automatically; used for mobile-number sign-in.
  loginPhone: { type: String, default: null },
  // Raised to sign the user out of every device (logout-all, password reset). Tokens carry it as `v`.
  tokenVersion: { type: Number, default: 0 },
  mustChangePassword: { type: Boolean, default: false },
  passwordChangedAt:  { type: Date, default: null },
  lastLoginAt:        { type: Date, default: null },
}, { timestamps: true });

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'email_unique_when_set' });
userSchema.index({ school: 1, loginPhone: 1 });

const STAFF_ROLES = ['superadmin', 'admin', 'accountant', 'teacher'];

userSchema.pre('validate', function syncLoginFields() {
  if (this.isModified('phone') || this.isNew) this.loginPhone = this.phone ? normalizePhone(this.phone) || null : null;
  if (!this.email && STAFF_ROLES.includes(this.role)) this.invalidate('email', 'Email is required for staff accounts');
});

userSchema.methods.comparePassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
