// Small helpers for running database work in parallel without flooding it, and for serialising work on one key.

// Like Promise.all(items.map(fn)) but with at most `limit` calls running at once; results keep the input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Runs fn after every earlier call with the same key has finished (in this process). It removes avoidable collisions
// between requests that arrive together; across several server processes the database's unique indexes still decide,
// so callers must also handle a duplicate-key error.
const tails = new Map();
async function withKeyLock(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

const isDuplicateKey = (err) => !!err && (err.code === 11000 || err.cause?.code === 11000);

module.exports = { mapLimit, withKeyLock, isDuplicateKey };
