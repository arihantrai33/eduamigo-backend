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
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { jwtSecret } = require('../config/env');
const { isRevoked } = require('../services/tokens');
const { resolveAuthz } = require('../services/roles');
const { can } = require('../services/authorization');

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

// Why this person may NOT watch this bus right now, or null if they may. Used when a live stream is opened and then again every
// few seconds while it stays open (and at once when the bus's students change), so a removed assignment, a disabled account, a
// signed-out session or a suspended school stops the stream; it does not wait for the phone to reconnect.
async function whyNotWatching(user, decoded, busId, studentId, schoolId) {
  if (decoded?.exp && decoded.exp * 1000 <= Date.now()) return 'session';
  const fresh = await User.findOne({ _id: user._id, school: schoolId }).select('-password').populate('school', '_id isActive subscription');
  if (!fresh || !fresh.isActive || !fresh.school) return 'account';
  if (decoded && isRevoked(decoded, fresh)) return 'session';
  const entitlements = await entitlementsFor(fresh.school);
  if (entitlements.blocked || !entitlements.features.includes('transport')) return 'school';
  if (!(await Transport.exists({ _id: busId, school: fresh.school._id }))) return 'bus';
  if (fresh.role === 'student' || fresh.role === 'parent') {
    const student = fresh.role === 'student' ? await studentForUser(fresh) : (await resolveChild(fresh, studentId)).child;
    return student?.bus && String(student.bus) === String(busId) ? null : 'assignment';
  }
  fresh.authz = await resolveAuthz(fresh);
  return can(fresh, 'transport.manage', entitlements) ? null : 'permission';
}

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

  // "On route" means the driver's phone is sending its position. A trip that was started but has no position yet (or lost it)
  // is not shown as on the road: tripSignal is idle | waiting | live | weak | lost.
  let tripSignal = 'idle';
  if (bus.busStatus === 'On Route') {
    const st = await tracking.stateOf(bus._id, req.schoolId).catch(() => null);
    tripSignal = st ? tracking.signal(st) : 'waiting';
  }

  res.json({
    success: true,
    data: {
      tripSignal,
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

// POST /api/transport/sos  { studentId?, note?, requestId? } (student, parent)
// Creates an in-app notification for every active admin of the school and saves an SOS event with what was really done. It does NOT
// alert the driver (drivers have no account), and push delivery is not confirmed, so the answer says exactly that. The bus position is
// the server's own last reading of that bus, never a value from the phone.
router.post('/sos', protect, transportOn, authorizeRoles('student', 'parent'), asyncHandler(async (req, res) => {
  const User = require('../models/User');
  const Notification = require('../models/Notification');
  const School = require('../models/School');
  const SosEvent = require('../models/SosEvent');
  const { notifyUser } = require('../services/notify');
  const { audit } = require('../services/audit');

  const requestId = typeof req.body?.requestId === 'string' && /^[\w-]{8,64}$/.test(req.body.requestId) ? req.body.requestId : '';
  const view = (ev, schoolPhone) => ({
    success: true, eventId: String(ev._id), notified: ev.recipients.filter((r) => r.inApp === 'created').length,
    delivery: { inApp: 'created', push: 'unconfirmed', driver: 'not_notified' }, schoolPhone: schoolPhone || null,
  });
  const school = await School.findById(req.schoolId).select('phone');
  // The same tap sent twice (a retry after a slow network) is one event, not two alerts.
  if (requestId) {
    const seen = await SosEvent.findOne({ school: req.schoolId, createdBy: req.user._id, requestId });
    if (seen) return res.status(200).json({ ...view(seen, school?.phone), duplicate: true });
  }

  const recent = await Notification.countDocuments({
    school: req.schoolId, createdBy: req.user._id, title: 'SOS alert', createdAt: { $gt: new Date(Date.now() - 2 * 60 * 1000) },
  });
  if (recent) throw new HttpError(429, 'An SOS alert was just sent. The school has been notified. Please call if it is urgent.');

  const student = req.user.role === 'student'
    ? await studentForUser(req.user)
    : (await resolveChild(req.user, req.body?.studentId)).child;
  const bus = student?.bus ? await Transport.findOne({ _id: student.bus, school: req.schoolId }).select('busNumber routeName driverName driverPhone busStatus tripId') : null;
  let busPosition = null;
  if (bus && bus.busStatus === 'On Route') {
    const st = await tracking.stateOf(bus._id, req.schoolId).catch(() => null);
    if (st?.live) busPosition = { lat: st.live.lat, lng: st.live.lng, at: new Date(st.live.at), receivedAt: new Date(st.live.receivedAt) };
  }
  const where = busPosition ? ` Last bus position: https://maps.google.com/?q=${busPosition.lat},${busPosition.lng} (${new Date(busPosition.receivedAt).toISOString()}).` : '';
  const note = req.body?.note ? String(req.body.note).slice(0, 300) : '';

  const admins = await User.find({ school: req.schoolId, role: 'admin', isActive: true }).select('_id');
  const message = `${req.user.role === 'parent' ? `Parent ${req.user.name}` : `Student ${req.user.name}`} raised an SOS`
    + `${student ? ` for ${student.name} (Class ${student.class}-${student.section})` : ''}`
    + `${bus ? ` on bus ${bus.busNumber} (${bus.routeName}, driver ${bus.driverName} ${bus.driverPhone})` : ''}.${where}${note ? ` Note: ${note}` : ''}`;
  const recipients = await Promise.all(admins.map(async (a) => {
    try {
      await notifyUser(req.schoolId, a._id, { title: 'SOS alert', message, type: 'Transport', createdBy: req.user._id });
      return { user: a._id, inApp: 'created', push: 'unconfirmed' };
    } catch {
      return { user: a._id, inApp: 'failed', push: 'unconfirmed' };
    }
  }));
  const ev = await SosEvent.create({
    school: req.schoolId, createdBy: req.user._id, role: req.user.role, student: student?._id || null, bus: bus?._id || null,
    tripId: bus?.tripId || '', ...(busPosition ? { busPosition } : {}), note, requestId, recipients, driverNotified: false,
  });
  audit(req, 'transport.sos', { targetType: 'sos_event', targetId: ev._id, details: { bus: bus?.busNumber || null, recipients: recipients.length, delivered: recipients.filter((r) => r.inApp === 'created').length } });
  res.status(201).json(view(ev, school?.phone));
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
  const update = pick(req.body, BUS_FIELDS);
  if (update.capacity !== undefined) {
    // Free seats follow the capacity, and a bus cannot be made smaller than the number of students already on it.
    const current = await Transport.findOne({ _id: req.params.id, school: req.schoolId }).select('assignedStudents');
    if (!current) throw new HttpError(404, 'Bus not found');
    const capacity = Number(update.capacity);
    const assigned = current.assignedStudents.length;
    if (!Number.isInteger(capacity) || capacity < Math.max(1, assigned)) {
      throw new HttpError(400, assigned ? `This bus already has ${assigned} student${assigned === 1 ? '' : 's'}, so it needs at least ${assigned} seat${assigned === 1 ? '' : 's'}.` : 'Capacity must be a whole number of at least 1.');
    }
    update.capacity = capacity;
    update.availableSeats = capacity - assigned;
  }
  const bus = await Transport.findOneAndUpdate({ _id: req.params.id, school: req.schoolId }, update, { returnDocument: 'after', runValidators: true });
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

  // Buses these students are leaving: their viewers must be re-checked too.
  const leaving = (await Student.distinct('bus', { _id: { $in: ids }, school: req.schoolId, bus: { $nin: [null, bus._id] } })).map(String);
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
  [String(bus._id), ...leaving].forEach((id) => tracking.requestRecheck(id)); // open live maps of removed students close now
  res.json({ success: true, data: updated });
}));

router.delete('/:id', protect, transportOn, requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const bus = await Transport.findOne({ _id: req.params.id, school: req.schoolId });
  if (!bus) throw new HttpError(404, 'Bus not found');
  await Student.updateMany({ bus: bus._id, school: req.schoolId }, { $set: { bus: null } });
  await Transport.deleteOne({ _id: bus._id, school: req.schoolId });
  tracking.forget(bus._id);
  tracking.requestRecheck(bus._id);
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
  const decoded = jwt.decode(String(req.headers.authorization || '').slice(7));
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const write = (event) => { if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
  const unsubscribe = tracking.subscribe(req.params.busId, write);
  const beat = setInterval(() => write({ type: 'ping', serverTime: Date.now() }), 15000);
  // Access is checked again while the stream stays open: every BUS_STREAM_RECHECK_MS (a little random, so thousands of streams do not
  // all check in the same second) and at once when the bus's students change. When it no longer holds, the viewer is told and cut off.
  let over = false;
  const recheck = async () => {
    if (over || res.writableEnded) return;
    try {
      const why = await whyNotWatching(req.user, decoded, req.params.busId, req.query.studentId, req.schoolId);
      if (why) { over = true; write({ type: 'revoked', reason: why, serverTime: Date.now() }); res.end(); }
    } catch (err) { if (process.env.BUS_DEBUG) console.error('stream recheck failed:', err.message); /* a database hiccup: keep the stream, the next check decides */ }
  };
  const every = Number(process.env.BUS_STREAM_RECHECK_MS || 30000);
  const check = setInterval(recheck, every * (0.8 + Math.random() * 0.4));
  const unwatch = tracking.onRecheck(req.params.busId, recheck);
  const done = () => { over = true; clearInterval(beat); clearInterval(check); unsubscribe(); unwatch(); };
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
    // The token is checked again: a token the school has just replaced must stop working at once.
    if (bus && bus.driverToken === key) return bus;
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
  delete out.driverToken; delete out.route; delete out.tripNotices; delete out.assignedStudents; delete out.boardedStudents; delete out.driverDevice;
  return { ...out, stops: tracking.tripStops(bus).map((s) => ({ _id: s.id, name: s.name, latitude: s.lat, longitude: s.lng, status: s.status })), busId: bus._id };
};

// The driver's screen after opening the app or reloading it: which trip is running and where it has got to.
const deviceOf = (req) => { const d = String((req.body && req.body.deviceId) ?? req.query.deviceId ?? '').trim(); return /^[\w-]{8,64}$/.test(d) ? d : ''; };
// A trip with no reading for this long is treated as abandoned (the phone died): the next Start Trip replaces it without a takeover.
const QUIET_TRIP_MS = 15 * 60 * 1000;

router.get('/driver/:token', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token, { fresh: true });
  const device = deviceOf(req);
  // thisPhone: whether this phone may carry on with the running trip (no phone recorded, or it is the one that started it).
  res.json({ success: true, data: { ...driverView(bus), thisPhone: !bus.driverDevice || bus.driverDevice === device } });
}));

router.patch('/driver/:token/start-trip', asyncHandler(async (req, res) => {
  const bus = await busForToken(req.params.token, { fresh: true });
  if (!bus.stops.length) throw new HttpError(409, 'This bus has no stops yet. Ask the school to add the route.');
  const device = deviceOf(req);
  // One running trip per bus. Starting again would reset the stops and tell every parent "the bus has started" a second time, so a
  // trip that is running (and has been heard from lately) is refused unless the driver explicitly takes it over (restart: true).
  if (bus.busStatus === 'On Route' && req.body?.restart !== true) {
    const lastHeard = Math.max(bus.live?.receivedAt || 0, bus.tripStartedAt ? new Date(bus.tripStartedAt).getTime() : 0);
    if (Date.now() - lastHeard < QUIET_TRIP_MS) {
      throw new HttpError(409, bus.driverDevice && bus.driverDevice !== device ? 'This trip is already running on another phone.' : 'This trip is already running.',
        { code: 'TRIP_ALREADY_RUNNING', thisPhone: !bus.driverDevice || bus.driverDevice === device, tripId: bus.tripId, direction: bus.direction });
    }
  }
  const st = await tracking.startTrip(bus, req.body?.direction, { deviceId: device });
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
  if (bus.driverDevice && bus.driverDevice !== deviceOf(req)) throw new HttpError(409, 'This trip is being driven from another phone', { code: 'OTHER_PHONE' });
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
  if (bus.driverDevice && bus.driverDevice !== deviceOf(req)) throw new HttpError(409, 'This trip is being driven from another phone', { code: 'OTHER_PHONE' });
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
