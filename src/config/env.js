// Central place for environment configuration.
// The server refuses to start without the secrets it needs, instead of
// silently falling back to insecure defaults.

const REQUIRED_IN_PRODUCTION = ['MONGO_URI', 'JWT_SECRET'];

function assertEnv() {
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }
  // Without an allow-list the CORS check lets every website call the API, which is only acceptable in development.
  if (process.env.NODE_ENV === 'production' && !corsOrigins().length) {
    throw new Error('CORS_ORIGINS must list the allowed frontend origins in production');
  }
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return secret;
}

function corsOrigins() {
  // Comma-separated list, e.g. "https://eduamigo.vercel.app,http://localhost:5173"
  const raw = process.env.CORS_ORIGINS || '';
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

module.exports = { assertEnv, jwtSecret, corsOrigins };
