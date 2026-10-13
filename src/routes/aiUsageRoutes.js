// The school admin's view of AI use and cost control. Mounted at /api/ai-usage behind protect only (not tied to one AI feature):
// a school that uses the AI Tutor but not Ask still sees its usage. Reading this makes no AI call.
const express = require('express');
const router = express.Router();
const { authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const { asyncHandler, HttpError } = require('../utils/http');
const aiUsage = require('../services/aiUsage');
const llm = require('../assistant/llm');

router.use(authorizeRoles('admin'), requirePermission('assistant.insights'));

// GET /api/ai-usage/summary?month=YYYY-MM  (default: this month)
router.get('/summary', asyncHandler(async (req, res) => {
  const month = req.query.month ? String(req.query.month) : undefined;
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month must look like 2026-10');
  const data = await aiUsage.summary(req.schoolId, req.entitlements, month);
  res.json({ success: true, data: { ...data, provider: { available: llm.available(), reason: llm.unavailableReason() } } });
}));

module.exports = router;
