/* eslint-disable no-console */
// Drives a bus along its route against a running API, like a real driver phone would, for demos and for trying the screens:
//
//   node src/scripts/simulateBus.js <driverToken> [--api http://localhost:8000/api] [--kmh 30] [--speedup 1] [--direction pickup|drop] [--no-end]
//
// It starts the trip, follows the road (from the routing service, straight lines if it is not reachable) at the given speed,
// sends a GPS reading every 3 seconds with a little GPS noise, and ends the trip at the last stop. --speedup 2 makes the bus
// faster (at most 2.5: readings are stamped in real time, and a bus faster than the server accepts looks like a GPS jump).
// Open the Bus screen as a student or parent of this bus and watch it move.

const tracking = require('../services/busTracking');

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const token = process.argv[2];
if (!token || token.startsWith('--')) { console.error('Usage: node src/scripts/simulateBus.js <driverToken> [--api URL] [--kmh 30] [--speedup 1] [--direction pickup|drop]'); process.exit(1); }
const API = (arg('api', 'http://localhost:8000/api')).replace(/\/$/, '');
const KMH = Number(arg('kmh', 30));
// More than about 2.5x would make the bus move faster than the server accepts (it would see a GPS jump).
const SPEEDUP = Math.min(2.5, Math.max(0.2, Number(arg('speedup', 1))));
const DIRECTION = arg('direction', 'pickup');
const TICK_MS = 3000;

const call = async (method, path, body) => {
  const res = await fetch(`${API}/transport/driver/${token}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.message || ''}`);
  return json.data ?? json;
};

(async () => {
  const bus = await call('GET', '');
  console.log(`Bus ${bus.busNumber} (${bus.routeName}), ${bus.stops.length} stops`);
  const started = await call('PATCH', '/start-trip', { direction: DIRECTION });
  const stops = started.stops.map((s) => ({ lat: s.latitude, lng: s.longitude, name: s.name }));
  const road = await tracking.roadGeometry(stops);
  const points = road || stops.map((s) => [s.lat, s.lng]);
  const route = tracking.buildRoute(points);
  console.log(`Route: ${Math.round(route.meters)} m (${road ? 'road' : 'straight lines'}), ${DIRECTION}, ${KMH} km/h x${SPEEDUP}`);
  const at = (m) => {
    const { pts, cum } = route;
    let i = 1; while (i < cum.length - 1 && cum[i] < m) i += 1;
    const t = Math.min(1, Math.max(0, (m - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
  };
  let meters = 0;
  const step = (KMH / 3.6) * (TICK_MS / 1000) * SPEEDUP;
  for (;;) {
    const [lat, lng] = at(meters);
    const jitter = () => (Math.random() - 0.5) * 0.00004; // about 2 m of GPS noise
    const out = await call('POST', '/location', { points: [{ lat: lat + jitter(), lng: lng + jitter(), accuracy: 6 + Math.round(Math.random() * 6), speed: KMH / 3.6, at: Date.now() }] });
    process.stdout.write(`\r${Math.round(meters)} / ${Math.round(route.meters)} m, stop ${out.currentStopIndex + 1}/${stops.length}, ETA to the last stop ${out.etas.at(-1) ?? '-'} min   `);
    if (meters >= route.meters) break;
    meters = Math.min(route.meters, meters + step);
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  console.log('\nReached the last stop.');
  if (!process.argv.includes('--no-end')) { await call('PATCH', '/end-trip'); console.log('Trip ended.'); }
})().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
