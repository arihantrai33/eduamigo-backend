// No login needed. Used by the apps before sign-in: "find your school", branded login, own-domain portals.
const express = require('express');
const router = express.Router();
const { publicLookupLimiter } = require('../middleware/rateLimit');
const { HttpError, asyncHandler } = require('../utils/http');
const directory = require('../services/schoolDirectory');

router.use(publicLookupLimiter);

// GET /api/public/schools?search=green
router.get('/schools', asyncHandler(async (req, res) => {
  const schools = await directory.search(req.query.search);
  res.json({ success: true, data: schools.map(directory.publicProfile) });
}));

// GET /api/public/schools/by-domain?host=erp.greenvalley.edu.in
router.get('/schools/by-domain', asyncHandler(async (req, res) => {
  const school = await directory.findByDomain(req.query.host);
  if (!school) throw new HttpError(404, 'No school is set up for this address');
  res.json({ success: true, data: directory.publicProfile(school) });
}));

// GET /api/public/schools/GVPS
router.get('/schools/:code', asyncHandler(async (req, res) => {
  const school = await directory.findByCode(req.params.code);
  if (!school) throw new HttpError(404, 'School not found. Please check the code with your school.');
  res.json({ success: true, data: directory.publicProfile(school) });
}));

module.exports = router;
