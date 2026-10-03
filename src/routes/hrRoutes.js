const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/hrController');
const { audited } = require('../middleware/auditTrail');

// Salary and staff data is admin-only.
router.use(protect, requirePermission('hr.manage'));
router.get('/salaries',           c.getSalaries);
router.post('/salaries',          audited('salary.created', 'salary'), c.createSalary);
router.post('/salaries/generate', audited('salary.generated', 'salary'), c.generateMonthlySalaries);
router.put('/salaries/:id',       audited('salary.updated', 'salary'), c.updateSalary);
router.delete('/salaries/:id',    audited('salary.deleted', 'salary'), c.deleteSalary);
router.get('/leaves',             c.getStaffLeaves);
router.post('/leaves',            c.createStaffLeave);
router.put('/leaves/:id',         c.updateStaffLeave);
router.delete('/leaves/:id',      c.deleteStaffLeave);

module.exports = router;
