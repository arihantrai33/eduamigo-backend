const mongoose = require("mongoose");
const staffLeaveSchema = new mongoose.Schema({
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  leaveType:   { type: String, enum: ["Sick", "Casual", "Earned", "Maternity", "Other"], required: true },
  fromDate:    { type: Date, required: true },
  toDate:      { type: Date, required: true },
  days:        { type: Number },
  reason:      { type: String },
  status:      { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending" },
  approvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  remarks:     { type: String },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: "School" },
}, { timestamps: true });
staffLeaveSchema.pre("save", function(next) {
  if (this.fromDate && this.toDate) {
    const diff = (new Date(this.toDate) - new Date(this.fromDate)) / (1000*60*60*24);
    this.days = Math.floor(diff) + 1;
  }
  next();
});
module.exports = mongoose.model("StaffLeave", staffLeaveSchema);
