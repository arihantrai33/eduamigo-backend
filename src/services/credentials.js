const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Readable temporary password, e.g. "Kite-4829-Moon". Shown to the admin once;
// the user must change it on first login (User.mustChangePassword).
const WORDS = ['Kite', 'Moon', 'Lake', 'Star', 'Tree', 'Rain', 'Book', 'Leaf', 'Bird', 'Sand', 'Wind', 'Rose', 'Hill', 'Wave'];

function temporaryPassword() {
  const w = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${w()}-${crypto.randomInt(1000, 10000)}-${w()}`;
}

// Cost 10 in production. BCRYPT_ROUNDS can lower it for the test suite only (hashing is most of its
// setup time); values outside 4-14 are ignored.
const ROUNDS = (() => {
  const n = Number(process.env.BCRYPT_ROUNDS);
  return Number.isInteger(n) && n >= 4 && n <= 14 ? n : 10;
})();
const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain letters and numbers';
  return null;
}

module.exports = { temporaryPassword, hashPassword, validatePasswordStrength };
