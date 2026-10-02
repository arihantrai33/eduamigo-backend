// Encrypts per-school secrets (such as payment gateway keys) before they are stored.
// AES-256-GCM with a key from DATA_ENCRYPTION_KEY. If it is not set, the key is derived from
// JWT_SECRET, so rotating JWT_SECRET then means re-entering the stored secrets.
const crypto = require('crypto');

function key() {
  const source = process.env.DATA_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!source) throw new Error('DATA_ENCRYPTION_KEY is not configured');
  return crypto.createHash('sha256').update(String(source)).digest();
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!stored) return '';
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1') throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
