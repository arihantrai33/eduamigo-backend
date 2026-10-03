// Route middleware that writes an audit entry when a change succeeds (status < 400).
//   router.post('/publish', requirePermission('marks.enter'), audited('marks.published', 'exam'), c.publishMarks);
// Records who (user, role, support session), what (action), which record (route :id / chosen body field)
// and a trimmed copy of the request body. Secrets are never stored.
const { audit } = require('../services/audit');

const SECRET = /pass(word)?|secret|token|otp|^code$|key|signature|card|cvv/i;
const MAX_STRING = 300;
const MAX_ITEMS = 25;
const MAX_DEPTH = 3;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => sanitize(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…${value.length - MAX_ITEMS} more`] : items;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[hidden]' : sanitize(v, depth + 1);
  return out;
}

// targetFrom: a route param name (default "id") or a function (req) => id.
function audited(action, targetType = '', targetFrom = 'id') {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user) return;
      const targetId = typeof targetFrom === 'function' ? targetFrom(req) : (req.params?.[targetFrom] || req.body?.[targetFrom] || '');
      audit(req, action, {
        targetType, targetId,
        details: { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, body: sanitize(req.body || {}) },
      });
    });
    next();
  };
}

module.exports = { audited, sanitize };
