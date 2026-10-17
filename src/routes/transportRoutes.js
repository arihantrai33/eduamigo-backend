const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Transport = require('../models/Transport');
const Student = require('../models/Student');
const { protect, authorizeRoles, requirePermission, requireFeature } = require('../middleware/authMiddleware');
const { HttpError, asyncHandler, assertId, pick } = require('../utils/http');
const { studentForUser, resolveChild } = require('../services/directory');
const { entitlementsFor } = require('../services/subscription');
const tracking = require('../services/busTracking');
const BusTripPoint = require('../models/BusTripPoint');
const { driverLocationLimiter } = require('../middleware/rateLimit');

// Driver token: long random secret (hard to guess), still easy to type from a card: "BUS12-8F3K-9QZ2-..."
const makeDriverToken = (busNumber) => {
  const clean = String(busNumber).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  return `${clean}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
};
const makeTrackingId = () => crypto.randomBytes(12).toString('hex');
const firebasePathFor = (bus) => bus.trackingId;
const transportOn = requireFeature('transport');

// Buses created before tracking ids existed get one the first time they are used,
// so the secret driver token is never handed out as a tracking path.
async function ensureTracking(bus) {
  if (!bus.trackingId) {
    bus.trackingId = makeTrackingId();
    bus.firebaseKey = `transport/${bus.trackingId}`;
    await Transport.updateOne({ _id: bus._id, school: bus.school }, { trackingId: bus.trackingId, firebaseKey: bus.firebaseKey });
  }
  return bus;
}

// ---------------- Live tracking: who may watch ----------------

// A student or parent may watch only the bus their child is assigned to; staff need the transport permission.
const viewerAccess = asyncHandler(async (req, res, next) => {
  assertId(req.params.busId, 'bus id');
  const exists = await Transport.exists({ _id: req.params.busId, school: req.schoolId });
  if (!exists) throw new HttpError(404, 'Bus not found');
  if (req.user.role === 'student' || req.user.role === 'parent') {
    const student = req.user.role === 'student' ? await studentForUser(req.user) : (await resolveChild(req.user, req.query.studentId)).child;
    if (!student?.bus || String(student.bus) !== String(req.params.busId)) throw new HttpError(404, 'No bus assigned');
    req.watching = student;
    return next();
  }
  return requirePermission('transport.manage')(req, res, next);
});

// ---------------- Parent / student ----------------

// GET /api/transport/my-child-bus?studentId=
router.get('/my-child-bus', protect, transportOn, authorizeRoles('student', 'parent'), asyncHandler(async (req, res) => {
  const student = req.user.role === 'student'
    ? await studentForUser(req.user)
    : (await resolveChild(req.user, req.query.studentId)).child;
  if (!student) throw new HttpError(404, 'No student linked to this account');
  if (!student.bus) throw new HttpError(404, 'No bus assigned');

  const bus = await Transport.findOne({ _id: student.bus, school: req.schoolId })
    .select('busNumber driverName driverPhone routeName busStatus stops currentStopIndex');
  if (!bus) throw new HttpError(404, 'No bus assigned');

  res.json({
    success: true,
    data: {
      _id: bus._id,
      busNumber: bus.busNumber,
      driverName: bus.driverName,
      driverPhone: bus.driverPhone,
      routeName: bus.routeName,
      busStatus: bus.busStatus,
      busId: bus._id,
      myStopId: student.busStopId || null,
      stops: bus.stops,
      currentStopIndex: bus.currentStopIndex,
      studentName: student.name,
      studentClass: `Class ${student.class}${student.section ? `-${student.section}` : ''}`,
    },
  });
}));

// POST /api/transport/sos  { studentId?, lat?, lng?, note? } (student, parent)
// Sends an urgent personal notification to every active admin of the school.
router.post('/sos', protect, transportOn, authorizeRoles('student', 'parent'), asyncHandler(async (req, res) => {
  const User = require('../models/User');
  const Notification = require('../models/Notification');
  const School = require('../models/School');
  const { notifyUser } = require('../services/notify');

  const recent = await Notification.countDocuments({
    school: req.schoolId, createdBy: req.user._id, title: 'SOS alert', createdAt: { $gt: new Date(Date.now() - 2 * 60 * 1000) },
  });
  if (recent) throw new HttpError(429, 'An SOS alert was just sent. The school has been notified. Please call if it is urgent.');

  const student = req.user.role === 'student'
    ? await studentForUser(req.user)
    : (await resolveChild(req.user, req.body?.studentId)).child;
  const bus = student?.bus ? await Transport.findOne({ _id: student.bus, school: req.schoolId }).select('busNumber routeName driverName driverPhone') : null;
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const where = Number.isFinite(lat) && Number.isFinite(lng) ? ` Location: https://maps.google.com/?q=${lat},${lng}` : '';
  const note = req.body?.note ? ` Note: ${String(req.body.note).slice(0, 300)}` : '';

  const admins = await User.find({ school: req.schoolId, role: 'admin', isActive: true }).select('_id');
  const message = `${req.user.role === 'parent' ? `Parent ${req.user.name}` : `Student ${req.user.name}`} raised an SOS`
    + `${student ? ` for ${student.name} (Class ${student.class}-${student.section})` : ''}`
    + `${bus ? ` on bus ${bus.busNumber} (${bus.routeName}, driver ${bus.driverName} ${bus.driverPhone})` : ''}.${where}${note}`;
  await Promise.all(admins.map((a) => notifyUser(req.schoolId, a._id, { title: 'SOS alert', message, type: 'Transport', createdBy: req.user._id })));

  const school = await School.findById(req.schoolId).select('phone');
  res.status(201).json({ success: true, notified: admins.length, schoolPhone: school?.phone || null });
}));

