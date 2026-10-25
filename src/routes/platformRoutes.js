// EduAmigo platform owner API. Separate sign-in and token scope from school users:
// a school token never works here, and a platform token never works on school APIs.
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/User');
const { jwtSecret } = require('../config/env');
const { loginLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/platformController');
const ic = require('../controllers/integrationController');
const oc = require('../controllers/platformOpsController');
const { integrationTestLimiter } = require('../middleware/rateLimit');
const { isRevoked } = require('../services/tokens');
const { can: platformCan } = require('../config/platformPermissions');

// 403 unless the signed-in platform account's role includes the permission.
const need = (permission) => (req, res, next) => (platformCan(req.platformUser, permission) ? next() : res.status(403).json({ success: false, message: 'Your role does not include this action. Ask an owner.' }));

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
router.get('/stats', need('analytics.read'), c.stats);
router.get('/catalog', need('schools.read'), c.catalog);
router.put('/plans/:code', need('billing.manage'), c.savePlan);
router.put('/addons/:feature', need('billing.manage'), c.saveAddOn);

router.get('/schools', need('schools.read'), c.listSchools);
router.post('/schools', need('schools.manage'), c.createSchool);
router.get('/schools/:id', need('schools.read'), c.getSchool);
router.patch('/schools/:id', need('schools.manage'), c.updateSchool);
router.post('/schools/:id/subscription/preview', need('billing.manage'), c.previewSubscription);
router.patch('/schools/:id/subscription', need('billing.manage'), c.updateSubscription);
router.post('/schools/:id/support-session', need('support.session'), c.supportSession);
router.get('/schools/:id/invoice-preview', need('billing.read'), c.previewInvoice);
router.post('/schools/:id/invoices', need('billing.manage'), c.createInvoice);
router.get('/invoices', need('billing.read'), c.listInvoices);
router.get('/invoices/:id', need('billing.read'), c.getInvoice);
router.patch('/invoices/:id', need('billing.manage'), c.updateInvoice);

router.get('/audit', need('audit.read'), c.auditLog);

// Email & SMS integrations and platform health (see services/integrations.js)
router.get('/integrations', need('integrations.read'), ic.overview);
router.put('/integrations/email', need('integrations.manage'), ic.saveEmail);
router.post('/integrations/email/verify', need('integrations.manage'), integrationTestLimiter, ic.verifyEmail);
router.post('/integrations/email/sender-check', need('integrations.manage'), integrationTestLimiter, ic.senderChecks);
router.post('/integrations/email/test', need('integrations.manage'), integrationTestLimiter, ic.testEmail);
router.post('/integrations/email/confirm', need('integrations.manage'), ic.confirmEmail);
router.put('/integrations/sms', need('integrations.manage'), ic.saveSms);
router.post('/integrations/sms/otp/request', need('integrations.manage'), integrationTestLimiter, ic.requestOtp);
router.post('/integrations/sms/otp/verify', need('integrations.manage'), integrationTestLimiter, ic.verifyOtp);
router.get('/integrations/logs', need('integrations.read'), ic.logs);
router.get('/health', need('health.read'), ic.health);

// Overview analytics, platform accounts, announcements, support requests, settings (controllers/platformOpsController.js)
router.get('/analytics', need('analytics.read'), oc.analytics);
router.get('/roles', need('users.read'), oc.listRoles);
router.get('/users', need('users.read'), oc.listUsers);
router.post('/users', need('users.manage'), oc.createUser);
router.patch('/users/:id', need('users.manage'), oc.updateUser);
router.post('/users/:id/reset-password', need('users.manage'), integrationTestLimiter, oc.resetUserPassword);
router.get('/notices', need('support.read'), oc.listNotices);
router.post('/notices', need('notices.manage'), oc.createNotice);
router.post('/notices/:id/archive', need('notices.manage'), oc.archiveNotice);
router.get('/support', need('support.read'), oc.listSupport);
router.get('/support/:id', need('support.read'), oc.getSupport);
router.patch('/support/:id', need('support.manage'), oc.updateSupport);
router.get('/settings', need('settings.read'), oc.getSettings);
router.put('/settings', need('settings.manage'), oc.saveSettings);

module.exports = router;
