const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
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
router.post('/',             protect, requirePermission('fees.structure'), createFeeStructure);
router.put('/:id',           protect, requirePermission('fees.structure'), updateFeeStructure);
router.put('/:id/reapply',   protect, requirePermission('fees.structure'), updateAndReapplyFeeStructure);
router.delete('/:id',        protect, requirePermission('fees.structure'), deleteFeeStructure);
router.post('/:id/apply',    protect, requirePermission('fees.structure'), applyFeeStructureToClass);

module.exports = router;