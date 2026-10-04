const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const { assistantLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/assistantController');

// EduAmigo Ask (plan feature ai_assistant, checked where the router is mounted).
const SCHOOL_ROLES = ['admin', 'accountant', 'teacher', 'student', 'parent'];

router.use(protect, authorizeRoles(...SCHOOL_ROLES));

router.get('/intro', c.intro);
router.post('/ask', assistantLimiter, c.ask);
router.post('/feedback', c.feedback);
router.get('/tickets', c.listTickets);
router.patch('/tickets/:id', c.updateTicket);
router.get('/metrics', requirePermission('assistant.insights'), c.metrics);
router.get('/evaluation', requirePermission('assistant.insights'), c.evaluation);

module.exports = router;
