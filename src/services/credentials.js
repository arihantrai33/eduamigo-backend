const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Readable temporary password, e.g. "Kite-4829-Moon". Shown to the admin once;
// the user must change it on first login (User.mustChangePassword).
const WORDS = ['Kite', 'Moon', 'Lake', 'Star', 'Tree', 'Rain', 'Book', 'Leaf', 'Bird', 'Sand', 'Wind', 'Rose', 'Hill', 'Wave'];

function temporaryPassword() {
  const w = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${w()}-${crypto.randomInt(1000, 10000)}-${w()}`;
}

const hashPassword = (plain) => bcrypt.hash(plain, 10);

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Password must contain letters and numbers';
  return null;
}

module.exports = { temporaryPassword, hashPassword, validatePasswordStrength };
