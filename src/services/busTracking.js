// Live bus tracking, the way a delivery app tracks a rider.
//
//   driver phone --(batches of GPS points)--> ingest() --> checks, snap to the road, stops, ETAs --> database + live stream
//   parent / student / admin screens <-- snapshot (first) + stream of changes (then), with a polling fallback
//
// What this module does, and why:
//   * The route is the road geometry between the stops (built once per trip from a routing service, straight lines if it is
//     unreachable) and is stored on the bus, so viewers never call a routing service themselves.
//   * Every GPS reading is checked: wrong coordinates, poor accuracy, impossible jumps, old or repeated readings are dropped; a
//     reading is "snapped" onto the road when it is close to it, so the bus moves along the road, not through buildings.
//   * Stops are followed automatically: arriving at the next stop (within 70 m) marks it reached, leaving it (130 m) marks it
//     departed and makes the next one current. The driver's "reached stop" button does the same thing by hand.
//   * ETAs per stop come from the distance left on the road and the bus's recent average speed, plus a short wait per stop.
//   * Parents are told once per trip: trip started, bus about 5 minutes from the child's stop, bus at the child's stop, trip ended.
//   * Nothing here needs Firebase or any third-party real-time service. Viewers get the changes through /api/transport/live/...

const crypto = require('crypto');
const { EventEmitter } = require('events');
const Transport = require('../models/Transport');
const Student = require('../models/Student');
const BusTripPoint = require('../models/BusTripPoint');
const { notifyParents } = require('./notify');

const num = (name, d) => (process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : d);
const cfg = () => ({
  staleMs: num('BUS_STALE_MS', 45000),         // no reading for this long: viewers see "signal lost"
  maxAccuracyM: num('BUS_MAX_ACCURACY_M', 100), // readings less accurate than this are ignored
  maxSpeedKmh: num('BUS_MAX_SPEED_KMH', 120),   // faster than this between two readings is a GPS jump
  arriveM: num('BUS_ARRIVE_M', 70),
  departM: num('BUS_DEPART_M', 130),
  snapM: num('BUS_SNAP_M', 50),
  nearMin: num('BUS_NEAR_MINUTES', 5),
  dwellSec: num('BUS_DWELL_SECONDS', 30),
  sampleMs: num('BUS_POINT_SAMPLE_MS', 15000),
  maxBatch: 60,
});

// ---------------------------------------------------------------- geometry (metres)

