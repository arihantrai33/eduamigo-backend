const express = require('express');
const router  = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  createFeeStructure,
  getAllFeeStructures,
  updateFeeStructure,
  updateAndReapplyFeeStructure,
  deleteFeeStructure,
  applyFeeStructureToClass,
  getFeeSummary,
} = require('../controllers/feeStructureController');

router.get   ('/summary',          protect, authorizeRoles('admin'), getFeeSummary);
router.get   ('/',                 protect, authorizeRoles('admin'), getAllFeeStructures);
router.post  ('/',                 protect, authorizeRoles('admin'), createFeeStructure);
router.put   ('/:id',             protect, authorizeRoles('admin'), updateFeeStructure);
router.put   ('/:id/update-reapply', protect, authorizeRoles('admin'), updateAndReapplyFeeStructure);
router.delete('/:id',             protect, authorizeRoles('admin'), deleteFeeStructure);
router.post  ('/:id/apply',       protect, authorizeRoles('admin'), applyFeeStructureToClass);

module.exports = router;