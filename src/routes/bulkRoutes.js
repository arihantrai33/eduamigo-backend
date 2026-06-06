const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { bulkAttendance, bulkPromote, bulkFeeReminder, bulkUploadStudents, bulkUploadTeachers } = require("../controllers/bulkController");

router.post("/attendance",        protect, bulkAttendance);
router.post("/promote",           protect, bulkPromote);
router.post("/fee-reminder",      protect, bulkFeeReminder);
router.post("/upload/students",   protect, bulkUploadStudents);
router.post("/upload/teachers",   protect, bulkUploadTeachers);

module.exports = router;
