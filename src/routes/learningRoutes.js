// EduAmigo Learning AI (students). Mounted at /api/learning behind protect + the ai_revision plan feature (app.js).
const express = require('express');
const router = express.Router();
const { authorizeRoles } = require('../middleware/authMiddleware');
const { revisionLimiter } = require('../middleware/rateLimit');
const c = require('../controllers/learningController');
const p = require('../controllers/practiceController');

router.use(authorizeRoles('student'));

router.get('/context', c.context);
router.post('/chat', revisionLimiter, c.chat);
router.get('/conversations', c.listConversations);
router.delete('/conversations', c.clearConversations);
router.get('/conversations/:id', c.getConversation);
router.delete('/conversations/:id', c.deleteConversation);

router.get('/practice', p.listPractice);
router.post('/practice', revisionLimiter, p.createPractice);
router.get('/practice/:id', p.getPractice);
router.post('/practice/:id/answer', revisionLimiter, p.answer);
router.post('/practice/:id/reveal', p.reveal);

router.get('/plan', p.getPlan);
router.post('/plan', p.createPlan);
router.patch('/plan/:id/items/:itemId', p.markItem);
router.delete('/plan/:id', p.deletePlan);

router.get('/progress', p.progress);

module.exports = router;
