// Student photos are private. They are stored in Cloudinary as "authenticated" assets (no public URL exists), under a
// per-school path, and are shown through short-lived links to this server: GET /api/photos/<token>.
// The token carries the asset key and an expiry and is signed with a key derived from JWT_SECRET, so it cannot be guessed
// or extended. Every API response that shows a student's photo creates a fresh link (see displayPhoto).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const streamifier = require('streamifier');
const cloudinary = require('../config/cloudinary');
const { jwtSecret } = require('../config/env');

const KEY_PATTERN = /^eduamigo\/[a-f0-9]{24}\/(students|avatars|chat)\/[a-f0-9]{32}$/;
const TTL_SECONDS = () => Number(process.env.PHOTO_URL_TTL_SECONDS || 2 * 60 * 60);
const BUCKET_SECONDS = 30 * 60; // links created in the same half hour are identical, so browsers can cache the image
const MAX_BYTES = 6 * 1024 * 1024;

const signingKey = () => crypto.createHash('sha256').update(`photo-link|${jwtSecret()}`).digest();
const b64 = (buffer) => Buffer.from(buffer).toString('base64url');
const mac = (payload) => b64(crypto.createHmac('sha256', signingKey()).update(payload).digest());

function newKey(schoolId, kind = 'students') {
  return `eduamigo/${schoolId}/${kind}/${crypto.randomBytes(16).toString('hex')}`;
}

// Demo and local development have no Cloudinary account. PHOTO_STORAGE=local keeps the files on disk instead (the demo script
// turns it on when Cloudinary is not configured). It is never the default, so a real deployment cannot end up here by accident.
const useLocal = () => process.env.PHOTO_STORAGE === 'local';
const LOCAL_DIR = () => process.env.PHOTO_LOCAL_DIR || path.join(__dirname, '..', '..', '.dev-uploads');
const localFile = (key) => path.join(LOCAL_DIR(), `${key.replace(/\//g, '__')}.bin`);

function createToken(key, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const exp = (Math.floor(nowSec / BUCKET_SECONDS) + 1) * BUCKET_SECONDS + TTL_SECONDS();
  const payload = b64(JSON.stringify({ k: key, e: exp }));
  return `${payload}.${mac(payload)}`;
}

// Returns the asset key for a valid, unexpired token; otherwise null.
function readToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { k, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!KEY_PATTERN.test(k) || !Number.isFinite(e) || e * 1000 < now) return null;
    return k;
  } catch {
    return null;
  }
}

// Link shown to the app. PUBLIC_API_URL is the address of this API as the browser sees it (the app and the API are on
// different domains); when it is not set the link is relative, which works behind the local dev proxy.
function linkFor(key) {
  const base = String(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  return `${base}/api/photos/${createToken(key)}`;
}

// What the app should use as the photo: a fresh private link, or an old public address that has not been migrated yet.
function displayPhoto(student) {
  if (!student) return undefined;
  if (student.photoKey) return linkFor(student.photoKey);
  return student.photo || undefined;
}

function uploadImage(buffer, schoolId, kind = 'students') {
  const key = newKey(schoolId, kind);
  if (useLocal()) {
    fs.mkdirSync(LOCAL_DIR(), { recursive: true });
    fs.writeFileSync(localFile(key), buffer);
    return Promise.resolve(key);
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      public_id: key,
      type: 'authenticated',
      resource_type: 'image',
      overwrite: false,
      allowed_formats: ['jpg', 'png', 'webp'],
      transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto' }],
    }, (err) => (err ? reject(err) : resolve(key)));
    streamifier.createReadStream(buffer).pipe(stream);
  });
}
const uploadStudentPhoto = (buffer, schoolId) => uploadImage(buffer, schoolId, 'students');

// Downloads the private asset from Cloudinary with a signed address that only this server can make.
async function downloadPhoto(key) {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid photo key');
  if (useLocal()) {
    try {
      const buffer = fs.readFileSync(localFile(key));
      const { detectImageType } = require('../utils/imageType');
      const type = detectImageType(buffer);
      return type ? { buffer, type } : null;
    } catch { return null; }
  }
  const url = cloudinary.url(key, { type: 'authenticated', resource_type: 'image', sign_url: true, secure: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) return null;
  return { buffer, type };
}

// Best effort: a leftover file is harmless (it has no public address) and is cleaned up by the migration script.
async function removePhoto(key) {
  if (!key || !KEY_PATTERN.test(key)) return;
  if (useLocal()) { try { fs.unlinkSync(localFile(key)); } catch { /* ignore */ } return; }
  try {
    await cloudinary.uploader.destroy(key, { type: 'authenticated', resource_type: 'image', invalidate: true });
  } catch { /* ignore */ }
}

module.exports = { newKey, createToken, readToken, linkFor, displayPhoto, uploadImage, uploadStudentPhoto, downloadPhoto, removePhoto, KEY_PATTERN };
