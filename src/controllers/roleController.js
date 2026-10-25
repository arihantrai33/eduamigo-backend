const SchoolRole = require('../models/SchoolRole');
const User = require('../models/User');
const { PERMISSIONS } = require('../config/permissions');
const { ROLE_TEMPLATES, SCOPE_FAMILIES } = require('../config/roleTemplates');
const roles = require('../services/roles');
const { PROFILES } = require('../config/onboardingProfiles');
const { audit } = require('../services/audit');
const { asyncHandler } = require('../utils/http');

const view = (r, holders = 0) => ({
  _id: r._id, key: r.key, name: r.name, description: r.description, templateKey: r.templateKey,
  permissions: r.permissions, scopes: roles.plain(r.scopes), isSystem: r.isSystem, isActive: r.isActive, holders,
});

// GET /api/roles: this school's roles, the templates to start from, the permission catalogue and the scope families.
exports.list = asyncHandler(async (req, res) => {
  await roles.ensureSystemRoles(req.schoolId);
  const docs = await SchoolRole.find({ school: req.schoolId }).sort({ isSystem: -1, name: 1 });
  const counts = await User.aggregate([{ $match: { school: req.schoolId, extraRoles: { $exists: true, $ne: [] } } }, { $unwind: '$extraRoles' }, { $group: { _id: '$extraRoles', n: { $sum: 1 } } }]);
  const held = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  const base = await User.aggregate([{ $match: { school: req.schoolId } }, { $group: { _id: '$role', n: { $sum: 1 } } }]);
  const byRole = Object.fromEntries(base.map((c) => [c._id, c.n]));
  res.json({
    success: true,
    data: {
      roles: docs.map((r) => view(r, r.isSystem ? (byRole[r.key] || 0) : (held[String(r._id)] || 0))),
      templates: ROLE_TEMPLATES,
      permissions: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
      scopeFamilies: SCOPE_FAMILIES,
    },
  });
});

// GET /api/roles/recommendations: roles to consider for this school's size, and which of them it already has.
exports.recommendations = asyncHandler(async (req, res) => {
  const School = require('../models/School');
  const school = await School.findById(req.schoolId).select('profile').lean();
  const size = school?.profile?.size || '';
  const profile = PROFILES[size] || null;
  if (!profile) return res.json({ success: true, data: { size: '', profile: null, templates: [] } });
  const have = new Set((await SchoolRole.find({ school: req.schoolId, isSystem: false }).select('templateKey').lean()).map((r) => r.templateKey));
  const templates = profile.templates.map((key) => ROLE_TEMPLATES.find((t) => t.key === key)).filter(Boolean)
    .map((t) => ({ key: t.key, name: t.name, description: t.description, created: have.has(t.key) }));
  res.json({ success: true, data: { size, profile: { label: profile.label, hint: profile.hint, staffNote: profile.staffNote }, templates } });
});

exports.create = asyncHandler(async (req, res) => {
  const role = await roles.createRole(req.user, req.schoolId, req.body);
  await audit(req, 'role.created', { targetType: 'role', targetId: role._id, details: { name: role.name, templateKey: role.templateKey, permissions: role.permissions } });
  res.status(201).json({ success: true, data: view(role) });
});

exports.update = asyncHandler(async (req, res) => {
  const { role, details } = await roles.updateRole(req.user, req.schoolId, req.params.id, req.body);
  await audit(req, 'role.updated', { targetType: 'role', targetId: role._id, details });
  res.json({ success: true, data: view(role) });
});

exports.preview = asyncHandler(async (req, res) => {
  const role = await roles.loadRole(req.schoolId, req.params.id);
  res.json({ success: true, data: await roles.previewChange(req.schoolId, role, req.body) });
});

exports.remove = asyncHandler(async (req, res) => {
  const role = await roles.deleteRole(req.user, req.schoolId, req.params.id);
  await audit(req, 'role.deleted', { targetType: 'role', targetId: role._id, details: { name: role.name } });
  res.json({ success: true, message: 'Role deleted' });
});

// PUT /api/users/:id/roles { roleIds }
exports.assign = asyncHandler(async (req, res) => {
  const { target, details } = await roles.assignRoles(req.user, req.schoolId, req.params.id, req.body?.roleIds);
  await audit(req, 'user.roles_changed', { targetType: 'user', targetId: target._id, details });
  res.json({ success: true, data: { _id: target._id, extraRoles: target.extraRoles } });
});

exports.access = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await roles.accessOf(req.schoolId, req.params.userId) });
});
