const express = require('express');
const router = express.Router();
const { getBooks, addBook, updateBook, deleteBook } = require('../controllers/libraryController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

router.get('/', protect, getBooks);
router.post('/', protect, authorizeRoles('admin'), addBook);
router.patch('/:id', protect, authorizeRoles('admin'), updateBook);
router.delete('/:id', protect, authorizeRoles('admin'), deleteBook);

module.exports = router;
