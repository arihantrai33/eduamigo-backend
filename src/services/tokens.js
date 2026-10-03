// Every sign-in token is made here so they all carry the user's tokenVersion (`v`).
// Raising User.tokenVersion signs the user out everywhere (see authMiddleware.protect).
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');

const USER_TOKEN_TTL = () => process.env.JWT_EXPIRES_IN || '7d';

function signUserToken(user, { expiresIn = USER_TOKEN_TTL(), ...claims } = {}) {
  return jwt.sign({ id: user._id, role: user.role, v: user.tokenVersion || 0, ...claims }, jwtSecret(), { expiresIn });
}

// True when a token is older than the user's last password change or "sign out everywhere".
function isRevoked(decoded, user) {
  if ((decoded.v || 0) !== (user.tokenVersion || 0)) return true;
  return !!(user.passwordChangedAt && decoded.iat * 1000 < user.passwordChangedAt.getTime() - 1000);
}

module.exports = { signUserToken, isRevoked };
