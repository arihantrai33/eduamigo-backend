const mongoose = require('mongoose');

// Per-school running numbers (for example admission application numbers), incremented atomically.
const counterSchema = new mongoose.Schema({
  school: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  key:    { type: String, required: true },
  seq:    { type: Number, default: 0 },
});
counterSchema.index({ school: 1, key: 1 }, { unique: true });

counterSchema.statics.next = async function next(school, key) {
  const doc = await this.findOneAndUpdate({ school, key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
  return doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
