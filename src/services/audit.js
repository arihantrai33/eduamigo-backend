const AuditLog = require('../models/AuditLog');

// Records an audit entry. Never throws: a failed audit write must not break the user's action,
// but it is logged so it can be noticed.
async function audit(req, action, { school, targetType = '', targetId = '', details = {} } = {}) {
  try {
    await AuditLog.create({
      school: school !== undefined ? school : (req?.schoolId || null),
      actor: req?.user?._id || req?.platformUser?._id || null,
      actorRole: req?.platformUser ? 'superadmin' : (req?.user?.role || ''),
      impersonatedBy: req?.impersonatedBy || null,
      action, targetType, targetId: targetId ? String(targetId) : '', details,
      ip: req?.ip || '',
    });
  } catch (err) {
    console.error(`Audit write failed (${action}):`, err.message);
  }
}

module.exports = { audit };
