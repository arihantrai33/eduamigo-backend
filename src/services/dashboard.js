// The staff dashboard in one request, counted in the database instead of in the browser.
// Each section is included only when the signed-in role may see it and the school's plan has the module,
// so the dashboard never shows (or computes) something the person cannot open.
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const Parent = require('../models/Parent');
const Transport = require('../models/Transport');
const Attendance = require('../models/Attendance');
const Fee = require('../models/Fee');
const LeaveRequest = require('../models/LeaveRequest');
const AuditLog = require('../models/AuditLog');
const { hasPermission } = require('../config/permissions');
const { hasFeature } = require('./subscription');
const { summarizeCounts } = require('./attendanceService');
const { toDayKey } = require('../utils/dates');

const round2 = (n) => Math.round((n || 0) * 100) / 100;

async function schoolDashboard({ schoolId, role, entitlements, now = new Date() }) {
  const can = (permission) => hasPermission(role, permission);
  const has = (feature) => hasFeature(entitlements, feature);
  const school = schoolId;
  const jobs = {};

  if (can('students.read')) {
    jobs.students = Student.countDocuments({ school, isActive: true });
    jobs.classes = Student.aggregate([
      { $match: { school, isActive: true } },
      { $group: { _id: { class: '$class', section: '$section' }, count: { $sum: 1 } } },
      { $sort: { count: -1, '_id.class': 1, '_id.section': 1 } },
      { $limit: 6 },
    ]);
    jobs.recentStudents = Student.find({ school, isActive: true }).sort({ createdAt: -1 }).limit(5)
      .select('name class section rollNumber feeStatus photo photoKey createdAt');
  }
  if (can('teachers.read')) jobs.teachers = Teacher.countDocuments({ school, isActive: true });
  if (can('parents.read')) jobs.parents = Parent.countDocuments({ school, userId: { $ne: null } });
  if (can('transport.manage') && has('transport')) jobs.buses = Transport.countDocuments({ school });
  if (can('attendance.reports')) {
    jobs.attendance = Attendance.aggregate([
      { $match: { school, date: toDayKey(now) } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    if (!jobs.students) jobs.activeStudents = Student.countDocuments({ school, isActive: true });
  }
  if (can('fees.read') && has('fees')) {
    jobs.fees = Fee.aggregate([
      { $match: { school } },
      { $group: { _id: null, billed: { $sum: '$amount' }, collected: { $sum: '$paidAmount' }, records: { $sum: 1 } } },
    ]);
  }
  if (can('leaves.review')) jobs.pendingLeaves = LeaveRequest.countDocuments({ school, status: 'Pending' });
  if (can('audit.read')) {
    jobs.activity = AuditLog.find({ school }).sort({ createdAt: -1 }).limit(6)
      .populate('actor', 'name').select('action actorRole targetType details createdAt actor').lean();
  }

  const keys = Object.keys(jobs);
  const values = await Promise.all(keys.map((k) => jobs[k]));
  const r = Object.fromEntries(keys.map((k, i) => [k, values[i]]));

  const out = { date: toDayKey(now) };
  if ('students' in r) {
    out.counts = { students: r.students };
    out.classes = r.classes.map((c) => ({ class: c._id.class, section: c._id.section, count: c.count }));
    out.recentStudents = r.recentStudents.map((s) => s.toJSON());
  }
  if ('teachers' in r) out.counts = { ...out.counts, teachers: r.teachers };
  if ('parents' in r) out.counts = { ...out.counts, parents: r.parents };
  if ('buses' in r) out.counts = { ...out.counts, buses: r.buses };
  if ('attendance' in r) {
    const byStatus = Object.fromEntries(r.attendance.map((x) => [x._id, x.n]));
    const marked = r.attendance.reduce((t, x) => t + x.n, 0);
    const active = 'activeStudents' in r ? r.activeStudents : r.students;
    out.attendance = { ...summarizeCounts(byStatus), marked, totalStudents: active, notMarked: Math.max(0, active - marked) };
  }
  if ('fees' in r) {
    const f = r.fees[0] || { billed: 0, collected: 0, records: 0 };
    out.fees = { billed: round2(f.billed), collected: round2(f.collected), due: round2(Math.max(0, f.billed - f.collected)), records: f.records };
  }
  if ('pendingLeaves' in r) out.pendingLeaves = r.pendingLeaves;
  if ('activity' in r) {
    out.activity = r.activity.map((a) => ({ action: a.action, by: a.actor?.name || null, role: a.actorRole, at: a.createdAt, targetType: a.targetType }));
  }
  return out;
}

module.exports = { schoolDashboard };
