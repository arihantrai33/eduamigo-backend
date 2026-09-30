const multer = require('multer');

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// Chat attachments: PDFs and images up to 5 MB, kept in memory until uploaded to Cloudinary.
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (ALLOWED.includes(file.mimetype)
    ? cb(null, true)
    : cb(Object.assign(new Error('Only PDF, JPG, PNG or WEBP files are allowed'), { status: 400 }), false)),
});
