const express = require('express');
const router  = express.Router();
const School  = require('../models/School');
const streamifier = require('streamifier');
const { protect, requirePermission } = require('../middleware/authMiddleware');
const uploadImage = require('../middleware/uploadImageMiddleware');
const cloudinary = require('../config/cloudinary');
const { currentSessionName } = require('../services/academic');
const { HttpError, asyncHandler } = require('../utils/http');
const { CORE_MODULES } = require('../config/features');
const { audited } = require('../middleware/auditTrail');

const publicSchool = (school, entitlements, academicYear) => ({
  _id: school._id,
  name: school.name,
  code: school.code,
  city: school.city || '',
  address: school.address,
  phone: school.phone,
  email: school.email,
  principal: school.principal,
  workingDays: school.workingDays,
  size: school.profile?.size || '',
  location: school.location?.lat != null ? school.location : null,
  academicYear,
  branding: {
    appName: school.branding?.appName || school.name,
    logoUrl: school.branding?.logoUrl || '',
    primaryColor: school.branding?.primaryColor || '',
    accentColor: school.branding?.accentColor || '',
    tagline: school.branding?.tagline || '',
    heroStyle: school.branding?.heroStyle || 'bold',
  },
  customDomain: school.customDomain || null,
  // What the school has bought, for the settings screen and to show/hide modules.
  plan: entitlements?.plan || null,
  features: entitlements?.features || [],
  coreModules: CORE_MODULES,
  limits: entitlements?.limits || null,
  subscription: entitlements?.state || null,
});

function uploadLogo(buffer, schoolId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `school_logos/${schoolId}`, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result)),
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// GET /api/schools/me — basic school profile for every signed-in user (name, contact, location)
router.get('/me', protect, async (req, res, next) => {
  try {
    const school = await School.findById(req.schoolId);
    if (!school) return res.status(404).json({ success: false, message: 'School not found' });
    res.json({ success: true, data: publicSchool(school, req.entitlements, await currentSessionName(req.schoolId)) });
  } catch (err) { next(err); }
});

// PUT /api/schools/me — update school profile (settings permission)
router.put('/me', protect, requirePermission('settings.manage'), audited('school.profile_updated', 'school'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const update = {};
    for (const key of ['name', 'city', 'address', 'phone', 'email', 'principal', 'workingDays']) {
      if (body[key] !== undefined) update[key] = typeof body[key] === 'string' ? body[key].trim() : body[key];
    }
    if (body.size !== undefined) {
      if (!['', 'small', 'medium', 'large'].includes(body.size)) return res.status(400).json({ success: false, message: 'School size must be small, medium or large' });
      update['profile.size'] = body.size;
    }
    if (update.name === '') return res.status(400).json({ success: false, message: 'School name is required' });
    if (body.location) {
      const lat = Number(body.location.lat);
      const lng = Number(body.location.lng);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return res.status(400).json({ success: false, message: 'Invalid school location' });
      update.location = { lat, lng };
    }
    const school = await School.findByIdAndUpdate(req.schoolId, update, { returnDocument: 'after', runValidators: true });
    res.json({ success: true, data: publicSchool(school, req.entitlements, await currentSessionName(req.schoolId)) });
  } catch (err) { next(err); }
});

// PUT /api/schools/me/branding — app name, colour, tagline and logo (multipart field "logo", optional)
// Code and custom domain are set by EduAmigo (platform API) because they change how people find the school.
router.put('/me/branding', protect, requirePermission('settings.manage'), uploadImage.single('logo'), audited('school.branding_updated', 'school'), asyncHandler(async (req, res) => {
  const school = await School.findById(req.schoolId);
  if (!school) throw new HttpError(404, 'School not found');
  const body = req.body || {};
  for (const key of ['appName', 'primaryColor', 'accentColor', 'tagline', 'heroStyle']) {
    if (body[key] !== undefined) school.branding[key] = String(body[key] || '').trim();
  }
  if (body.removeLogo === 'true' || body.removeLogo === true) school.branding.logoUrl = '';
  if (req.file) {
    const uploaded = await uploadLogo(req.file.buffer, school._id);
    school.branding.logoUrl = uploaded.secure_url;
  }
  await school.save();
  res.json({ success: true, data: publicSchool(school, req.entitlements, await currentSessionName(req.schoolId)) });
}));

// GET /api/schools/me/dashboard — staff dashboard numbers, counted on the server; sections follow the role's permissions
router.get('/me/dashboard', protect, asyncHandler(async (req, res) => {
  const { schoolDashboard } = require('../services/dashboard');
  const data = await schoolDashboard({ schoolId: req.schoolId, user: req.user, role: req.user.role, entitlements: req.entitlements });
  res.json({ success: true, data });
}));

// GET /api/schools/me/invoices — EduAmigo bills for this school (issued and paid; drafts stay private)
router.get('/me/invoices', protect, requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const Invoice = require('../models/Invoice');
  const invoices = await Invoice.find({ school: req.schoolId, status: { $in: ['issued', 'paid'] } })
    .select('-createdBy -notes').sort({ periodFrom: -1 }).lean();
  res.json({ success: true, data: invoices });
}));

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