// ---------------- Admin ----------------

const BUS_FIELDS = ['busNumber', 'driverName', 'driverPhone', 'routeName', 'capacity'];

router.get('/', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const buses = await Transport.find({ school: req.schoolId }).populate('assignedStudents', 'name rollNumber class section');
  res.json({ success: true, data: buses });
}));

router.post('/', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
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

router.get('/students', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const students = await Student.find({ school: req.schoolId, isActive: true })
    .select('name rollNumber class section bus busStopId').populate('bus', 'busNumber');
  res.json({ success: true, data: students });
}));

router.put('/:id', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const bus = await Transport.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, pick(req.body, BUS_FIELDS), { returnDocument: 'after', runValidators: true });
  if (!bus) throw new HttpError(404, 'Bus not found');
  res.json({ success: true, data: bus });
}));

// POST /api/transport/:id/regenerate-token — use when a driver leaves or a token card is lost
router.post('/:id/regenerate-token', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const bus = await Transport.findOne({ _id: req.params.id, school: req.schoolId });
  if (!bus) throw new HttpError(404, 'Bus not found');
  bus.driverToken = makeDriverToken(bus.busNumber);
  if (!bus.trackingId) { bus.trackingId = makeTrackingId(); bus.firebaseKey = `transport/${bus.trackingId}`; }
  await bus.save();
  res.json({ success: true, data: { driverToken: bus.driverToken } });
}));

router.put('/:id/stops', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
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
  tracking.forget(bus._id);
  res.json({ success: true, data: bus });
}));

