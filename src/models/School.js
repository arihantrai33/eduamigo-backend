const mongoose = require('mongoose');
const crypto = require('crypto');
const { FEATURE_KEYS, SUBSCRIPTION_STATUSES, DEFAULT_TRIAL_DAYS, DEFAULT_GRACE_DAYS } = require('../config/features');

const CODE_PATTERN = /^[A-Z0-9]{3,12}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const schoolSchema = new mongoose.Schema({
  name:           { type: String, required: true },
  // Short public code (e.g. "GVPS"): typed on the "find your school" screen and used in school links.
  code:           { type: String, uppercase: true, trim: true, match: [CODE_PATTERN, 'School code must be 3 to 12 letters or digits'] },
  city:           { type: String, trim: true, default: '' },
  address:        { type: String, default: '' },
  phone:          { type: String, default: '' },
  email:          { type: String, default: '' },
  // Manual kill switch by the platform owner. Billing state lives in `subscription`.
  isActive:       { type: Boolean, default: true },
  customSubjects: [{ type: String }],
  principal:      { type: String, default: '' },
  workingDays:    { type: String, enum: ['Monday - Saturday', 'Monday - Friday'], default: 'Monday - Saturday' },
  // School gate location, used as the final stop on bus maps.
  location: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  // How the school appears in the apps, on receipts and on report cards.
  branding: {
    appName:      { type: String, trim: true, maxlength: 60, default: '' },
    logoUrl:      { type: String, trim: true, default: '' },
    primaryColor: { type: String, trim: true, default: '', validate: { validator: (v) => !v || HEX_COLOR.test(v), message: 'Colour must look like #1A73E8' } },
    tagline:      { type: String, trim: true, maxlength: 120, default: '' },
  },
  // The school's own web address for the portal, e.g. "erp.greenvalley.edu.in" (add-on).
  customDomain:   { type: String, lowercase: true, trim: true, validate: { validator: (v) => !v || DOMAIN.test(v), message: 'Invalid domain' } },
  // What the school has bought. Features = plan + addOns + overrides (see services/subscription.js).
  subscription: {
    plan:             { type: String, default: 'premium' },
    addOns:           [{ type: String, enum: FEATURE_KEYS }],
    enabledFeatures:  [{ type: String, enum: FEATURE_KEYS }],   // granted on top of the plan (custom deal)
    disabledFeatures: [{ type: String, enum: FEATURE_KEYS }],   // removed from the plan
    limits: {                                                    // per-school limit overrides; null = use the plan's
      maxStudents:         { type: Number, min: 0, default: null },
      aiQuestionsPerMonth: { type: Number, min: 0, default: null },
    },
    status:           { type: String, enum: SUBSCRIPTION_STATUSES, default: 'trial' },
    trialEndsAt:      { type: Date, default: () => new Date(Date.now() + DEFAULT_TRIAL_DAYS * 86400000) },
    currentPeriodEnd: { type: Date, default: null },             // paid until; null = no end date
    graceDays:        { type: Number, min: 0, max: 60, default: DEFAULT_GRACE_DAYS },
    notes:            { type: String, maxlength: 1000, default: '' },
  },
  // Online fee collection. Each school receives money in its own Razorpay account.
  // Secrets are stored encrypted (services/secrets.js) and never returned by the API.
  payments: {
    enabled:          { type: Boolean, default: false },
    provider:         { type: String, enum: ['razorpay'], default: 'razorpay' },
    keyId:            { type: String, default: '' },
    keySecretEnc:     { type: String, default: '' },
    webhookSecretEnc: { type: String, default: '' },
  },
}, { timestamps: true });

schoolSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
schoolSchema.index({ customDomain: 1 }, { unique: true, partialFilterExpression: { customDomain: { $type: 'string' } } });

const STOP_WORDS = new Set(['THE', 'OF', 'AND', '&']);

// "Green Valley Public School" -> "GVPS"; short names fall back to their first letters ("Alpha" -> "ALP").
function codeFromName(name) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
  let code = words.map((w) => w[0]).join('').slice(0, 8);
  if (code.length < 3) code = (words.join('') + 'SCH').slice(0, Math.max(3, code.length));
  return code;
}

async function availableCode(Model, base) {
  if (!(await Model.exists({ code: base }))) return base;
  for (let i = 0; i < 20; i += 1) {
    const candidate = `${base.slice(0, 8)}${crypto.randomInt(10, 1000)}`;
    if (!(await Model.exists({ code: candidate }))) return candidate;
  }
  throw new Error('Could not generate a unique school code');
}

// Every school gets a code. Given codes are validated; missing ones are generated from the name.
schoolSchema.pre('validate', async function assignCode() {
  if (!this.code) this.code = await availableCode(this.constructor, codeFromName(this.name));
  if (this.customDomain === '') this.customDomain = undefined;
});

schoolSchema.statics.codeFromName = codeFromName;
schoolSchema.statics.availableCode = function (base) { return availableCode(this, base); };

module.exports = mongoose.model('School', schoolSchema);
