const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { MongoRateLimitStore } = require('../services/rateLimitStore');

const disabled = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== 'true';

// Counters live in MongoDB (shared by all instances, kept across restarts). RATE_LIMIT_STORE=memory keeps them in the
// process instead; that is the default under automated tests. If the database fails, requests are let through rather
// than locking everyone out (passOnStoreError).
const useMongo = () => (process.env.RATE_LIMIT_STORE || (process.env.NODE_ENV === 'test' ? 'memory' : 'mongo')) === 'mongo';

const make = (name, options) => rateLimit({
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: disabled,
  passOnStoreError: true,
  ...(useMongo() ? { store: new MongoRateLimitStore({ prefix: name }) } : {}),
  ...options,
});

// Login ID from either request shape: { email } or { schoolCode, identifier }.
const loginKey = (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.schoolCode || '').toUpperCase()}:${String(req.body?.identifier ?? req.body?.email ?? '').trim().toLowerCase()}`;

// Brute-force protection for login: 10 attempts per 15 minutes per IP + login ID.
const loginLimiter = make('login', {
  windowMs: 15 * 60 * 1000,
  limit: () => Number(process.env.LOGIN_ATTEMPTS_PER_15_MIN || 10),
  keyGenerator: loginKey,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
});

// Password reset requests and code checks: 5 per 15 minutes per IP + login ID.
const passwordResetLimiter = make('passwordReset', {
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: loginKey,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

// AI usage cap per user: protects cost and keeps usage fair across students.
const revisionLimiter = make('revision', {
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REVISION_HOURLY_LIMIT || 40),
  keyGenerator: (req) => String(req.user?._id || ipKeyGenerator(req.ip)),
  message: { success: false, message: 'You have reached the hourly limit for AI revision. Please try again later.' },
});

// EduAmigo Ask: questions per user per hour (keyword answers are cheap, but this keeps model use fair).
const assistantLimiter = make('assistant', {
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.ASSISTANT_HOURLY_LIMIT || 120),
  keyGenerator: (req) => String(req.user?._id || ipKeyGenerator(req.ip)),
  message: { success: false, message: 'You have asked a lot of questions this hour. Please try again a little later.' },
});

// Public school lookup (no login): stops anyone from scraping the school list.
// A school's computer lab or Wi-Fi shares one address, so a whole class finding the school in the same minute must fit.
const publicLookupLimiter = make('publicLookup', {
  windowMs: 60 * 1000,
  limit: () => Number(process.env.PUBLIC_LOOKUP_PER_MINUTE || 120),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, message: 'Too many requests. Please wait a minute and try again.' },
});

// Slow guessing of one account from many addresses: the limits above count per IP + account, this one per account only.
// Generous on purpose, so an attacker cannot lock a real user out with a few requests.
const loginAccountLimiter = make('loginAccount', {
  windowMs: 15 * 60 * 1000,
  limit: () => Number(process.env.LOGIN_ACCOUNT_ATTEMPTS_PER_15_MIN || 30),
  keyGenerator: (req) => `${String(req.body?.schoolCode || '').toUpperCase()}:${String(req.body?.identifier ?? req.body?.email ?? '').trim().toLowerCase()}`,
  message: { success: false, message: 'Too many login attempts for this account. Please try again in 15 minutes.' },
});

// Photo links: a page shows many avatars at once and <img> requests carry no login, so this is per address and generous.
// In memory, since a database write per image would cost more than it protects.
const photoLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.PHOTO_PER_MINUTE || 600),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: disabled,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, message: 'Too many requests. Please wait a minute and try again.' },
});

// Coarse flood guard for the whole API, in memory on purpose (no database write per request). Signed-in callers are
// counted per session token, so the many users behind one school network do not share a single allowance.
const apiKey = (req) => {
  const bearer = req.get('authorization');
  return bearer ? `t:${crypto.createHash('sha256').update(bearer).digest('hex').slice(0, 24)}` : `ip:${ipKeyGenerator(req.ip)}`;
};
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req) => (req.get('authorization') ? Number(process.env.API_USER_PER_MINUTE || 300) : Number(process.env.API_ANON_PER_MINUTE || 120)),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => disabled() || req.method === 'OPTIONS' || req.path === '/health',
  keyGenerator: apiKey,
  message: { success: false, message: 'Too many requests. Please slow down and try again in a minute.' },
});

// The natural voice is asked for one short piece at a time, several per answer, so it has its own, larger allowance.
const speechLimiter = make('speech', {
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.SPEECH_HOURLY_LIMIT || 300),
  keyGenerator: (req) => String(req.user?._id || ipKeyGenerator(req.ip)),
  message: { success: false, message: 'You have reached the hourly limit for the spoken voice. Answers are still shown on screen.' },
});

// A driver's phone sends a batch of GPS readings every few seconds: generous per driver code, so a stuck loop cannot flood the API.
const driverLocationLimiter = make('driverLocation', {
  windowMs: 60 * 1000,
  limit: () => Number(process.env.DRIVER_LOCATION_PER_MINUTE || 90),
  keyGenerator: (req) => `${String(req.params.token || '').slice(0, 40)}`,
  message: { success: false, message: 'Too many location updates. The app will retry shortly.' },
});

module.exports = {
  driverLocationLimiter, loginLimiter, loginAccountLimiter, passwordResetLimiter, revisionLimiter, speechLimiter, assistantLimiter, publicLookupLimiter, apiLimiter, photoLimiter };
