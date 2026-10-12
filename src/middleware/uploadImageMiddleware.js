const multer = require('multer');
const { detectImageType } = require('../utils/imageType');

// Store file in memory (RAM) temporarily — never touches disk
const storage = multer.memoryStorage();

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

const base = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max for photos
  fileFilter: (req, file, cb) => {
    // First, cheap check on the type the browser claims; the real check is on the file's bytes (validateImageContent).
    if (ALLOWED.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only JPEG, PNG or WebP images are allowed'), { status: 400 }), false);
    }
  },
});

// The client's claimed type is not trusted: the file must really be a JPEG, PNG or WebP.
function validateImageContent(req, res, next) {
  if (!req.file) return next();
  const real = detectImageType(req.file.buffer);
  if (!real) return next(Object.assign(new Error('The file is not a valid JPEG, PNG or WebP image'), { status: 400 }));
  req.file.mimetype = real;
  return next();
}

// uploadImage.single('photo') is used inside route definitions: it now expands to the upload plus the content check.
module.exports = { single: (field) => [base.single(field), validateImageContent], validateImageContent };
