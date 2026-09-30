const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const disabled = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== 'true';

// Brute-force protection for login: 10 attempts per 15 minutes per IP + email.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: disabled,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.email || '').toLowerCase()}`,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
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

module.exports = { loginLimiter, revisionLimiter };