const RAD = Math.PI / 180;
const R = 6371000;
function distance(aLat, aLng, bLat, bLng) {
  const dLat = (bLat - aLat) * RAD; const dLng = (bLng - aLng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(aLat, aLng, bLat, bLng) {
  const y = Math.sin((bLng - aLng) * RAD) * Math.cos(bLat * RAD);
  const x = Math.cos(aLat * RAD) * Math.sin(bLat * RAD) - Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos((bLng - aLng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// points: [[lat, lng], ...] -> { pts, cum (metres from the start at each point), meters (total) }
function buildRoute(points) {
  const pts = points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + distance(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  return { pts, cum, meters: cum[cum.length - 1] || 0 };
}

// Nearest point on the route to (lat, lng), searching first around `from` metres (the bus only moves forward), then everywhere.
// -> { meters (along the route), d (distance from the route), lat, lng }
function project(route, lat, lng, from = 0, windowBack = 400, windowFwd = 4000) {
  const { pts, cum } = route;
  if (pts.length < 2) return pts.length ? { meters: 0, d: distance(lat, lng, pts[0][0], pts[0][1]), lat: pts[0][0], lng: pts[0][1] } : null;
  const kx = Math.cos(lat * RAD) * 111320; const ky = 110540;
  const scan = (lo, hi) => {
    let best = null;
    for (let i = 0; i < pts.length - 1; i += 1) {
      if (cum[i + 1] < lo || cum[i] > hi) continue;
      const ax = (pts[i][1] - lng) * kx; const ay = (pts[i][0] - lat) * ky;
      const bx = (pts[i + 1][1] - lng) * kx; const by = (pts[i + 1][0] - lat) * ky;
      const dx = bx - ax; const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx; const py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (!best || d < best.d) best = { d, meters: cum[i] + t * (cum[i + 1] - cum[i]), lat: pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), lng: pts[i][1] + t * (pts[i + 1][1] - pts[i][1]) };
    }
    return best;
  };
  const near = scan(from - windowBack, from + windowFwd);
  if (near && near.d <= 80) return near;
  const all = scan(-Infinity, Infinity);
  return all && (!near || all.d < near.d) ? all : near;
}

// Fewer points for the same line (Douglas-Peucker), so the stored route stays small. tolerance in metres.
function simplify(points, tolerance = 4) {
  if (points.length <= 2) return points;
  const kx = Math.cos(points[0][0] * RAD) * 111320; const ky = 110540;
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1; let farD = 0;
    const ax = points[a][1] * kx; const ay = points[a][0] * ky; const bx = points[b][1] * kx; const by = points[b][0] * ky;
    const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i += 1) {
      const px = points[i][1] * kx - ax; const py = points[i][0] * ky - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > farD) { farD = d; far = i; }
    }
    if (far >= 0 && farD > tolerance) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- the road route

// The road geometry through the stops, from an OSRM-compatible routing service (ROUTING_URL, default the public demo server;
// ROUTING_URL=off disables it). Returns [[lat, lng], ...] or null. One call per trip start, not one per viewer.
async function osrmRoute(base, stops, signal) {
  const coords = stops.map((s) => `${s.lng},${s.lat}`).join(';');
  const res = await fetch(`${base.replace(/\/$/, '')}/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=false`, { signal });
  const data = await res.json().catch(() => ({}));
  const line = data?.routes?.[0]?.geometry?.coordinates;
  return Array.isArray(line) && line.length > 1 ? line.map(([lng, lat]) => [lat, lng]) : null;
}

// Mapbox Directions takes at most 25 points per request: longer routes are asked for in overlapping pieces and joined.
async function mapboxRoute(token, stops, signal) {
  const out = [];
  for (let from = 0; from < stops.length - 1; from += 24) {
    const part = stops.slice(from, from + 25);
    if (part.length < 2) break;
    const coords = part.map((s) => `${s.lng},${s.lat}`).join(';');
    const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?overview=full&geometries=geojson&continue_straight=false&access_token=${encodeURIComponent(token)}`, { signal });
    const data = await res.json().catch(() => ({}));
    const line = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(line) || line.length < 2) return null;
    out.push(...line.map(([lng, lat]) => [lat, lng]));
  }
  return out.length > 1 ? out : null;
}

async function roadGeometry(stops) {
  if (stops.length < 2) return null;
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  const base = process.env.ROUTING_URL === undefined ? (process.env.NODE_ENV === 'test' ? 'off' : 'https://router.project-osrm.org') : process.env.ROUTING_URL;
  if (!token && (!base || base === 'off')) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    let line = token ? await mapboxRoute(token, stops, ctl.signal).catch(() => null) : null;
    if (!line && base && base !== 'off') line = await osrmRoute(base, stops, ctl.signal); // Mapbox failed or is not set: the OSRM service
    return line ? simplify(line, 3).slice(0, 4000) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Stops in the order of this trip: as stored for a pickup run, reversed for the drop run. Each keeps its stored index.
function tripStops(bus) {
  const list = (bus.stops || []).map((s, i) => ({
    id: String(s._id), name: s.name, lat: s.latitude, lng: s.longitude, status: s.status, arrivedAt: s.arrivedAt, departedAt: s.departedAt, stored: i,
  }));
  return bus.direction === 'drop' ? list.reverse() : list;
}

const routeKey = (stops, direction) => crypto.createHash('sha1').update(JSON.stringify([direction, stops.map((s) => [s.lat, s.lng])])).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- runtime state (one object per bus on a trip)

const runtime = new Map(); // busId -> state
const bus = new EventEmitter();
bus.setMaxListeners(0);

// How far along the road each stop is, and how far the stop's pin is from the road.
function layOut(route, stops) {
  const offsets = []; const offRoad = []; let from = 0;
  for (const s of stops) {
    const p = project(route, s.lat, s.lng, from, 0, route.meters + 1);
    const m = p ? Math.max(p.meters, from) : from;
    offsets.push(m); offRoad.push(p ? p.d : 0); from = m;
  }
  return { offsets, offRoad };
}

async function loadState(busId, school) {
  const doc = await Transport.findOne(school ? { _id: busId, school } : { _id: busId }).setOptions(school ? {} : { crossTenant: 'the driver app has no school session; the bus is found by its own id' }).lean();
  if (!doc) return null;
  const stops = tripStops(doc);
  const pts = doc.route?.points?.length ? doc.route.points : stops.map((s) => [s.lat, s.lng]);
  const route = buildRoute(pts);
  const { offsets, offRoad } = layOut(route, stops);
  const students = doc.busStatus === 'On Route'
    ? (await Student.find({ school: doc.school, bus: doc._id, isActive: true }).select('name busStopId school').lean())
      .map((s) => ({ _id: s._id, name: s.name, school: s.school, stop: stops.findIndex((x) => x.id === String(s.busStopId)) }))
    : [];
  const st = {
    id: String(doc._id), school: doc.school, status: doc.busStatus, direction: doc.direction || 'pickup', tripId: doc.tripId || null,
    busNumber: doc.busNumber, stops, current: doc.currentStopIndex || 0, route, offsets, offRoad, routeSource: doc.route?.source || 'straight',
    live: doc.live || null, students, notices: new Set(doc.tripNotices || []), lastSample: 0,
  };
  runtime.set(st.id, st);
  if (st.status === 'On Route' && st.routeSource !== 'road') upgradeRoute(st).catch(() => {});
  return st;
}
// A trip whose road was never fetched (a routing service that was down at the start, or a trip begun by older software) gets its
// road as soon as one is available: the line on the map follows the streets instead of running straight between the stops. Once
// per bus every ten minutes at most; viewers get the new route in the next snapshot.
const upgrading = new Map();
async function upgradeRoute(st) {
  if (upgrading.has(st.id) || st.stops.length < 2) return;
  upgrading.set(st.id, setTimeout(() => upgrading.delete(st.id), 10 * 60 * 1000));
  upgrading.get(st.id).unref?.();
  const road = await roadGeometry(st.stops);
  if (!road) return;
  const route = buildRoute(road);
  Object.assign(st, { route, routeSource: 'road', ...layOut(route, st.stops) });
  await Transport.updateOne({ _id: st.id, school: st.school }, { $set: { route: { points: road, source: 'road', key: routeKey(st.stops, st.direction), meters: Math.round(route.meters) } } });
  emit(st, snapshot(st));
}

// `school` is the signed-in viewer's school (a viewer never gets another school's bus); the driver app passes none.
async function stateOf(busId, school) {
  const hit = runtime.get(String(busId));
  if (hit) return !school || String(hit.school) === String(school) ? hit : null;
  return loadState(busId, school);
}
function forget(busId) { runtime.delete(String(busId)); }

const emit = (st, event) => bus.emit(st.id, event);

// ---------------------------------------------------------------- what viewers get

function etas(st) {
  const c = cfg();
  const live = st.live;
  if (!live || st.status !== 'On Route') return st.stops.map(() => null);
  const kmh = Math.min(45, Math.max(12, live.avgKmh || 25));
  const out = [];
  for (let i = 0; i < st.stops.length; i += 1) {
    if (i < st.current) { out.push(null); continue; }
    const left = Math.max(0, st.offsets[i] - (live.routeMeters ?? 0));
    const between = Math.max(0, i - st.current);
    const secs = left / (kmh / 3.6) + between * c.dwellSec;
    out.push(left < 80 && i === st.current ? 0 : Math.max(1, Math.ceil(secs / 60)));
  }
  return out;
}

function signal(st, now = Date.now()) {
  if (st.status !== 'On Route') return 'idle';
  if (!st.live) return 'waiting';
  if (now - st.live.receivedAt > cfg().staleMs) return 'lost';
  return st.live.accuracy > 50 ? 'weak' : 'live';
}

const publicPosition = (live) => (live ? {
  lat: live.lat, lng: live.lng, heading: live.heading ?? null, speedKmh: Math.round(live.speedKmh || 0), accuracy: live.accuracy ?? null,
  at: live.at, receivedAt: live.receivedAt, routeMeters: Math.round(live.routeMeters || 0), offRoute: !!live.offRoute,
} : null);

const publicStops = (st) => {
  const e = etas(st);
  return st.stops.map((s, i) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, status: i < st.current ? 'Departed' : (i === st.current && st.status === 'On Route' ? 'Live' : 'Pending'), arrivedAt: s.arrivedAt || null, departedAt: s.departedAt || null, etaMin: e[i], offset: Math.round(st.offsets[i]) }));
};

// The full picture, sent first to a viewer and by the polling fallback. `route` is included only when asked for (it is big).
function snapshot(st, { withRoute = true, now = Date.now() } = {}) {
  return {
    type: 'snapshot', busId: st.id, busNumber: st.busNumber, tripId: st.tripId, status: st.status, direction: st.direction,
    signal: signal(st, now), position: publicPosition(st.live), currentStopIndex: st.current, stops: publicStops(st),
    route: withRoute ? { points: st.route.pts, source: st.routeSource, meters: Math.round(st.route.meters) } : undefined,
    staleMs: cfg().staleMs, serverTime: now,
  };
}

async function snapshotFor(busId, options, school) {
  const st = await stateOf(busId, school);
  return st ? snapshot(st, options) : null;
}

// ---------------------------------------------------------------- notifications (each at most once per trip)

async function claimNotice(st, key) {
  if (st.notices.has(key)) return false;
  st.notices.add(key);
  const claimed = await Transport.findOneAndUpdate({ _id: st.id, school: st.school, tripNotices: { $ne: key } }, { $addToSet: { tripNotices: key } }, { projection: { _id: 1 } });
  return !!claimed;
}

async function tellParents(st, students, notice) {
  await Promise.all(students.map(async (s) => {
    try { await notifyParents({ _id: s._id, school: st.school }, { type: 'Transport', ...notice(s) }); } catch (err) { console.error('bus notice failed:', err.message); }
  }));
}

async function noticesFor(st, c = cfg()) {
  const e = etas(st);
  for (const s of st.students) {
    if (s.stop < 0 || s.stop < st.current) continue;
    if (s.stop === st.current && st.live && distance(st.live.lat, st.live.lng, st.stops[s.stop].lat, st.stops[s.stop].lng) <= c.arriveM * 2) {
      if (await claimNotice(st, `arrived:${s._id}`)) await tellParents(st, [s], () => ({ title: `Bus ${st.busNumber} is at the stop`, message: `The bus has reached ${st.stops[s.stop].name}.` }));
    } else if (e[s.stop] !== null && e[s.stop] <= c.nearMin && e[s.stop] > 0) {
      if (await claimNotice(st, `near:${s._id}`)) await tellParents(st, [s], () => ({ title: `Bus ${st.busNumber} is about ${e[s.stop]} min away`, message: `The bus will reach ${st.stops[s.stop].name} in about ${e[s.stop]} minutes.` }));
    }
  }
}

// ---------------------------------------------------------------- the trip

// Starts a trip: new trip id, stops reset, route built (or reused), parents told. direction: 'pickup' | 'drop'.
async function startTrip(busDoc, direction = 'pickup') {
  const dir = direction === 'drop' ? 'drop' : 'pickup';
  const probe = { ...busDoc.toObject(), direction: dir };
  const stops = tripStops(probe);
  const key = routeKey(stops, dir);
  let route = busDoc.route?.key === key && busDoc.route?.points?.length ? { points: busDoc.route.points, source: busDoc.route.source, meters: busDoc.route.meters } : null;
  if (!route) {
    const road = await roadGeometry(stops);
    const points = road || stops.map((s) => [s.lat, s.lng]);
    route = { points, source: road ? 'road' : 'straight', key, meters: Math.round(buildRoute(points).meters) };
  }
  const tripId = crypto.randomBytes(8).toString('hex');
  busDoc.stops.forEach((s) => { s.status = 'Pending'; s.arrivedAt = undefined; s.departedAt = undefined; });
  const first = dir === 'drop' ? busDoc.stops.length - 1 : 0;
  if (busDoc.stops.length) busDoc.stops[first].status = 'Live';
  Object.assign(busDoc, { busStatus: 'On Route', direction: dir, tripId, currentStopIndex: 0, tripStartedAt: new Date(), tripEndedAt: undefined, boardedStudents: [], route, tripNotices: [] });
  busDoc.set('live', undefined);
  await busDoc.save();
  forget(busDoc._id);
  const st = await loadState(busDoc._id, busDoc.school);
  st.notices.add('start');
  await Transport.updateOne({ _id: busDoc._id, school: busDoc.school }, { $addToSet: { tripNotices: 'start' } });
  const all = (await Student.find({ school: busDoc.school, bus: busDoc._id, isActive: true }).select('_id school').lean());
  tellParents(st, all, () => ({ title: `Bus ${st.busNumber} has started`, message: dir === 'drop' ? 'The bus has left school with the students.' : 'The bus has started its route.' })).catch(() => {});
  emit(st, snapshot(st));
  return st;
}

async function endTrip(busDoc) {
  const st = await stateOf(busDoc._id, busDoc.school);
  Object.assign(busDoc, { busStatus: 'Completed', tripEndedAt: new Date(), boardedStudents: [] });
  busDoc.set('live', undefined);
  await busDoc.save();
  if (st) {
    st.status = 'Completed'; st.live = null;
    if (await claimNotice(st, 'end')) tellParents(st, st.students, () => ({ title: `Bus ${st.busNumber} trip ended`, message: st.direction === 'drop' ? 'The bus has finished dropping students.' : 'The bus has reached school.' })).catch(() => {});
    emit(st, snapshot(st, { withRoute: false }));
  }
  forget(busDoc._id);
}

// Marks the current stop departed and makes the next one current. Used by the driver's button and by the automatic follow.
async function advance(st, { arrived = true } = {}) {
  if (st.current >= st.stops.length) return false;
  const now = new Date();
  const here = st.stops[st.current];
  const next = st.stops[st.current + 1];
  const set = { currentStopIndex: st.current + 1, 'stops.$[a].status': 'Departed', 'stops.$[a].departedAt': now };
  const filters = [{ 'a._id': new (require('mongoose').Types.ObjectId)(here.id) }];
  if (arrived && !here.arrivedAt) set['stops.$[a].arrivedAt'] = now;
  if (next) { set['stops.$[b].status'] = 'Live'; filters.push({ 'b._id': new (require('mongoose').Types.ObjectId)(next.id) }); }
  await Transport.updateOne({ _id: st.id, school: st.school }, { $set: set }, { arrayFilters: filters });
  here.status = 'Departed'; here.departedAt = now; if (next) next.status = 'Live';
  st.current += 1;
  emit(st, { type: 'stops', busId: st.id, currentStopIndex: st.current, stops: publicStops(st), serverTime: Date.now() });
  return true;
}

async function markArrived(st) {
  const here = st.stops[st.current];
  if (!here || here.arrivedAt) return;
  here.arrivedAt = new Date();
  await Transport.updateOne({ _id: st.id, school: st.school }, { $set: { 'stops.$[a].arrivedAt': here.arrivedAt } }, { arrayFilters: [{ 'a._id': new (require('mongoose').Types.ObjectId)(here.id) }] });
}

// ---------------------------------------------------------------- GPS readings

// Follows the stops for one accepted reading: arriving at the current stop, then leaving it, moves on to the next. Called for every
// reading (not once per batch), so a bundle of readings kept offline still passes each stop in order.
async function followStops(st, live, c) {
  const here = st.stops[st.current];
  if (!here) return;
  const d = distance(live.lat, live.lng, here.lat, here.lng);
  // A stop may be a little off the road (a pin placed beside it): the bus drives past on the road, so the radius grows by that
  // much, and having driven on along the road beyond the stop counts as having passed it.
  const slack = Math.min(st.offRoad[st.current] || 0, 300);
  const passed = !live.offRoute && live.routeMeters >= st.offsets[st.current] + c.departM;
  if (d <= c.arriveM + slack || passed) await markArrived(st);
  if (here.arrivedAt && (d >= c.departM + slack || passed) && st.current < st.stops.length - 1) { await advance(st); return; }
  if (!here.arrivedAt && st.current < st.stops.length - 1) {
    // The bus has gone past without the stop being marked (and the driver forgot the button): reaching the next stop moves on.
    const nxt = st.stops[st.current + 1];
    if (nxt && distance(live.lat, live.lng, nxt.lat, nxt.lng) <= c.arriveM + Math.min(st.offRoad[st.current + 1] || 0, 300)) { await advance(st, { arrived: false }); await markArrived(st); }
  }
}

// points: [{ lat, lng, accuracy?, speed? (m/s), heading?, at? (ms) }]. Returns { accepted, rejected, reasons, ... }.
async function ingest(busId, rawPoints, { now = Date.now() } = {}) {
  const c = cfg();
  const st = await stateOf(busId);
  if (!st || st.status !== 'On Route') return { notActive: true };
  const list = (Array.isArray(rawPoints) ? rawPoints : []).slice(0, c.maxBatch);
  const reasons = {};
  const reject = (why) => { reasons[why] = (reasons[why] || 0) + 1; };
  const clean = [];
  for (const p of list) {
    const lat = Number(p?.lat ?? p?.latitude); const lng = Number(p?.lng ?? p?.longitude);
    if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180) || (lat === 0 && lng === 0)) { reject('coordinates'); continue; }
    let at = Number(p?.at); if (!Number.isFinite(at) || at <= 0) at = now;
    if (at > now + 30000) at = now; // a phone clock running ahead
    if (at < now - 6 * 3600 * 1000) { reject('too_old'); continue; }
    const accuracy = Number.isFinite(Number(p?.accuracy)) ? Math.max(0, Number(p.accuracy)) : null;
    if (accuracy !== null && accuracy > c.maxAccuracyM) { reject('poor_accuracy'); continue; }
    clean.push({ lat, lng, at, accuracy, speed: Number.isFinite(Number(p?.speed)) && Number(p.speed) >= 0 ? Number(p.speed) : null, heading: Number.isFinite(Number(p?.heading)) ? ((Number(p.heading) % 360) + 360) % 360 : null });
  }
  clean.sort((a, b) => a.at - b.at);

  let live = st.live ? { ...st.live } : null;
  let accepted = 0; let moved = false;
  for (const p of clean) {
    if (live && p.at <= live.at) { reject('old_or_repeat'); continue; }
    let kmh = p.speed !== null ? p.speed * 3.6 : null;
    if (live) {
      const dt = (p.at - live.at) / 1000;
      const d = distance(live.lat, live.lng, p.lat, p.lng);
      const implied = dt > 0 ? (d / dt) * 3.6 : 0;
      if (implied > c.maxSpeedKmh && dt < 300 && d > 60) { reject('gps_jump'); continue; }
      if (kmh === null) kmh = d < Math.max(8, (p.accuracy || 0) * 0.5) ? 0 : implied;
    }
    kmh = Math.min(kmh ?? 0, c.maxSpeedKmh);
    const prev = live;
    const jitter = prev && distance(prev.lat, prev.lng, p.lat, p.lng) < Math.max(6, (p.accuracy || 0) * 0.4) && kmh < 2;
    // Along the road: snap when close to it, otherwise show the raw position and say the bus is off the route.
    const proj = project(st.route, p.lat, p.lng, prev?.routeMeters ?? 0);
    // A phone that says its position is only good to 40 m may really be 40 m from the line it is driving on, so the distance that
    // still counts as "on the road" grows with the reported accuracy (up to 120 m): the bus stays on the street, not in a house.
    const snapLimit = Math.max(c.snapM, Math.min(120, (p.accuracy || 0) * 1.5));
    const onRoute = !!proj && proj.d <= snapLimit;
    // Progress along the road follows the nearest point of the road even when the bus is a little off it (a wide road, a lane the
    // map does not show); only a bus far away from the road keeps its last progress.
    const near = !!proj && proj.d <= 300;
    const meters = near ? Math.max(proj.meters, prev?.routeMeters ?? 0) : (prev?.routeMeters ?? (proj?.meters ?? 0));
    const lat = onRoute ? proj.lat : p.lat; const lng = onRoute ? proj.lng : p.lng;
    let heading = p.heading;
    if (prev && !jitter && distance(prev.lat, prev.lng, lat, lng) > 5) heading = bearing(prev.lat, prev.lng, lat, lng);
    else if (heading === null) heading = prev?.heading ?? null;
    const avg = kmh > 3 ? (prev?.avgKmh ? prev.avgKmh * 0.8 + kmh * 0.2 : kmh) : (prev?.avgKmh ?? null);
    live = { lat: jitter ? prev.lat : lat, lng: jitter ? prev.lng : lng, heading, speedKmh: kmh, avgKmh: avg, accuracy: p.accuracy, at: p.at, receivedAt: now, routeMeters: jitter ? prev.routeMeters : meters, offRoute: !onRoute };
    accepted += 1; moved = moved || !jitter;
    st.live = live;
    await followStops(st, live, c);
  }

  if (live && accepted) {
    const last = clean[clean.length - 1];
    await Transport.updateOne({ _id: st.id, school: st.school, busStatus: 'On Route' }, { $set: { live } });
    if (last && live.at - st.lastSample >= c.sampleMs) {
      st.lastSample = live.at;
      BusTripPoint.create({ school: st.school, bus: st.id, tripId: st.tripId, lat: live.lat, lng: live.lng, speedKmh: Math.round(live.speedKmh || 0), accuracy: live.accuracy ?? undefined, at: new Date(live.at) }).catch(() => {});
    }
    emit(st, { type: 'position', busId: st.id, tripId: st.tripId, signal: signal(st, now), position: publicPosition(live), currentStopIndex: st.current, etas: etas(st), serverTime: now });
    noticesFor(st, c).catch((err) => console.error('bus notices failed:', err.message));
  } else if (st.live) {
    // Nothing usable arrived, but the phone is talking to us: the signal is not lost.
    st.live = { ...st.live, receivedAt: now };
    await Transport.updateOne({ _id: st.id, school: st.school, busStatus: 'On Route' }, { $set: { 'live.receivedAt': now } });
  }
  return { accepted, rejected: list.length - accepted, reasons, currentStopIndex: st.current, etas: etas(st), serverTime: now };
}

// Subscribes to one bus's changes. Returns the function that stops listening.
function subscribe(busId, fn) {
  bus.on(String(busId), fn);
  return () => bus.off(String(busId), fn);
}

// Trips that were never ended (a phone that died): completed after this many hours without a reading.
async function closeAbandonedTrips(hours = 3, now = Date.now()) {
  const cutoff = now - hours * 3600 * 1000;
  const stale = await Transport.find({ busStatus: 'On Route', $or: [{ 'live.receivedAt': { $lt: cutoff } }, { live: { $exists: false }, tripStartedAt: { $lt: new Date(cutoff) } }] });
  for (const doc of stale) await endTrip(doc);
  return stale.length;
}

const resetForTests = () => { runtime.clear(); bus.removeAllListeners(); upgrading.forEach((t) => clearTimeout(t)); upgrading.clear(); };

module.exports = {
  distance, bearing, buildRoute, project, simplify, roadGeometry, tripStops, cfg,
  startTrip, endTrip, advance, ingest, snapshot, snapshotFor, subscribe, stateOf, forget, signal, etas, closeAbandonedTrips, resetForTests,
};
