const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/academicController');
const { audited } = require('../middleware/auditTrail');

router.use(protect);

// Everyone in the school can read the session and class list (needed for dropdowns and filters).
router.get('/sessions', c.listSessions);
router.get('/classes', c.listClasses);
router.get('/settings', c.getSettings);

router.get('/setup-status', requirePermission('academics.manage'), c.setupStatus);
router.post('/sessions', requirePermission('academics.manage'), audited('session.created', 'session', 'name'), c.createSession);
router.patch('/sessions/:id/current', requirePermission('academics.manage'), audited('session.made_current', 'session'), c.makeCurrent);
router.post('/classes/import', requirePermission('academics.manage'), audited('classes.imported', 'class'), c.importClasses);
router.post('/classes', requirePermission('academics.manage'), audited('class.created', 'class', 'name'), c.createClass);
router.put('/classes/:id', requirePermission('academics.manage'), audited('class.updated', 'class'), c.updateClass);
router.delete('/classes/:id', requirePermission('academics.manage'), audited('class.deleted', 'class'), c.deleteClass);
router.put('/settings', requirePermission('academics.manage'), audited('academic.settings_changed', 'school'), c.saveSettings);
router.get('/year-end', requirePermission('academics.manage'), c.yearEndPreview);
router.post('/year-end', requirePermission('academics.manage'), audited('year_end.applied', 'session', 'toSession'), c.yearEndApply);

module.exports = router;
