const mongoose = require('mongoose');
const { FEATURE_KEYS } = require('../config/features');

// Price of a feature bought on top of a plan. One document per feature.
const addOnSchema = new mongoose.Schema({
  feature:             { type: String, required: true, unique: true, enum: FEATURE_KEYS },
  // Rupees per active student per academic year, or a flat yearly amount per school.
  pricePerStudentYear: { type: Number, min: 0, default: null },
  flatPricePerYear:    { type: Number, min: 0, default: null },
  isActive:            { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('AddOn', addOnSchema);
