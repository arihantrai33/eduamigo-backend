const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const { audited } = require('../middleware/auditTrail');
const {
  createFeeStructure,
  getAllFeeStructures,
  updateFeeStructure,
  updateAndReapplyFeeStructure,
  deleteFeeStructure,
  applyFeeStructureToClass,
  getFeeSummary,
} = require('../controllers/feeStructureController');

router.get('/summary',       protect, requirePermission('fees.read'), getFeeSummary);
router.get('/',              protect, requirePermission('fees.read'), getAllFeeStructures);
router.post('/',             protect, requirePermission('fees.structure'), audited('fee_structure.created', 'fee_structure'), createFeeStructure);
router.put('/:id',           protect, requirePermission('fees.structure'), audited('fee_structure.updated', 'fee_structure'), updateFeeStructure);
router.put('/:id/reapply',   protect, requirePermission('fees.structure'), audited('fee_structure.reapplied', 'fee_structure'), updateAndReapplyFeeStructure);
router.delete('/:id',        protect, requirePermission('fees.structure'), audited('fee_structure.deleted', 'fee_structure'), deleteFeeStructure);
router.post('/:id/apply',    protect, requirePermission('fees.structure'), audited('fee_structure.applied', 'fee_structure'), applyFeeStructureToClass);

module.exports = router;