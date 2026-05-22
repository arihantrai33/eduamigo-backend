const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true },
  password:  { type: String, required: true },
  role:      { type: String, enum: ['admin', 'teacher', 'student', 'parent', 'driver'], required: true },
  school:    { type: mongoose.Schema.Types.ObjectId, ref: 'School', default: null },
  profileId: { type: mongoose.Schema.Types.ObjectId, default: null },
  isActive:  { type: Boolean, default: true },
  fcmToken:  { type: String, default: null },
}, { timestamps: true });

userSchema.methods.comparePassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);