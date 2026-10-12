const express = require('express');
const { asyncHandler } = require('../utils/http');
const { photoLimiter } = require('../middleware/rateLimit');
const photos = require('../services/photos');

const router = express.Router();

// GET /api/photos/:token: the image behind a short-lived private link made by the API (services/photos.js).
// <img> tags cannot send a login header, so the link itself is the proof; it expires and cannot be forged. A bad,
// expired or unknown link always gets the same plain 404.
router.get('/:token', photoLimiter, asyncHandler(async (req, res) => {
  const key = photos.readToken(req.params.token);
  const photo = key ? await photos.downloadPhoto(key).catch(() => null) : null;
  if (!photo) return res.status(404).end();
  res.set({
    'Content-Type': photo.type,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=1800',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  return res.send(photo.buffer);
}));

module.exports = router;
