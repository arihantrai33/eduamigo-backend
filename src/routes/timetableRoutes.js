const express = require('express');
const router  = express.Router();
const {
  listTimetables,
  createTimetable,
  getClassTimetable,
  getClassDayTimetable,
  getTeacherTimetable,
  getMyTimetable,
  updateTimetable,
  deleteTimetable
} = require('../controllers/timetableController');
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');

router.get('/',                     protect, requirePermission('timetable.manage'), listTimetables);
router.post('/',                    protect, requirePermission('timetable.manage'), createTimetable);
router.get('/my',                   protect, authorizeRoles('student'), getMyTimetable);
router.get('/class/:class',         protect, authorizeRoles('admin', 'teacher', 'parent', 'student'), getClassTimetable);
router.get('/class/:class/:day',    protect, authorizeRoles('admin', 'teacher', 'parent', 'student'), getClassDayTimetable);
router.get('/teacher/:teacherId',   protect, authorizeRoles('admin', 'teacher'), getTeacherTimetable);
router.put('/:id',                  protect, requirePermission('timetable.manage'), updateTimetable);
router.delete('/:id',               protect, requirePermission('timetable.manage'), deleteTimetable);

module.exports = router;