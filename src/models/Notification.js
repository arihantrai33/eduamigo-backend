const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title:    { type: String, required: true },
  message:  { type: String, required: true },
  
  // Kisko dikhana hai
  targetRole: { type: String, enum: ['all', 'student', 'teacher', 'parent', 'driver'], default: 'all' },
  targetId:   { type: mongoose.Schema.Types.ObjectId }, // specific user ko
  
  type:     { type: String, enum: ['Info', 'Alert', 'Fee', 'Exam', 'Leave', 'General'], default: 'General' },
  isRead:   { type: Boolean, default: false },
  
  sentBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Notification', notificationSchema);