router.put('/:id/assign-students', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const ids = Array.isArray(req.body?.studentIds) ? req.body.studentIds.map(String) : [];
  ids.forEach((id) => assertId(id, 'student id'));
  const bus = await Transport.findOne({ _id: req.params.id, school: req.schoolId });
  if (!bus) throw new HttpError(404, 'Bus not found');
  const students = await Student.find({ _id: { $in: ids }, school: req.schoolId }).select('_id');
  if (students.length !== ids.length) throw new HttpError(400, 'One or more students do not belong to your school');
  if (ids.length > bus.capacity) throw new HttpError(400, `This bus has only ${bus.capacity} seats`);

  // Students taken off this bus lose their stop; students arriving from another bus start without one (that stop was on the other bus).
  await Student.updateMany({ bus: bus._id, school: req.schoolId, _id: { $nin: ids } }, { $set: { bus: null, busStopId: null } });
  await Student.updateMany({ _id: { $in: ids }, school: req.schoolId, bus: { $ne: bus._id } }, { $set: { bus: bus._id, busStopId: null } });
  // Where each student gets on and off: { stopIds: { <studentId>: <stopId> } }. A stop that is not on this bus clears it.
  const stopIds = req.body?.stopIds && typeof req.body.stopIds === 'object' ? req.body.stopIds : {};
  const known = new Set(bus.stops.map((x) => String(x._id)));
  for (const id of ids) {
    if (!(id in stopIds)) continue;
    const stop = String(stopIds[id] || '');
    await Student.updateOne({ _id: id, school: req.schoolId }, { $set: { busStopId: known.has(stop) ? stop : null } });
  }
  tracking.forget(bus._id);
  // A student can ride only one bus: remove them from other buses' lists.
  await Transport.updateMany({ school: req.schoolId, _id: { $ne: bus._id } }, { $pull: { assignedStudents: { $in: ids } } });
  bus.assignedStudents = ids;
  bus.availableSeats = bus.capacity - ids.length;
  await bus.save();
  const updated = await Transport.findOne({ _id: bus._id, school: req.schoolId }).populate('assignedStudents', 'name rollNumber class section');
  res.json({ success: true, data: updated });
}));

router.delete('/:id', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const bus = await Transport.findOne({ _id: req.params.id, school: req.schoolId });
  if (!bus) throw new HttpError(404, 'Bus not found');
  await Student.updateMany({ bus: bus._id, school: req.schoolId }, { $set: { bus: null } });
  await Transport.deleteOne({ _id: bus._id, school: req.schoolId });
  res.json({ success: true, message: 'Bus deleted' });
}));

// ---------------- Live tracking: viewers (parent, student, school staff) ----------------

// All buses of the school that are on a trip, for the school's live view.
router.get('/live', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const buses = await Transport.find({ school: req.schoolId, busStatus: 'On Route' }).select('_id').lean();
  const data = (await Promise.all(buses.map((b) => tracking.snapshotFor(b._id, { withRoute: false }, req.schoolId)))).filter(Boolean);
  res.json({ success: true, data });
}));

// The current picture of one bus. Used first, and again every few seconds if the live stream cannot be kept open.
router.get('/live/:busId', protect, transportOn, viewerAccess, asyncHandler(async (req, res) => {
  const snap = await tracking.snapshotFor(req.params.busId, { withRoute: req.query.route !== '0' }, req.schoolId);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: snap });
}));

// The same picture followed by every change as it happens, one JSON object per line. The first line is the snapshot; a
// { type: "ping" } line every 15 seconds keeps the connection open through proxies and lets the screen notice a dead link.
router.get('/live/:busId/stream', protect, transportOn, viewerAccess, asyncHandler(async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const write = (event) => { if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
  const unsubscribe = tracking.subscribe(req.params.busId, write);
  const beat = setInterval(() => write({ type: 'ping', serverTime: Date.now() }), 15000);
  const done = () => { clearInterval(beat); unsubscribe(); };
  res.on('close', done);
  write(await tracking.snapshotFor(req.params.busId, undefined, req.schoolId));
}));

// Where a trip went (sampled every 15 seconds, kept 3 days), for the school office.
router.get('/live/:busId/history', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  assertId(req.params.busId, 'bus id');
  if (!(await Transport.exists({ _id: req.params.busId, school: req.schoolId }))) throw new HttpError(404, 'Bus not found');
  const filter = { bus: req.params.busId, school: req.schoolId };
  if (req.query.tripId) filter.tripId = String(req.query.tripId);
  const points = await BusTripPoint.find(filter).sort({ at: 1 }).limit(3000).select('tripId lat lng speedKmh at -_id').lean();
  res.json({ success: true, data: points });
}));

// ---------------- Driver (authenticated by the secret driver token) ----------------

