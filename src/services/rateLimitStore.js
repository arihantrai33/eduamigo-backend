// Rate-limit counters kept in MongoDB, so they survive a restart and are shared by every server instance.
// Used by the limiters that protect logins and cost (see middleware/rateLimit.js). The coarse per-request flood guard stays
// in memory, because a database write on every request would cost more than it protects.
const RateLimit = require('../models/RateLimit');

class MongoRateLimitStore {
  constructor({ prefix = 'rl' } = {}) {
    this.prefix = prefix;
    this.localKeys = false; // counters are shared between instances
    this.windowMs = 60 * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  key(key) {
    return `${this.prefix}:${key}`;
  }

  // One atomic upsert: start a new window when none is open, otherwise add 1.
  async increment(key) {
    const now = new Date();
    const doc = await RateLimit.findOneAndUpdate(
      { _id: this.key(key) },
      [{
        $set: {
          hits: { $cond: [{ $gt: ['$resetAt', now] }, { $add: ['$hits', 1] }, 1] },
          resetAt: { $cond: [{ $gt: ['$resetAt', now] }, '$resetAt', new Date(now.getTime() + this.windowMs)] },
        },
      }],
      { upsert: true, returnDocument: 'after', updatePipeline: true },
    ).lean();
    return { totalHits: doc.hits, resetTime: doc.resetAt };
  }

  async decrement(key) {
    await RateLimit.updateOne({ _id: this.key(key), hits: { $gt: 0 } }, { $inc: { hits: -1 } });
  }

  async resetKey(key) {
    await RateLimit.deleteOne({ _id: this.key(key) });
  }
}

module.exports = { MongoRateLimitStore };
