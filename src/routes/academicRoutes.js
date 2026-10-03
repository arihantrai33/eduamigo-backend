const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/academicController');

router.use(protect);

// Everyone in the school can read the session and class list (needed for dropdowns and filters).
router.get('/sessions', c.listSessions);
router.get('/classes', c.listClasses);
router.get('/settings', c.getSettings);

router.get('/setup-status', requirePermission('academics.manage'), c.setupStatus);
router.post('/sessions', requirePermission('academics.manage'), c.createSession);
router.patch('/sessions/:id/current', requirePermission('academics.manage'), c.makeCurrent);
router.post('/classes/import', requirePermission('academics.manage'), c.importClasses);
router.post('/classes', requirePermission('academics.manage'), c.createClass);
router.put('/classes/:id', requirePermission('academics.manage'), c.updateClass);
router.delete('/classes/:id', requirePermission('academics.manage'), c.deleteClass);
router.put('/settings', requirePermission('academics.manage'), c.saveSettings);

module.exports = router;
