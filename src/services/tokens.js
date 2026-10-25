// Every sign-in token is made here so they all carry the user's tokenVersion (`v`).
// Raising User.tokenVersion signs the user out everywhere (see authMiddleware.protect).
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');

const USER_TOKEN_TTL = () => process.env.JWT_EXPIRES_IN || '24h';

function signUserToken(user, { expiresIn = USER_TOKEN_TTL(), ...claims } = {}) {
  return jwt.sign({ id: user._id, role: user.role, v: user.tokenVersion || 0, ...claims }, jwtSecret(), { expiresIn });
}

// True when a token is older than the user's last password change or "sign out everywhere".
function isRevoked(decoded, user) {
  if ((decoded.v || 0) !== (user.tokenVersion || 0)) return true;
  return !!(user.passwordChangedAt && decoded.iat * 1000 < user.passwordChangedAt.getTime() - 1000);
}

// "Which school?" ticket: given after the password has been proved for accounts in several schools, so the person can pick one
// without typing the password again. It lists the accounts (with their tokenVersion), lasts five minutes, has no `id` and a
// `scope`, so it is not a session: protect() refuses it, and a password change in between voids it.
const CHOICE_TTL = '5m';
const signSchoolChoiceTicket = (users) => jwt.sign(
  { scope: 'school-choice', ids: users.map((u) => ({ id: String(u._id), v: u.tokenVersion || 0 })) },
  jwtSecret(), { expiresIn: CHOICE_TTL },
);
function readSchoolChoiceTicket(ticket) {
  let decoded;
  try { decoded = jwt.verify(String(ticket || ''), jwtSecret()); } catch { return null; }
  return decoded.scope === 'school-choice' && Array.isArray(decoded.ids) ? decoded : null;
}
const ticketStillValid = (decoded, entry, user) => (entry.v || 0) === (user.tokenVersion || 0)
  && !(user.passwordChangedAt && decoded.iat * 1000 < user.passwordChangedAt.getTime() - 1000);

module.exports = { signUserToken, isRevoked, signSchoolChoiceTicket, readSchoolChoiceTicket, ticketStillValid };
