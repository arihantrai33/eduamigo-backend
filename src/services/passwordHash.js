// Password hashing and checking. One place, so the sign-in path and the code that sets passwords use the same library.
//
// The native `bcrypt` package does its work on libuv worker threads, so a wave of sign-ins does not stop the thread that answers every
// other request. The pure-JavaScript `bcryptjs` it replaces ran each check (about 50 ms at cost 10) on that thread. Both read and write the
// same standard bcrypt format ($2a$/$2b$), so every stored hash keeps working and nobody is asked to change a password.
//
// If the native module cannot be loaded (a platform without a prebuilt binary), `bcryptjs` is used instead and a warning is logged once:
// sign-in still works, just without the speed-up.
let lib;
let implementation;
try {
  lib = require('bcrypt');
  implementation = 'bcrypt';
} catch (err) {
  lib = require('bcryptjs');
  implementation = 'bcryptjs';
  console.warn(`Native bcrypt could not be loaded (${err.code || err.message}); using bcryptjs. Sign-in works but blocks the request thread while it checks a password.`);
}

// Checking a password (sign-in) is limited to a few at a time. The native module shares libuv's four worker threads with file reads and
// DNS lookups, which wait in one first-in-first-out line: 400 sign-ins queued at once made a file read wait 5.4 s in a measurement. Keeping one
// thread free (threads - 1 checks at once) means other work waits behind at most a few checks (about 50 ms each). The rest wait here, in memory,
// without using a thread. If more than MAX_WAITING are already waiting, the sign-in is refused with 503 so a flood cannot build an endless queue;
// a person who sees it just tries again. Nothing about who may sign in changes.
const { HttpError } = require('../utils/http');

const positive = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };
const THREADS = positive(process.env.UV_THREADPOOL_SIZE, 4);
const MAX_RUNNING = positive(process.env.PASSWORD_CHECK_CONCURRENCY, Math.max(1, THREADS - 1));
const MAX_WAITING = positive(process.env.PASSWORD_CHECK_QUEUE, 300);
let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_RUNNING) { running += 1; return Promise.resolve(); }
  if (waiting.length >= MAX_WAITING) {
    const busy = new HttpError(503, 'Sign-in is very busy right now. Please try again in a few seconds.', { code: 'SIGN_IN_BUSY' });
    busy.expose = true; // the central error handler keeps the message of an error written for people
    return Promise.reject(busy);
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); // the slot passes straight to the next one in line
  else running -= 1;
}

const hash = (plain, rounds) => lib.hash(plain, rounds);
const compare = async (plain, hashed) => {
  await acquire();
  try { return await lib.compare(plain, hashed); } finally { release(); }
};
const stats = () => ({ running, waiting: waiting.length, maxRunning: MAX_RUNNING, maxWaiting: MAX_WAITING });

module.exports = { hash, compare, implementation, stats };
