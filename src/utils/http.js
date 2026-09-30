const mongoose = require('mongoose');

// Error type that controllers can throw to return a clean HTTP error.
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Wraps an async controller so thrown errors reach the central error handler.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);

function assertId(id, label = 'id') {
  if (!isValidId(id)) throw new HttpError(400, `Invalid ${label}`);
}

// Copies only the allowed keys from a request body (prevents mass assignment).
function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { HttpError, asyncHandler, isValidId, assertId, pick, escapeRegex };
