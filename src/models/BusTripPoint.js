const mongoose = require('mongoose');

// A sampled GPS point of a bus trip (about one every 15 seconds), kept for three days so the school can answer
// "where was the bus at 7:45?" and replay a trip. The live position itself is on the Transport document.
const schema = new mongoose.Schema({
  school:   { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  bus:      { type: mongoose.Schema.Types.ObjectId, ref: 'Transport', required: true },
  tripId:   { type: String, required: true },
  lat:      { type: Number, required: true },
  lng:      { type: Number, required: true },
  speedKmh: Number,
  accuracy: Number,
  at:       { type: Date, required: true, expires: 3 * 24 * 60 * 60 },
});
schema.index({ bus: 1, tripId: 1, at: 1 });

module.exports = mongoose.model('BusTripPoint', schema);
