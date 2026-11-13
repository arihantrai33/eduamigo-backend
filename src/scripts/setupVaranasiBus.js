/* eslint-disable no-console */
// Puts the demo school "Green Valley Public School" (code GVPS) in Varanasi and gives one of its buses a real route there, so the live bus
// can be tried on a real road with a real phone. Safe to run again: it updates the same bus instead of adding another.
//
//   MONGO_URI="mongodb+srv://.../eduamigo_staging" SEED_DEMO_OK=yes [CAPTAIN_CODE=GVPS-BUS-1] [PARENT_PASSWORD=...] [DNS_SERVERS=8.8.8.8,1.1.1.1] \
//     node src/scripts/setupVaranasiBus.js
//
// It refuses any database whose name does not end in _staging or _demo. What it does:
//   - school address and map position: Varanasi (a spot a short walk from Central Hindu Boys School, Kamachha)
//   - the bus Riya Sharma already rides (or the school's first bus): number, captain, route, four stops, idle, simple captain code
//   - Riya is on that bus and gets on at Gurubagh
//   - optional PARENT_PASSWORD: sets the sign-in password of Riya's parent (so the test login is known)
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const SCHOOL_CODE = 'GVPS';
const CITY = 'Varanasi';
const ADDRESS = 'Near Central Hindu Boys School, Kamachha, Bhelupur, Varanasi, Uttar Pradesh 221010';
// A short walk east of Central Hindu Boys School (25.30397, 82.99625).
const SCHOOL_AT = { lat: 25.3047, lng: 82.9975 };
const BUS = { busNumber: 'UP65 GV 0001', driverName: 'Ramesh Kumar', driverPhone: '9000011111', routeName: 'CHS - Rathyatra - Gurubagh' };
// Stops in the order the bus visits them when it goes to school. Coordinates: Central Hindu Boys School (Wikipedia), Rathyatra Mahmoorganj
// Road at the crossing and Gurubagh (OpenStreetMap), and the school itself.
const STOPS = [
  { name: 'CHS Boys School', latitude: 25.30397, longitude: 82.99625, estimatedTime: '07:00' },
  { name: 'Rathyatra Crossing', latitude: 25.3060, longitude: 82.9860, estimatedTime: '07:10' },
  { name: 'Gurubagh', latitude: 25.30738, longitude: 82.99644, estimatedTime: '07:20' },
  { name: 'Green Valley Public School', latitude: SCHOOL_AT.lat, longitude: SCHOOL_AT.lng, estimatedTime: '07:30' },
];
const RIYA_STOP = 'Gurubagh';

// `models` is passed in so tests can use the same module instances as the test database.
async function apply({ captainCode = 'GVPS-BUS-1', parentPassword = '' } = {}) {
  const School = require('../models/School');
  const Student = require('../models/Student');
  const Parent = require('../models/Parent');
  const User = require('../models/User');
  const Transport = require('../models/Transport');
  const { hashPassword } = require('../services/credentials');

  if (!/^[A-Za-z0-9-]{8,40}$/.test(captainCode)) throw new Error('CAPTAIN_CODE must be 8-40 letters, digits or dashes');
  const school = await School.findOne({ code: SCHOOL_CODE });
  if (!school) throw new Error(`No school with code ${SCHOOL_CODE} in this database`);
  const riya = await Student.findOne({ school: school._id, name: 'Riya Sharma', isActive: true });
  if (!riya) throw new Error('Student "Riya Sharma" not found in GVPS');

  await School.updateOne({ _id: school._id }, { $set: { city: CITY, address: ADDRESS, location: SCHOOL_AT } });

  let bus = riya.bus ? await Transport.findOne({ _id: riya.bus, school: school._id }) : null;
  bus = bus || (await Transport.findOne({ school: school._id }).sort({ createdAt: 1 }));
  if (!bus) throw new Error('GVPS has no bus to update. Create one in Admin > Transport first.');
  const taken = await Transport.findOne({ driverToken: captainCode, _id: { $ne: bus._id } }).select('_id').setOptions({ crossTenant: 'a captain code must be unique across all schools' });
  if (taken) throw new Error(`The captain code ${captainCode} is already used by another bus`);

  Object.assign(bus, BUS, {
    driverToken: captainCode, busStatus: 'Idle', currentStopIndex: 0, direction: 'pickup', tripId: undefined, driverDevice: undefined,
    tripStartedAt: undefined, tripEndedAt: undefined, tripNotices: [], live: undefined, route: undefined, boardedStudents: [],
  });
  bus.stops = STOPS.map((s, i) => ({ ...s, order: i + 1, status: 'Pending' }));
  if (!bus.assignedStudents.some((id) => String(id) === String(riya._id))) bus.assignedStudents.push(riya._id);
  bus.capacity = Math.max(bus.capacity || 40, bus.assignedStudents.length);
  bus.availableSeats = bus.capacity - bus.assignedStudents.length;
  await bus.save();

  // Other buses of the school lose Riya, and Riya gets on at Gurubagh.
  await Transport.updateMany({ school: school._id, _id: { $ne: bus._id } }, { $pull: { assignedStudents: riya._id } });
  const stop = bus.stops.find((s) => s.name === RIYA_STOP);
  await Student.updateOne({ _id: riya._id, school: school._id }, { $set: { bus: bus._id, busStopId: stop._id } });

  const parent = riya.parentUserId ? await User.findOne({ _id: riya.parentUserId, school: school._id }) : null;
  const parentRow = await Parent.findOne({ school: school._id, children: riya._id });
  if (parent && parentPassword) {
    await User.updateOne({ _id: parent._id, school: school._id }, { $set: { password: await hashPassword(parentPassword), mustChangePassword: false }, $inc: { tokenVersion: 1 } });
  }
  return {
    school: { code: school.code, city: CITY, address: ADDRESS },
    bus: { id: String(bus._id), busNumber: bus.busNumber, captainCode, stops: bus.stops.map((s) => s.name) },
    riya: { name: riya.name, admissionNo: riya.admissionNo || riya.rollNumber, stop: RIYA_STOP },
    parent: parent ? { name: parentRow?.name, loginId: parentRow?.phone || parent.email, schoolCode: school.code, passwordSet: Boolean(parentPassword) } : null,
  };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const dbName = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://')).pathname.replace('/', '').split('?')[0];
  if (!/_(staging|demo)$/.test(dbName)) throw new Error(`Refusing database "${dbName}": its name must end in _staging or _demo`);
  if (process.env.SEED_DEMO_OK !== 'yes') throw new Error('Set SEED_DEMO_OK=yes to confirm this is a staging/demo database');
  // Some networks (phone hotspots, a few ISPs) cannot look up Atlas's mongodb+srv address ("querySrv EBADRESP"): DNS_SERVERS=8.8.8.8,1.1.1.1 asks those servers instead.
  if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const out = await apply({ captainCode: process.env.CAPTAIN_CODE || undefined, parentPassword: process.env.PARENT_PASSWORD || '' });
  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
}

module.exports = { apply, STOPS };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
