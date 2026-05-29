const express = require('express');
const router  = express.Router();
const School  = require('../models/School');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// GET /api/schools/subjects — school ki subjects list
router.get('/subjects', protect, async (req, res) => {
  try {
    const school = await School.findById(req.user.school._id || req.user.school);
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });
    res.json({ success: true, data: school.customSubjects || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/schools/subjects — naya subject add karo
router.post('/subjects', protect, authorizeRoles('admin'), async (req, res) => {
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

// DELETE /api/schools/subjects — subject remove karo
router.delete('/subjects', protect, authorizeRoles('admin'), async (req, res) => {
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