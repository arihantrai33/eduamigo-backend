const express = require('express');
const { asyncHandler } = require('../utils/http');
const { photoLimiter } = require('../middleware/rateLimit');
const attachments = require('../services/attachments');

const router = express.Router();

// GET /api/files/:token: a homework or chat attachment behind a short-lived signed link made by the API. Always sent as a
// download with the type the server decided on, so a file can never run in the browser. Bad, expired or unknown links get a plain 404.
router.get('/:token', photoLimiter, asyncHandler(async (req, res) => {
  const meta = attachments.readToken(req.params.token);
  const buffer = meta ? await attachments.download(meta.key).catch(() => null) : null;
  if (!buffer) return res.status(404).end();
  const inline = /^(image\/(jpeg|png|webp)|audio\/|application\/pdf)/.test(meta.type || '');
  const safeName = String(meta.name || 'file').replace(/[^\w.\- ]+/g, '_');
  res.set({
    'Content-Type': meta.type || 'application/octet-stream',
    'Content-Disposition': `${inline && req.query.download !== '1' ? 'inline' : 'attachment'}; filename="${safeName}"`,
    'Cache-Control': 'private, max-age=1800',
    'X-Content-Type-Options': 'nosniff',
    ...(meta.type === 'application/pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; sandbox" }), // a PDF needs the browser's viewer
  });
  return res.send(buffer);
}));

module.exports = router;
