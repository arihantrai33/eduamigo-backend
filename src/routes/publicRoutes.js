// No login needed. Used by the apps before sign-in: "find your school", branded login, own-domain portals.
const express = require('express');
const router = express.Router();
const { publicLookupLimiter, demoRequestLimiter } = require('../middleware/rateLimit');
const { HttpError, asyncHandler } = require('../utils/http');
const directory = require('../services/schoolDirectory');
const DemoRequest = require('../models/DemoRequest');

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

// POST /api/public/demo-requests: the "Request a demo" form on the website. Stores the request and sends nothing.
// A hidden field (`website`) that people never see is filled only by bots: those get the normal answer and nothing is saved.
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+]?[0-9][0-9\s-]{6,17}$/;
const STUDENTS = ['', 'under-300', '300-1000', '1000-3000', 'over-3000'];
const text = (v) => (typeof v === 'string' ? v.trim() : '');

router.post('/demo-requests', demoRequestLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const ok = { success: true, message: 'Thank you. We have received your request and will get back to you.' };
  if (text(body.website)) return res.status(201).json(ok);

  const data = {
    name: text(body.name), schoolName: text(body.schoolName), role: text(body.role),
    email: text(body.email).toLowerCase(), phone: text(body.phone), city: text(body.city),
    students: text(body.students), message: text(body.message),
  };
  const fieldErrors = {};
  if (data.name.length < 2 || data.name.length > 100) fieldErrors.name = 'Enter your name.';
  if (data.schoolName.length < 2 || data.schoolName.length > 150) fieldErrors.schoolName = 'Enter your school name.';
  if (!EMAIL.test(data.email) || data.email.length > 160) fieldErrors.email = 'Enter a valid email address.';
  if (data.phone && !PHONE.test(data.phone)) fieldErrors.phone = 'Enter a valid phone number, or leave it empty.';
  if (!STUDENTS.includes(data.students)) fieldErrors.students = 'Choose one of the options.';
  if (data.role.length > 60) fieldErrors.role = 'Keep this under 60 characters.';
  if (data.city.length > 80) fieldErrors.city = 'Keep this under 80 characters.';
  if (data.message.length > 1000) fieldErrors.message = 'Keep the message under 1000 characters.';
  if (Object.keys(fieldErrors).length) throw new HttpError(400, 'Please check the highlighted fields.', { fieldErrors });

  const day = new Date().toISOString().slice(0, 10);
  try {
    await DemoRequest.create({ ...data, dedupeKey: `${data.email}|${day}` });
  } catch (err) {
    // The same email already asked today (double click, retry, two tabs): answered as a success, saved once.
    if (err?.code !== 11000) throw err;
  }
  res.status(201).json(ok);
}));

module.exports = router;
