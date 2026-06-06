const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const { getSalaries, createSalary, updateSalary, deleteSalary, generateMonthlySalaries, getStaffLeaves, createStaffLeave, updateStaffLeave, deleteStaffLeave } = require("../controllers/hrController");

router.get("/salaries",              protect, getSalaries);
router.post("/salaries",             protect, createSalary);
router.post("/salaries/generate",    protect, generateMonthlySalaries);
router.put("/salaries/:id",          protect, updateSalary);
router.delete("/salaries/:id",       protect, deleteSalary);

router.get("/leaves",                protect, getStaffLeaves);
router.post("/leaves",               protect, createStaffLeave);
router.put("/leaves/:id",            protect, updateStaffLeave);
router.delete("/leaves/:id",         protect, deleteStaffLeave);

module.exports = router;
