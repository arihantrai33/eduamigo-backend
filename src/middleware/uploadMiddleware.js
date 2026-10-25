const multer = require('multer');
const { isPdf } = require('../utils/imageType');

// Store file in memory (RAM) temporarily — never touches disk
const storage = multer.memoryStorage();

const base = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max — adjust if needed
  fileFilter: (req, file, cb) => {
    // Cheap check on the type the browser claims; the real check is on the file's bytes (validatePdfContent).
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only PDF files are allowed'), { status: 400 }), false);
    }
  },
});

// The claimed type is not trusted: the file must really be a PDF before it is stored or read by the PDF parser.
function validatePdfContent(req, res, next) {
  if (!req.file) return next();
  if (!isPdf(req.file.buffer)) return next(Object.assign(new Error('The file is not a valid PDF'), { status: 400 }));
  return next();
}

// upload.single('file') is used inside route definitions: it expands to the upload plus the content check.
module.exports = { single: (field) => [base.single(field), validatePdfContent], validatePdfContent };
