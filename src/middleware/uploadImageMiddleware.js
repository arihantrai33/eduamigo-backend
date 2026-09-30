const multer = require('multer');

// Store file in memory (RAM) temporarily — never touches disk
const storage = multer.memoryStorage();

const uploadImage = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max for photos
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only image files are allowed'), { status: 400 }), false);
    }
  },
});

module.exports = uploadImage;
