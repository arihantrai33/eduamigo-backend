const Library = require('../models/Library');
const { HttpError, asyncHandler, assertId, pick, escapeRegex } = require('../utils/http');
const { pageParams, paged } = require('../utils/paginate');

const FIELDS = ['title', 'author', 'isbn', 'category', 'totalCopies', 'publisher', 'year'];

const getBooks = asyncHandler(async (req, res) => {
  const filter = { school: req.schoolId };
  if (req.query.search) filter.title = { $regex: escapeRegex(req.query.search), $options: 'i' };
  if (req.query.category && req.query.category !== 'all') filter.category = String(req.query.category);
  const result = await paged(Library, filter, pageParams(req.query), (q) => q.sort({ createdAt: -1 }));
  res.json({ success: true, ...result });
});

const addBook = asyncHandler(async (req, res) => {
  const data = pick(req.body, FIELDS);
  const copies = Number(data.totalCopies);
  if (!data.title || !(copies >= 1)) throw new HttpError(400, 'Title and at least one copy are required');
  const book = await Library.create({ ...data, totalCopies: copies, available: copies, issued: 0, school: req.schoolId, addedBy: req.user._id });
  res.status(201).json({ success: true, data: book });
});

// Changing totalCopies keeps issued copies intact and recomputes availability.
const updateBook = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const book = await Library.findOne({ _id: req.params.id, school: req.schoolId });
  if (!book) throw new HttpError(404, 'Book not found');
  const data = pick(req.body, FIELDS);
  if (data.totalCopies !== undefined) {
    const copies = Number(data.totalCopies);
    if (!(copies >= book.issued)) throw new HttpError(400, `Total copies cannot be less than issued copies (${book.issued})`);
    data.totalCopies = copies;
    book.available = copies - book.issued;
  }
  Object.assign(book, data);
  await book.save();
  res.json({ success: true, data: book });
});

const deleteBook = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const book = await Library.findOne({ _id: req.params.id, school: req.schoolId });
  if (!book) throw new HttpError(404, 'Book not found');
  if (book.issued > 0) throw new HttpError(409, 'This book has issued copies and cannot be deleted');
  await book.deleteOne();
  res.json({ success: true, message: 'Book deleted' });
});

module.exports = { getBooks, addBook, updateBook, deleteBook };
