const mongoose = require('mongoose');
const { FEATURE_KEYS } = require('../config/features');

// A sellable plan (Basic, Standard, Premium...). Edited by the platform owner; schools point to it by code.
const planSchema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9_-]{2,30}$/ },
  name:        { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, trim: true, maxlength: 300, default: '' },
  features:    [{ type: String, enum: FEATURE_KEYS }],
  limits: {
    maxStudents:         { type: Number, min: 0, default: null },
    aiQuestionsPerMonth: { type: Number, min: 0, default: null },
  },
  // Price in rupees per active student per academic year. null = not priced yet.
  pricePerStudentYear: { type: Number, min: 0, default: null },
  isActive:    { type: Boolean, default: true },
  sortOrder:   { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);
