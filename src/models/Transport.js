const mongoose = require('mongoose');

const stopSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  latitude:      { type: Number, required: true },
  longitude:     { type: Number, required: true },
  order:         { type: Number, required: true },
  status:        { type: String, enum: ['Pending', 'Live', 'Departed'], default: 'Pending' },
  estimatedTime: { type: String },
  departedAt:    { type: Date },
});

const transportSchema = new mongoose.Schema({
  school:           { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  busNumber:        { type: String, required: true },
  driverName:       { type: String, required: true },
  driverPhone:      { type: String, required: true },
  routeName:        { type: String, required: true },
  capacity:         { type: Number, default: 40 },
  availableSeats:   { type: Number, default: 40 },
  driverToken:      { type: String, unique: true },
  firebaseKey:      { type: String, unique: true },
  busStatus:        { type: String, enum: ['Idle', 'On Route', 'Completed'], default: 'Idle' },
  currentStopIndex: { type: Number, default: 0 },
  tripStartedAt:    { type: Date },
  tripEndedAt:      { type: Date },
  stops:            [stopSchema],
  assignedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  boardedStudents:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
}, { timestamps: true });

module.exports = mongoose.model('Transport', transportSchema);