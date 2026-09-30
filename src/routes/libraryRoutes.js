const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/libraryController');

router.use(protect);
router.get('/',       c.getBooks);
router.post('/',      authorizeRoles('admin'), c.addBook);
router.patch('/:id',  authorizeRoles('admin'), c.updateBook);
router.put('/:id',    authorizeRoles('admin'), c.updateBook);
router.delete('/:id', authorizeRoles('admin'), c.deleteBook);

module.exports = router;
