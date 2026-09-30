const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Transport = require('../models/Transport');
const Student = require('../models/Student');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');
const { studentForUser, resolveChild } = require('../services/directory');

// Driver token: long random secret (hard to guess), still easy to type from a card: "BUS12-8F3K-9QZ2-..."
const makeDriverToken = (busNumber) => {
  const clean = String(busNumber).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  return `${clean}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
};
const makeTrackingId = () => crypto.randomBytes(12).toString('hex');
const firebasePathFor = (bus) => bus.trackingId;

// Buses created before tracking ids existed get one the first time they are used,
// so the secret driver token is never handed out as a tracking path.
async function ensureTracking(bus) {
  if (!bus.trackingId) {
    bus.trackingId = makeTrackingId();
    bus.firebaseKey = `transport/${bus.trackingId}`;
    await Transport.updateOne({ _id: bus._id }, { trackingId: bus.trackingId, firebaseKey: bus.firebaseKey });
  }
  return bus;
}

function firebaseDb() {
  // Loaded lazily so the API can run (and be tested) without Firebase credentials.
  return require('../config/firebase').db;
}

async function publish(bus, data) {
  try {
    await firebaseDb().ref(`transport/${firebasePathFor(bus)}`).update({ ...data, updatedAt: Date.now() });
  } catch (err) {
    console.error('Firebase update failed:', err.message);
  }
}

// ---------------- Parent / student ----------------

// GET /api/transport/my-child-bus?studentId=
router.get('/my-child-bus', protect, authorizeRoles('student', 'parent'), asyncHandler(async (req, res) => {
  const student = req.user.role === 'student'
    ? await studentForUser(req.user)
    : (await resolveChild(req.user, req.query.studentId)).child;
  if (!student) throw new HttpError(404, 'No student linked to this account');
  if (!student.bus) throw new HttpError(404, 'No bus assigned');

  const bus = await Transport.findOne({ _id: student.bus, school: req.schoolId })
    .select('busNumber driverName driverPhone routeName busStatus stops currentStopIndex trackingId');
  if (!bus) throw new HttpError(404, 'No bus assigned');
  await ensureTracking(bus);

  res.json({
    success: true,
    data: {
      _id: bus._id,
      busNumber: bus.busNumber,
      driverName: bus.driverName,
      driverPhone: bus.driverPhone,
      routeName: bus.routeName,
      busStatus: bus.busStatus,
      firebasePath: firebasePathFor(bus),
      stops: bus.stops,
      currentStopIndex: bus.currentStopIndex,
      studentName: student.name,
      studentClass: `Class ${student.class}${student.section ? `-${student.section}` : ''}`,
    },
  });
}));

// ---------------- Admin ----------------

const BUS_FIELDS = ['busNumber', 'driverName', 'driverPhone', 'routeName', 'capacity'];

router.get('/', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  const buses = await Transport.find({ school: req.schoolId }).populate('assignedStudents', 'name rollNumber class section');
  res.json({ success: true, data: buses });
}));

router.post('/', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  const data = pick(req.body, BUS_FIELDS);
  if (!data.busNumber || !data.driverName || !data.driverPhone || !data.routeName) {
    throw new HttpError(400, 'Bus number, driver name, driver phone and route name are required');
  }
  data.busNumber = String(data.busNumber).trim();
  if (await Transport.exists({ busNumber: data.busNumber, school: req.schoolId })) throw new HttpError(409, 'Bus number already exists');
  const capacity = Number(data.capacity) || 40;
  const trackingId = makeTrackingId();
  const bus = await Transport.create({
    ...data, capacity, availableSeats: capacity, school: req.schoolId,
    driverToken: makeDriverToken(data.busNumber), trackingId, firebaseKey: `transport/${trackingId}`,
    stops: Array.isArray(req.body.stops) ? req.body.stops : [],
  });
  res.status(201).json({ success: true, data: bus });
}));

router.get('/students', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  const students = await Student.find({ school: req.schoolId, isActive: true })
    .select('name rollNumber class section bus').populate('bus', 'busNumber');
  res.json({ success: true, data: students });
}));

router.put('/:id', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const bus = await Transport.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, pick(req.body, BUS_FIELDS), { returnDocument: 'after', runValidators: true });
  if (!bus) throw new HttpError(404, 'Bus not found');
  res.json({ success: true, data: bus });
}));

// POST /api/transport/:id/regenerate-token — use when a driver leaves or a token card is lost
router.post('/:id/regenerate-token', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const bus = await Transport.findOne({ _id: req.params.id, school: req.schoolId });
  if (!bus) throw new HttpError(404, 'Bus not found');
  bus.driverToken = makeDriverToken(bus.busNumber);
  if (!bus.trackingId) { bus.trackingId = makeTrackingId(); bus.firebaseKey = `transport/${bus.trackingId}`; }
  await bus.save();
  res.json({ success: true, data: { driverToken: bus.driverToken } });
}));

router.put('/:id/stops', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const stops = Array.isArray(req.body?.stops) ? req.body.stops : [];
  for (const s of stops) {
    if (!s.name || !Number.isFinite(Number(s.latitude)) || !Number.isFinite(Number(s.longitude))) {
      throw new HttpError(400, 'Every stop needs a name, latitude and longitude');
    }
  }
  const bus = await Transport.findOneAndUpdate(
    { _id: req.params.id, school: req.schoolId },
    { stops: stops.map((s, i) => ({ ...s, order: s.order ?? i + 1 })) },
    { returnDocument: 'after', runValidators: true },
  );
  if (!bus) throw new HttpError(404, 'Bus not found');
  res.json({ success: true, data: bus });
}));

router.put('/:id/assign-students', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const ids = Array.isArray(req.body?.studentIds) ? req.body.studentIds.map(String) : [];
  ids.forEach((id) => assertId(id, 'student id'));
  const bus = await Transport.findOne({ _id: req.params.id, school: req.schoolId });
  if (!bus) throw new HttpError(404, 'Bus not found');
  const students = await Student.find({ _id: { $in: ids }, school: req.schoolId }).select('_id');
  if (students.length !== ids.length) throw new HttpError(400, 'One or more students do not belong to your school');
  if (ids.length > bus.capacity) throw new HttpError(400, `This bus has only ${bus.capacity} seats`);

  await Student.updateMany({ bus: bus._id, school: req.schoolId }, { $set: { bus: null } });
  await Student.updateMany({ _id: { $in: ids }, school: req.schoolId }, { $set: { bus: bus._id } });
  // A student can ride only one bus: remove them from other buses' lists.
  await Transport.updateMany({ school: req.schoolId, _id: { $ne: bus._id } }, { $pull: { assignedStudents: { $in: ids } } });
  bus.assignedStudents = ids;
  bus.availableSeats = bus.capacity - ids.length;
  await bus.save();
  const updated = await Transport.findById(bus._id).populate('assignedStudents', 'name rollNumber class section');
  res.json({ success: true, data: updated });
}));

router.delete('/:id', protect, authorizeRoles('admin'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const bus = await Transport.findOne({ _id: req.params.id, school: req.schoolId });
  if (!bus) throw new HttpError(404, 'Bus not found');
  await Student.updateMany({ bus: bus._id, school: req.schoolId }, { $set: { bus: null } });
  await bus.deleteOne();
  res.json({ success: true, message: 'Bus deleted' });
}));

// ---------------- Driver (authenticated by the secret driver token) ----------------

async function busForToken(token) {
  const bus = await Transport.findOne({ driverToken: String(token || '') });
  if (!bus) throw new HttpError(404, 'Invalid driver code');
  return ensureTracking(bus);
}

router.get('/driver/:token', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token);
  await bus.populate('assignedStudents', 'name rollNumber class');
  const out = bus.toObject();
  delete out.driverToken;
  res.json({ success: true, data: { ...out, trackingId: firebasePathFor(bus), firebasePath: firebasePathFor(bus) } });
}));

router.patch('/driver/:token/start-trip', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token);
  bus.stops.forEach((stop) => { stop.status = 'Pending'; stop.departedAt = undefined; });
  if (bus.stops.length) bus.stops[0].status = 'Live';
  Object.assign(bus, { busStatus: 'On Route', currentStopIndex: 0, tripStartedAt: new Date(), tripEndedAt: undefined, boardedStudents: [] });
  await bus.save();
  await publish(bus, { busStatus: 'On Route', currentStopIndex: 0, tripStartedAt: Date.now() });
  res.json({ success: true, data: { busStatus: bus.busStatus, currentStopIndex: 0, stops: bus.stops } });
}));

router.patch('/driver/:token/stop-done', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token);
  if (bus.busStatus !== 'On Route') throw new HttpError(409, 'Trip has not started');
  const idx = bus.currentStopIndex;
  if (idx < bus.stops.length) {
    bus.stops[idx].status = 'Departed';
    bus.stops[idx].departedAt = new Date();
    if (idx + 1 < bus.stops.length) bus.stops[idx + 1].status = 'Live';
    bus.currentStopIndex = idx + 1;
  }
  await bus.save();
  await publish(bus, { currentStopIndex: bus.currentStopIndex });
  res.json({ success: true, data: { currentStopIndex: bus.currentStopIndex, stops: bus.stops } });
}));

router.patch('/driver/:token/end-trip', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token);
  Object.assign(bus, { busStatus: 'Completed', tripEndedAt: new Date(), boardedStudents: [] });
  await bus.save();
  await publish(bus, { busStatus: 'Completed', tripEndedAt: Date.now(), location: null });
  res.json({ success: true, message: 'Trip ended successfully' });
}));

router.post('/driver/:token/update-location', asyncHandler(async (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) throw new HttpError(400, 'Invalid coordinates');
  const bus = await busForToken(req.params.token);
  if (bus.busStatus !== 'On Route') throw new HttpError(409, 'Trip not active');
  await publish(bus, { location: { lat, lng, updatedAt: Date.now() } });
  res.json({ success: true, message: 'Location updated' });
}));

module.exports = router;
