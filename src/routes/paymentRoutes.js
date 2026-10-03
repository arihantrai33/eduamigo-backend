const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission, requireFeature } = require('../middleware/authMiddleware');
const c = require('../controllers/paymentController');

// The webhook is mounted separately in app.js (it needs the raw body and has no login).
router.use(protect);
// Config stays open so apps can ask "is online payment on?" and get { enabled: false } instead of an error.
router.get('/config',    c.getConfig);
router.use(requireFeature('online_payments'));
router.get('/settings',  requirePermission('settings.manage'), c.getSettings);
router.put('/settings',  requirePermission('settings.manage'), c.saveSettings);
router.get('/orders',    requirePermission('fees.read'), c.listOrders);
router.post('/orders',   authorizeRoles('parent', 'student'), c.createOrder);
router.post('/verify',   authorizeRoles('parent', 'student'), c.verifyPayment);

module.exports = router;
