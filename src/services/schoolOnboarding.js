// Creates a school and its first admin. Used by the platform API and `npm run create-school`.
const School = require('../models/School');
const User = require('../models/User');
const { temporaryPassword, hashPassword } = require('./credentials');
const { findPlan } = require('./subscription');
const { FEATURES, DEFAULT_TRIAL_DAYS } = require('../config/features');
const { HttpError } = require('../utils/http');

const DAY = 86400000;
const clean = (v) => (typeof v === 'string' ? v.trim() : v);

async function onboardSchool(input = {}) {
  const name = clean(input.name);
  const adminName = clean(input.adminName);
  const adminEmail = String(input.adminEmail || '').trim().toLowerCase();
  if (!name || !adminName || !adminEmail) throw new HttpError(400, 'School name, admin name and admin email are required');
  if (!/^\S+@\S+\.\S+$/.test(adminEmail)) throw new HttpError(400, 'Admin email is not valid');
  if (await User.exists({ email: adminEmail })) throw new HttpError(409, `A user with email ${adminEmail} already exists`);

  const planCode = String(input.plan || 'premium').toLowerCase();
  const plan = await findPlan(planCode);
  if (!plan || plan.isActive === false) throw new HttpError(400, `Unknown plan: ${planCode}`);
  const addOns = [...new Set(input.addOns || [])];
  const unknown = addOns.filter((f) => !FEATURES[f]);
  if (unknown.length) throw new HttpError(400, `Unknown add-on: ${unknown.join(', ')}`);

  const code = input.code ? String(input.code).trim().toUpperCase() : undefined;
  if (code && await School.exists({ code })) throw new HttpError(409, `School code ${code} is already taken`);

  const trialDays = input.trialDays != null ? Number(input.trialDays) : DEFAULT_TRIAL_DAYS;
  if (!(trialDays >= 0 && trialDays <= 365)) throw new HttpError(400, 'Trial days must be between 0 and 365');

  const school = await School.create({
    name, code,
    city: clean(input.city) || '', address: clean(input.address) || '',
    phone: clean(input.phone) || '', email: clean(input.email) || adminEmail,
    subscription: {
      plan: plan.code, addOns,
      status: trialDays > 0 ? 'trial' : 'active',
      trialEndsAt: trialDays > 0 ? new Date(Date.now() + trialDays * DAY) : null,
      currentPeriodEnd: input.currentPeriodEnd ? new Date(input.currentPeriodEnd) : null,
    },
  });

  const password = temporaryPassword();
  let admin;
  try {
    admin = await User.create({
      name: adminName, email: adminEmail, role: 'admin', school: school._id, phone: clean(input.phone) || null,
      password: await hashPassword(password), mustChangePassword: true,
    });
  } catch (err) {
    await School.deleteOne({ _id: school._id }); // no half-created schools
    throw err;
  }
  return { school, admin, password };
}

module.exports = { onboardSchool };
