// Decides what a file really is from its first bytes, instead of trusting the type the browser claims.
// Only formats that cannot carry scripts and that every phone produces are accepted (no SVG, GIF or HEIC).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(PNG)) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// A PDF file starts with "%PDF-" (the version follows).
const isPdf = (buffer) => Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-';

module.exports = { detectImageType, isPdf };
