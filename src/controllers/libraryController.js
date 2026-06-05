const Library = require('../models/Library');

const getBooks = async (req, res) => {
  try {
    const { search, category } = req.query;
    const filter = {};
    if (search) filter.title = { $regex: search, $options: 'i' };
    if (category && category !== 'all') filter.category = category;
    const books = await Library.find(filter).sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: books.length, data: books });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const addBook = async (req, res) => {
  try {
    const { title, author, isbn, category, totalCopies, publisher, year } = req.body;
    if (!title || !totalCopies) return res.status(400).json({ success: false, message: 'Title and copies required' });
    const book = await Library.create({
      title, author, isbn, category, publisher, year,
      totalCopies: Number(totalCopies),
      available: Number(totalCopies),
      issued: 0,
      addedBy: req.user._id,
    });
    res.status(201).json({ success: true, data: book });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateBook = async (req, res) => {
  try {
    const book = await Library.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!book) return res.status(404).json({ success: false, message: 'Book not found' });
    res.status(200).json({ success: true, data: book });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const deleteBook = async (req, res) => {
  try {
    await Library.findByIdAndDelete(req.params.id);
    res.status(200).json({ success: true, message: 'Book deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = { getBooks, addBook, updateBook, deleteBook };
