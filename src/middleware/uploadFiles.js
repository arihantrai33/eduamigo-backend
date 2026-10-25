const multer = require('multer');
const { detectFile } = require('../utils/fileType');

// Homework and chat attachments: photos, PDFs, voice notes and common documents, up to 10 MB each, kept in memory until stored.
const MAX_BYTES = 10 * 1024 * 1024;
const base = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 5 } });

// The claimed type is not trusted: the bytes decide, and that type is what is kept.
function validateFiles(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  for (const f of files) {
    const real = detectFile(f.buffer, f.originalname);
    if (!real) return next(Object.assign(new Error('Only photos, PDFs, voice notes, Word, Excel, PowerPoint and text files are allowed'), { status: 400 }));
    f.mimetype = real.mime; f.kind = real.kind;
  }
  return next();
}

module.exports = {
  single: (field) => [base.single(field), validateFiles],
  array: (field, max = 3) => [base.array(field, max), validateFiles],
  validateFiles, MAX_BYTES,
};
