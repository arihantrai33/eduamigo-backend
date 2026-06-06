const mongoose = require("mongoose");
const bulkUploadSchema = new mongoose.Schema({
  type:       { type: String, enum: ["students", "teachers"], required: true },
  fileName:   { type: String },
  totalRows:  { type: Number, default: 0 },
  success:    { type: Number, default: 0 },
  failed:     { type: Number, default: 0 },
  errors:     [{ row: Number, message: String }],
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  school:     { type: mongoose.Schema.Types.ObjectId, ref: "School" },
}, { timestamps: true });
module.exports = mongoose.model("BulkUpload", bulkUploadSchema);
