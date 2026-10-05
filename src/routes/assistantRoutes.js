const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const { assistantLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/assistantController');
const k = require('../controllers/knowledgeController');
const upload = require('../middleware/uploadMiddleware');

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

// The school documents it answers from (handbook, policies, FAQs).
router.get('/knowledge', requirePermission('assistant.knowledge'), k.list);
router.post('/knowledge', requirePermission('assistant.knowledge'), upload.single('file'), k.create);
router.patch('/knowledge/:id', requirePermission('assistant.knowledge'), k.update);
router.delete('/knowledge/:id', requirePermission('assistant.knowledge'), k.remove);

module.exports = router;
