const express = require('express');
const router = express.Router();
const { protect, authorizeRoles, requirePermission } = require('../middleware/authMiddleware');
const c = require('../controllers/libraryController');

router.use(protect);
router.get('/',       c.getBooks);
router.post('/',      requirePermission('library.manage'), c.addBook);
router.patch('/:id',  requirePermission('library.manage'), c.updateBook);
router.put('/:id',    requirePermission('library.manage'), c.updateBook);
router.delete('/:id', requirePermission('library.manage'), c.deleteBook);

module.exports = router;
