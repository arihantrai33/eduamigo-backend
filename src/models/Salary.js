const mongoose = require("mongoose");
const salarySchema = new mongoose.Schema({
  teacher:     { type: mongoose.Schema.Types.ObjectId, ref: "Teacher", required: true },
  month:       { type: Number, required: true },
  year:        { type: Number, required: true },
  basicSalary: { type: Number, required: true },
  allowances:  { type: Number, default: 0 },
  deductions:  { type: Number, default: 0 },
  netSalary:   { type: Number },
  status:      { type: String, enum: ["Pending", "Paid"], default: "Pending" },
  paidOn:      { type: Date },
  remarks:     { type: String },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: "School" },
}, { timestamps: true });
salarySchema.pre("save", function(next) {
  this.netSalary = this.basicSalary + this.allowances - this.deductions;
  next();
});
module.exports = mongoose.model("Salary", salarySchema);
