// The Varanasi demo setup script: school address, a four-stop route, Riya on the bus, a simple captain code, and the captain and parent
// can really use them through the API. Running it twice changes nothing more.
const { api, connect, disconnect, clear, seedSchool } = require('./helpers');
const School = require('../src/models/School');
const Student = require('../src/models/Student');
const Transport = require('../src/models/Transport');
const User = require('../src/models/User');
const { apply } = require('../src/scripts/setupVaranasiBus');

beforeAll(connect);
afterAll(disconnect);

let ctx;
beforeEach(async () => {
  await clear();
  ctx = await seedSchool('Green Valley Public School');
  await School.updateOne({ _id: ctx.school._id }, { code: 'GVPS', city: 'Jaipur' });
  await Student.updateOne({ _id: ctx.student._id }, { name: 'Riya Sharma' });
  await Transport.create({
    school: ctx.school._id, busNumber: 'BR02 PA 4521', driverName: 'Old', driverPhone: '9000011111', routeName: 'Old Route',
    driverToken: 'f'.repeat(32), trackingId: 'trk-old', stops: [{ name: 'Old', latitude: 24.75, longitude: 84.99, order: 1 }],
  });
});

test('puts the school in Varanasi and gives Riya a four-stop bus with a simple captain code', async () => {
  const out = await apply({ captainCode: 'GVPS-BUS-1', parentPassword: 'Test@12345' });
  const school = await School.findById(ctx.school._id);
  expect(school.city).toBe('Varanasi');
  expect(school.address).toMatch(/Varanasi/);
  expect(school.location.lat).toBeCloseTo(25.3047, 3);

  const bus = await Transport.findOne({ school: ctx.school._id });
  expect(bus.driverToken).toBe('GVPS-BUS-1');
  expect(bus.stops.map((s) => s.name)).toEqual(['CHS Boys School', 'Rathyatra Crossing', 'Gurubagh', 'Green Valley Public School']);
  expect(bus.assignedStudents.map(String)).toEqual([String(ctx.student._id)]);
  const riya = await Student.findById(ctx.student._id);
  expect(String(riya.bus)).toBe(String(bus._id));
  expect(String(riya.busStopId)).toBe(String(bus.stops[2]._id));
  expect(out.parent.passwordSet).toBe(true);

  // The captain code opens the captain's view, and a trip can start.
  const view = await api().get('/api/transport/driver/GVPS-BUS-1');
  expect(view.status).toBe(200);
  const started = await api().patch('/api/transport/driver/GVPS-BUS-1/start-trip').send({});
  expect(started.status).toBe(200);
});

test('running it again changes nothing and keeps one bus', async () => {
  await apply({ captainCode: 'GVPS-BUS-1' });
  await apply({ captainCode: 'GVPS-BUS-1' });
  const buses = await Transport.find({ school: ctx.school._id });
  expect(buses).toHaveLength(1);
  expect(buses[0].stops).toHaveLength(4);
  expect(buses[0].assignedStudents).toHaveLength(1);
});

test('the parent can sign in with the password it set, and a short captain code is refused', async () => {
  await apply({ captainCode: 'GVPS-BUS-1', parentPassword: 'Test@12345' });
  const parent = await User.findById(ctx.parentUser._id);
  expect(parent.mustChangePassword).toBe(false);
  await expect(apply({ captainCode: 'abc' })).rejects.toThrow(/8-40/);
});
