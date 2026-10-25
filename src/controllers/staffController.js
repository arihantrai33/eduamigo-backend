const User = require('../models/User');
const StaffProfile = require('../models/StaffProfile');
const { HttpError, asyncHandler, assertId } = require('../utils/http');
const { audit } = require('../services/audit');

const OFFICE_ROLES = ['accountant', 'staff'];

// GET /api/staff: the school's non-teaching staff accounts with their employee record (if one was filled in).
exports.list = asyncHandler(async (req, res) => {
  const users = await User.find({ school: req.schoolId, role: { $in: OFFICE_ROLES } }).select('name email role isActive extraRoles').populate('extraRoles', 'name').sort({ name: 1 }).lean();
  const profiles = await StaffProfile.find({ school: req.schoolId, user: { $in: users.map((u) => u._id) } }).lean();
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));
  res.json({ success: true, data: users.map((u) => ({ ...u, profile: byUser.get(String(u._id)) || null })) });
});

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

// PUT /api/staff/:userId   { employeeId, designation, department, phone, joiningDate }
exports.save = asyncHandler(async (req, res) => {
  assertId(req.params.userId);
  const user = await User.findOne({ _id: req.params.userId, school: req.schoolId, role: { $in: OFFICE_ROLES } }).select('_id');
  if (!user) throw new HttpError(404, 'Staff account not found');
  const b = req.body || {};
  const set = {};
  for (const [k, max] of [['employeeId', 30], ['designation', 80], ['department', 80], ['phone', 20]]) {
    const v = text(b[k], max);
    if (v !== undefined) set[k] = v;
  }
  if (b.joiningDate !== undefined) {
    const d = b.joiningDate ? new Date(b.joiningDate) : null;
    if (d && Number.isNaN(d.getTime())) throw new HttpError(400, 'Joining date is not a valid date');
    set.joiningDate = d;
  }
  try {
    const profile = await StaffProfile.findOneAndUpdate({ school: req.schoolId, user: user._id }, { $set: set, $setOnInsert: { school: req.schoolId, user: user._id } }, { upsert: true, returnDocument: 'after', runValidators: true });
    await audit(req, 'staff.profile_saved', { targetType: 'user', targetId: user._id, details: { fields: Object.keys(set) } });
    res.json({ success: true, data: profile });
  } catch (e) {
    if (e?.code === 11000) throw new HttpError(409, 'Another staff member already has this employee ID');
    throw e;
  }
});
