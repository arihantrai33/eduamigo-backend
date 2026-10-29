const mongoose = require('mongoose');

const stopSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  latitude:      { type: Number, required: true },
  longitude:     { type: Number, required: true },
  order:         { type: Number, required: true },
  status:        { type: String, enum: ['Pending', 'Live', 'Departed'], default: 'Pending' },
  estimatedTime: { type: String },
  arrivedAt:     { type: Date },
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
  // Secret used only by the driver app. Never sent to parents or students.
  driverToken:      { type: String, unique: true, required: true },
  // Tracking channel id: live location is published at Firebase path `transport/<trackingId>`.
  // Parents receive this id, which lets them read the location but not act as the driver.
  trackingId:       { type: String, unique: true, sparse: true },
  firebaseKey:      { type: String },
  busStatus:        { type: String, enum: ['Idle', 'On Route', 'Completed'], default: 'Idle' },
  currentStopIndex: { type: Number, default: 0 },
  tripStartedAt:    { type: Date },
  tripEndedAt:      { type: Date },
  // Live tracking (see services/busTracking.js). `direction` is 'pickup' (home to school, stops in order) or 'drop'
  // (school to home, stops reversed). `route` is the road geometry between the stops, built once per trip.
  direction:        { type: String, enum: ['pickup', 'drop'], default: 'pickup' },
  tripId:           { type: String },
  // The phone that started the running trip (a random id the driver page makes once). Readings from any other phone are refused while the
  // trip runs, so two phones with the same driver code cannot feed one bus conflicting positions. Cleared when the trip ends.
  driverDevice:     { type: String },
  route:            { points: { type: [[Number]], default: undefined }, source: String, key: String, meters: Number },
  live: {
    lat: Number, lng: Number, heading: Number, speedKmh: Number, avgKmh: Number, accuracy: Number,
    at: Number,          // when the phone took the reading (ms)
    receivedAt: Number,  // when the server got it (ms)
    routeMeters: Number, offRoute: Boolean,
  },
  // Messages already sent for this trip ("start", "near:<studentId>", "arrived:<studentId>", "end"), so nobody is told twice.
  tripNotices:      [String],
  stops:            [stopSchema],
  assignedStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  boardedStudents:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
}, { timestamps: true });

module.exports = mongoose.model('Transport', transportSchema);