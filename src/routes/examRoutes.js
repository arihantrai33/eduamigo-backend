const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/examController');

// Results are written only through the marks publish flow (/api/marks/publish).
router.use(protect);
router.get('/my-results',                  authorizeRoles('student'), c.getMyResults);
router.get('/child-results',               authorizeRoles('parent'), c.getChildResults);
router.get('/results',                     authorizeRoles('admin', 'teacher'), c.getResults);
router.get('/student/:studentId/results',  c.getStudentResults);

router.get('/',       c.listSchedule);
router.post('/',      authorizeRoles('admin'), c.createSchedule);
router.put('/:id',    authorizeRoles('admin'), c.updateSchedule);
router.delete('/:id', authorizeRoles('admin'), c.deleteSchedule);

module.exports = router;
