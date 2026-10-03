const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const disabled = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== 'true';

// Login ID from either request shape: { email } or { schoolCode, identifier }.
const loginKey = (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.schoolCode || '').toUpperCase()}:${String(req.body?.identifier ?? req.body?.email ?? '').trim().toLowerCase()}`;

// Brute-force protection for login: 10 attempts per 15 minutes per IP + login ID.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: disabled,
  keyGenerator: loginKey,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
});

// Password reset requests and code checks: 5 per 15 minutes per IP + login ID.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: disabled,
  keyGenerator: loginKey,
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
});

// AI usage cap per user: protects cost and keeps usage fair across students.
const revisionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REVISION_HOURLY_LIMIT || 40),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: disabled,
  keyGenerator: (req) => String(req.user?._id || ipKeyGenerator(req.ip)),
  message: { success: false, message: 'You have reached the hourly limit for AI revision. Please try again later.' },
});

// Public school lookup (no login): stops anyone from scraping the school list.
const publicLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: disabled,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, message: 'Too many requests. Please wait a minute and try again.' },
});

module.exports = { loginLimiter, passwordResetLimiter, revisionLimiter, publicLookupLimiter };
