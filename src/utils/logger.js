// One JSON object per line, so Render / any log tool can search by field (requestId, school, status).
// Silent during automated tests unless LOG_IN_TESTS=true.
const crypto = require('crypto');

const enabled = () => process.env.NODE_ENV !== 'test' || process.env.LOG_IN_TESTS === 'true';

function write(level, event, fields) {
  if (!enabled()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

const log = {
  info: (event, fields = {}) => write('info', event, fields),
  warn: (event, fields = {}) => write('warn', event, fields),
  error: (event, fields = {}) => write('error', event, fields),
};

// Only the message and the first stack frames: enough to find the bug, nothing from request bodies.
const errorFields = (err) => ({
  name: err && err.name,
  message: String((err && err.message) || err).slice(0, 500),
  stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined,
});

// Private photo links and the bus driver's screen carry their secret in the path, so it never goes into the log.
const loggedPath = (url) => url.split('?')[0]
  .replace(/^(\/api\/photos\/).+$/, '$1:token')
  .replace(/^(\/api\/transport\/driver\/)[^/]+/, '$1:token');

// Gives every request an id (reusing a sane one from the proxy), returns it as X-Request-Id and logs one line
// when the response finishes. The query string is dropped because it can hold tokens or personal details.
function requestLogger(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/api/health') return;
    log.info('request', {
      requestId: req.id,
      method: req.method,
      path: loggedPath(req.originalUrl),
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
      school: req.schoolId ? String(req.schoolId) : undefined,
      user: req.user ? String(req.user._id) : undefined,
    });
  });
  next();
}

module.exports = { log, errorFields, requestLogger, loggedPath };
