const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  description: { type: String, default: "" },
  date:        { type: Date, required: true },
  endDate:     { type: Date },
  type:        { type: String, enum: ["holiday", "exam", "ptm", "event", "sports", "other"], default: "event" },
  targetRole:  { type: String, enum: ["all", "student", "teacher", "parent"], default: "all" },
  color:       { type: String, default: "#6366F1" },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  school:      { type: mongoose.Schema.Types.ObjectId, ref: "School" },
}, { timestamps: true });

module.exports = mongoose.model("Event", eventSchema);
