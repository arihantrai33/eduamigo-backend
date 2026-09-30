const mongoose = require('mongoose');

const staffLeaveSchema = new mongoose.Schema({
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  leaveType:   { type: String, enum: ['Sick', 'Casual', 'Earned', 'Maternity', 'Other'], required: true },
  fromDate:    { type: Date, required: true },
  toDate:      { type: Date, required: true },
  days:        { type: Number },
  reason:      { type: String },
  status:      { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  remarks:     { type: String },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
}, { timestamps: true });

staffLeaveSchema.statics.countDays = (from, to) => {
  const diff = (new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24);
  return Math.floor(diff) + 1;
};

// Mongoose 9 no longer passes `next` to middleware; a plain sync function is required.
staffLeaveSchema.pre('save', function computeDays() {
  if (this.fromDate && this.toDate) {
    this.days = this.constructor.countDays(this.fromDate, this.toDate);
  }
});

module.exports = mongoose.model('StaffLeave', staffLeaveSchema);
