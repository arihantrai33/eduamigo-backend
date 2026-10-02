const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/reportCardController');

router.use(protect);
router.get('/',                               requirePermission('results.read'), c.getClassReportCards);
router.get('/student/:studentId',             c.getStudentReportCard);
router.put('/student/:studentId/remarks',     requirePermission('marks.enter'), c.saveRemarks);

module.exports = router;
