const express = require('express');
const router  = express.Router();
const School  = require('../models/School');
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');

// GET /api/schools/subjects — school ki subjects list
const { currentAcademicYear } = require('../utils/dates');

const publicSchool = (school) => ({
  _id: school._id,
  name: school.name,
  address: school.address,
  phone: school.phone,
  email: school.email,
  principal: school.principal,
  workingDays: school.workingDays,
  location: school.location?.lat != null ? school.location : null,
  academicYear: currentAcademicYear(),
});

// GET /api/schools/me — basic school profile for every signed-in user (name, contact, location)
router.get('/me', protect, async (req, res, next) => {
  try {
    const school = await School.findById(req.schoolId);
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });
    res.json({ success: true, data: publicSchool(school) });
  } catch (err) { next(err); }
});

// PUT /api/schools/me — update school profile (settings permission)
router.put('/me', protect, requirePermission('settings.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const update = {};
    for (const key of ['name', 'address', 'phone', 'email', 'principal', 'workingDays']) {
      if (body[key] !== undefined) update[key] = typeof body[key] === 'string' ? body[key].trim() : body[key];
    }
    if (update.name === '') return res.status(400).json({ success: false, message: 'School name is required' });
    if (body.location) {
      const lat = Number(body.location.lat);
      const lng = Number(body.location.lng);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return res.status(400).json({ success: false, message: 'Invalid school location' });
      update.location = { lat, lng };
    }
    const school = await School.findByIdAndUpdate(req.schoolId, update, { returnDocument: 'after', runValidators: true });
    res.json({ success: true, data: publicSchool(school) });
  } catch (err) { next(err); }
});

router.get('/subjects', protect, async (req, res) => {
  try {
    const school = await School.findById(req.user.school._id || req.user.school);
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });
    res.json({ success: true, data: school.customSubjects || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/schools/subjects — add a custom subject
router.post('/subjects', protect, requirePermission('settings.manage'), async (req, res) => {
  try {
    const { subject } = req.body;
    if (!subject?.trim()) return res.status(400).json({ success: false, message: 'Subject is required' });
    const school = await School.findById(req.user.school._id || req.user.school);
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });
    if (school.customSubjects.includes(subject.trim())) {
      return res.status(400).json({ success: false, message: 'Subject already exists' });
    }
    school.customSubjects.push(subject.trim());
    await school.save();
    res.json({ success: true, data: school.customSubjects });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/schools/subjects — remove a custom subject
router.delete('/subjects', protect, requirePermission('settings.manage'), async (req, res) => {
  try {
    const { subject } = req.body;
    const school = await School.findById(req.user.school._id || req.user.school);
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });
    school.customSubjects = school.customSubjects.filter(s => s !== subject);
    await school.save();
    res.json({ success: true, data: school.customSubjects });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;