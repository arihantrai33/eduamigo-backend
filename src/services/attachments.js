// Files people send each other or attach to homework. Private, like student photos: stored as authenticated assets (or on disk in the
// local demo), under the school's own path, and opened through short-lived signed links to this server: GET /api/files/<token>.
// The API stores { key, name, type, size } and returns { url, name, type, size, kind }; the key never leaves the server.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const streamifier = require('streamifier');
const cloudinary = require('../config/cloudinary');
const { jwtSecret } = require('../config/env');

const KEY_PATTERN = /^eduamigo\/[a-f0-9]{24}\/files\/(homework|chat)\/[a-f0-9]{32}$/;
const TTL_SECONDS = () => Number(process.env.FILE_URL_TTL_SECONDS || 2 * 60 * 60);
const BUCKET_SECONDS = 30 * 60;

const useLocal = () => process.env.PHOTO_STORAGE === 'local';
const LOCAL_DIR = () => process.env.PHOTO_LOCAL_DIR || path.join(__dirname, '..', '..', '.dev-uploads');
const localFile = (key) => path.join(LOCAL_DIR(), `${key.replace(/\//g, '__')}.bin`);

const signingKey = () => crypto.createHash('sha256').update(`file-link|${jwtSecret()}`).digest();
const b64 = (v) => Buffer.from(v).toString('base64url');
const mac = (payload) => b64(crypto.createHmac('sha256', signingKey()).update(payload).digest());

const newKey = (schoolId, kind) => `eduamigo/${schoolId}/files/${kind}/${crypto.randomBytes(16).toString('hex')}`;

// The link carries the key, the type and the file name, so the download needs no database lookup.
function createToken({ key, type, name }, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const exp = (Math.floor(nowSec / BUCKET_SECONDS) + 1) * BUCKET_SECONDS + TTL_SECONDS();
  const payload = b64(JSON.stringify({ k: key, t: type, n: String(name || '').slice(0, 120), e: exp }));
  return `${payload}.${mac(payload)}`;
}

function readToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 700) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { k, t, n, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!KEY_PATTERN.test(k) || !Number.isFinite(e) || e * 1000 < now) return null;
    return { key: k, type: t, name: n };
  } catch { return null; }
}

function linkFor(att) {
  const base = String(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  return `${base}/api/files/${createToken(att)}`;
}

// What the apps get for a stored attachment.
const present = (att) => (att && att.key ? { url: linkFor(att), name: att.name, type: att.type, size: att.size, kind: att.kind } : null);

async function save(file, schoolId, kind) {
  const key = newKey(schoolId, kind);
  if (useLocal()) {
    fs.mkdirSync(LOCAL_DIR(), { recursive: true });
    fs.writeFileSync(localFile(key), file.buffer);
  } else {
    await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ public_id: key, type: 'authenticated', resource_type: 'raw', overwrite: false }, (err) => (err ? reject(err) : resolve()));
      streamifier.createReadStream(file.buffer).pipe(stream);
    });
  }
  return { key, name: String(file.originalname || 'file').slice(0, 120), type: file.mimetype, size: file.size ?? file.buffer.length, kind: file.kind };
}

async function download(key) {
  if (!KEY_PATTERN.test(key)) return null;
  if (useLocal()) { try { return fs.readFileSync(localFile(key)); } catch { return null; } }
  const url = cloudinary.url(key, { type: 'authenticated', resource_type: 'raw', sign_url: true, secure: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

async function remove(att) {
  const key = att?.key;
  if (!key || !KEY_PATTERN.test(key)) return;
  if (useLocal()) { try { fs.unlinkSync(localFile(key)); } catch { /* ignore */ } return; }
  try { await cloudinary.uploader.destroy(key, { type: 'authenticated', resource_type: 'raw', invalidate: true }); } catch { /* ignore */ }
}

module.exports = { save, download, remove, present, createToken, readToken, linkFor, KEY_PATTERN };
