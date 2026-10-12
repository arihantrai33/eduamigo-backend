const mongoose = require('mongoose');

// Per-school running numbers (for example admission application numbers), incremented atomically.
const counterSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  key:    { type: String, required: true },
  seq:    { type: Number, default: 0 },
});
counterSchema.index({ school: 1, key: 1 }, { unique: true });

// The first call for a key creates the row. If two first calls arrive together, the unique index rejects one of them;
// that one is repeated and then increments the row the other created.
counterSchema.statics.next = async function next(school, key) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const doc = await this.findOneAndUpdate({ school, key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
      return doc.seq;
    } catch (err) {
      if (err.code !== 11000 || attempt >= 3) throw err;
    }
  }
};

module.exports = mongoose.model('Counter', counterSchema);
