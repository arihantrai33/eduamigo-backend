const multer = require('multer');
const { detectImageType, isPdf } = require('../utils/imageType');

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// Chat attachments: PDFs and images up to 5 MB, kept in memory until uploaded to Cloudinary.
const base = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED.includes(file.mimetype)
    ? cb(null, true)
    : cb(Object.assign(new Error('Only PDF, JPG, PNG or WEBP files are allowed'), { status: 400 }), false)),
});

// The claimed type is not trusted: the bytes must be a real PDF or a real JPEG, PNG or WebP, and that type is what is kept.
function validateAttachmentContent(req, res, next) {
  if (!req.file) return next();
  const real = isPdf(req.file.buffer) ? 'application/pdf' : detectImageType(req.file.buffer);
  if (!real || (req.file.mimetype === 'application/pdf') !== (real === 'application/pdf')) {
    return next(Object.assign(new Error('The file is not a valid PDF, JPG, PNG or WEBP'), { status: 400 }));
  }
  req.file.mimetype = real;
  return next();
}

module.exports = { single: (field) => [base.single(field), validateAttachmentContent], validateAttachmentContent };
