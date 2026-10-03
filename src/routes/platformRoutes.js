// EduAmigo platform owner API. Separate sign-in and token scope from school users:
// a school token never works here, and a platform token never works on school APIs.
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/User');
const { jwtSecret } = require('../config/env');
const { loginLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/platformController');
const { isRevoked } = require('../services/tokens');

const protectPlatform = async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Authentication required' });
  let decoded;
  try {
    decoded = jwt.verify(header.slice(7), jwtSecret());
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }
  if (decoded.scope !== 'platform') return res.status(403).json({ success: false, message: 'Platform access only' });
  try {
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive || user.role !== 'superadmin') return res.status(401).json({ success: false, message: 'Authentication required' });
    if (isRevoked(decoded, user)) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    req.platformUser = user;
    next();
  } catch (err) {
    next(err);
  }
};

router.post('/login', loginLimiter, c.login);

router.use(protectPlatform);
router.get('/me', c.me);
router.get('/stats', c.stats);
router.get('/catalog', c.catalog);
router.put('/plans/:code', c.savePlan);
router.put('/addons/:feature', c.saveAddOn);

router.get('/schools', c.listSchools);
router.post('/schools', c.createSchool);
router.get('/schools/:id', c.getSchool);
router.patch('/schools/:id', c.updateSchool);
router.patch('/schools/:id/subscription', c.updateSubscription);
router.post('/schools/:id/support-session', c.supportSession);

router.get('/audit', c.auditLog);

module.exports = router;