// The driver app has no login, so the school's plan and billing state are checked from the token. Remembered for 20 seconds,
// so a GPS reading every few seconds does not cost three database reads each time.
const tokenCache = new Map();
async function busForToken(token, { fresh = false } = {}) {
  const key = String(token || '');
  const hit = tokenCache.get(key);
  let bus;
  if (hit && !fresh && Date.now() - hit.at < 20000) {
    bus = await Transport.findById(hit.id);
    if (bus) return bus;
  }
  bus = await Transport.findOne({ driverToken: key });
  if (!bus) { tokenCache.delete(key); throw new HttpError(404, 'Invalid driver code'); }
  const school = await require('../models/School').findById(bus.school).select('subscription isActive');
  const e = school ? await entitlementsFor(school) : null;
  if (!e || e.blocked || e.readOnly || !e.features.includes('transport')) {
    throw new HttpError(403, 'Bus tracking is not available for this school right now');
  }
  tokenCache.set(key, { id: bus._id, at: Date.now() });
  return bus;
}

const driverView = (bus) => {
  const out = bus.toObject();
  delete out.driverToken; delete out.route; delete out.tripNotices; delete out.assignedStudents; delete out.boardedStudents;
  return { ...out, stops: tracking.tripStops(bus).map((s) => ({ _id: s.id, name: s.name, latitude: s.lat, longitude: s.lng, status: s.status })), busId: bus._id };
};

// The driver's screen after opening the app or reloading it: which trip is running and where it has got to.
router.get('/driver/:token', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token, { fresh: true });
  res.json({ success: true, data: driverView(bus) });
}));

router.patch('/driver/:token/start-trip', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token, { fresh: true });
  if (!bus.stops.length) throw new HttpError(409, 'This bus has no stops yet. Ask the school to add the route.');
  const st = await tracking.startTrip(bus, req.body?.direction);
  res.json({ success: true, data: { busStatus: 'On Route', currentStopIndex: 0, direction: st.direction, tripId: st.tripId, routeSource: st.routeSource, stops: driverView(await Transport.findById(bus._id)).stops } });
}));

// A batch of GPS readings: { points: [{ lat, lng, accuracy, speed, heading, at }] }. One reading sent the old way
// ({ lat, lng }) is accepted too. The reply tells the phone how far the trip has got, so its screen follows the server.
const takeLocation = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const points = Array.isArray(body.points) ? body.points : [{ lat: body.lat, lng: body.lng, accuracy: body.accuracy, speed: body.speed, heading: body.heading, at: body.at }];
  if (!points.length) throw new HttpError(400, 'No location was sent');
  if (points.length > 60) throw new HttpError(400, 'Send at most 60 readings at a time');
  if (!points.some((p) => Number(p?.lat) >= -90 && Number(p?.lat) <= 90 && Number(p?.lng) >= -180 && Number(p?.lng) <= 180)) throw new HttpError(400, 'Invalid coordinates');
  const bus = await busForToken(req.params.token);
  const out = await tracking.ingest(bus._id, points);
  if (out.notActive) throw new HttpError(409, 'Trip not active', { code: 'TRIP_NOT_ACTIVE' });
  res.json({ success: true, data: out });
});
router.post('/driver/:token/location', driverLocationLimiter, takeLocation);
router.post('/driver/:token/update-location', driverLocationLimiter, takeLocation);

// "Reached the stop": moves on to the next one (the app does this by itself when the bus drives through the stop).
router.patch('/driver/:token/stop-done', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token, { fresh: true });
  if (bus.busStatus !== 'On Route') throw new HttpError(409, 'Trip has not started');
  const st = await tracking.stateOf(bus._id, bus.school);
  await tracking.advance(st);
  const fresh = await Transport.findById(bus._id);
  res.json({ success: true, data: { currentStopIndex: st.current, stops: driverView(fresh).stops } });
}));

router.patch('/driver/:token/end-trip', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token, { fresh: true });
  await tracking.endTrip(bus);
  res.json({ success: true, message: 'Trip ended successfully' });
}));

module.exports = router;
