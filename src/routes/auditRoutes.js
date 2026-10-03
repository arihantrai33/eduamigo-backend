// School activity log: who changed what in this school (marks, fees, students, users, settings...).
// GET /api/audit?action=marks.&actor=<userId>&from=2026-10-01&to=2026-10-31&page=1&limit=50
const express = require('express');
const router = express.Router();
const AuditLog = require('../models/AuditLog');
const { protect, requirePermission } = require('../middleware/authMiddleware');
const { asyncHandler, assertId, HttpError, escapeRegex } = require('../utils/http');
const { pageParams, paged } = require('../utils/paginate');

router.get('/', protect, requirePermission('audit.read'), asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.action) filter.action = { $regex: `^${escapeRegex(String(req.query.action))}` };  // "marks." matches every marks action
  if (req.query.actor) { assertId(req.query.actor, 'actor'); filter.actor = req.query.actor; }
  const range = {};
  for (const [key, op] of [['from', '$gte'], ['to', '$lte']]) {
    if (!req.query[key]) continue;
    const d = new Date(req.query[key]);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `${key} is not a valid date`);
    if (key === 'to') d.setUTCHours(23, 59, 59, 999);
    range[op] = d;
  }
  if (Object.keys(range).length) filter.createdAt = range;

  const paging = pageParams({ page: req.query.page || 1, limit: req.query.limit || 50 });
  const result = await paged(AuditLog, filter, paging, (q) => q.sort({ createdAt: -1 }).populate('actor', 'name role').lean());
  // Support sessions by EduAmigo staff are shown as such, without exposing platform account details.
  result.data = result.data.map((row) => ({ ...row, impersonatedBy: row.impersonatedBy ? 'EduAmigo support' : null }));
  res.json({ success: true, ...result });
}));

module.exports = router;
