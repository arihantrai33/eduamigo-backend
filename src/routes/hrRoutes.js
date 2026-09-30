const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/hrController');

// Salary and staff data is admin-only.
router.use(protect, requirePermission('hr.manage'));
router.get('/salaries',           c.getSalaries);
router.post('/salaries',          c.createSalary);
router.post('/salaries/generate', c.generateMonthlySalaries);
router.put('/salaries/:id',       c.updateSalary);
router.delete('/salaries/:id',    c.deleteSalary);
router.get('/leaves',             c.getStaffLeaves);
router.post('/leaves',            c.createStaffLeave);
router.put('/leaves/:id',         c.updateStaffLeave);
router.delete('/leaves/:id',      c.deleteStaffLeave);

module.exports = router;
