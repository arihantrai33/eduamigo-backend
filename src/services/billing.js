// Builds EduAmigo invoices for schools.
//   plan line   = active students x plan price per student per year x share of the year
//   add-on line = active students x add-on price (or its flat yearly price) x share of the year
//   discount    = school's subscription.discountPercent of the lines
//   tax         = GST (GST_RATE, default 18%) on the discounted subtotal
// Features granted as a custom deal (subscription.enabledFeatures) are not billed. Items without a price
// are skipped and reported as warnings, so a forgotten price never shows up as a free line.

const School = require('../models/School');
const Student = require('../models/Student');
const Invoice = require('../models/Invoice');
const { FEATURES } = require('../config/features');
const { findPlan, allAddOns } = require('./subscription');
const { HttpError } = require('../utils/http');

const DAY = 86400000;
const round2 = (n) => Math.round(n * 100) / 100;
const taxRate = () => {
  const r = Number(process.env.GST_RATE);
  return Number.isFinite(r) && r >= 0 && r <= 100 ? r : 18;
};

function parsePeriod(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new HttpError(400, 'from and to must be dates');
  if (end < start) throw new HttpError(400, 'The period must end after it starts');
  end.setUTCHours(23, 59, 59, 999);
  const days = Math.round((end - start) / DAY);
  if (days > 3 * 366) throw new HttpError(400, 'A single invoice can cover at most three years');
  return { start, end, share: round2(days / 365) };
}

async function computeInvoice(school, { from, to }) {
  const { start, end, share } = parsePeriod(from, to);
  const sub = school.subscription || {};
  const plan = await findPlan(sub.plan);
  const students = await Student.countDocuments({ school: school._id, isActive: true });
  const lines = [];
  const warnings = [];

  if (!plan) warnings.push(`Unknown plan "${sub.plan}"`);
  else if (plan.pricePerStudentYear == null) warnings.push(`${plan.name} plan has no price yet`);
  else {
    lines.push({
      kind: 'plan', description: `${plan.name} plan: ${students} students x Rs ${plan.pricePerStudentYear}/student/year`,
      quantity: students, unitPrice: plan.pricePerStudentYear, periodShare: share,
      amount: round2(students * plan.pricePerStudentYear * share),
    });
  }

  const prices = new Map((await allAddOns()).map((a) => [a.feature, a]));
  const inPlan = new Set(plan?.features || []);
  for (const feature of sub.addOns || []) {
    if (inPlan.has(feature) || (sub.disabledFeatures || []).includes(feature)) continue;
    const price = prices.get(feature);
    const name = FEATURES[feature]?.name || feature;
    if (price?.pricePerStudentYear != null) {
      lines.push({ kind: 'addon', description: `${name} add-on: ${students} students x Rs ${price.pricePerStudentYear}/student/year`,
        quantity: students, unitPrice: price.pricePerStudentYear, periodShare: share, amount: round2(students * price.pricePerStudentYear * share) });
    } else if (price?.flatPricePerYear != null) {
      lines.push({ kind: 'addon', description: `${name} add-on: Rs ${price.flatPricePerYear}/year`,
        quantity: 1, unitPrice: price.flatPricePerYear, periodShare: share, amount: round2(price.flatPricePerYear * share) });
    } else {
      warnings.push(`${name} add-on has no price yet`);
    }
  }

  const gross = round2(lines.reduce((s, l) => s + l.amount, 0));
  const discountPercent = Number(sub.discountPercent) || 0;
  if (discountPercent > 0 && gross > 0) {
    lines.push({ kind: 'discount', description: `Discount ${discountPercent}%`, quantity: 1, unitPrice: 0, periodShare: 1, amount: -round2(gross * discountPercent / 100) });
  }
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const rate = taxRate();
  const tax = round2(subtotal * rate / 100);
  return {
    periodFrom: start, periodTo: end, periodShare: share, plan: plan?.code || sub.plan || '', activeStudents: students,
    lines, subtotal, taxRate: rate, tax, total: round2(subtotal + tax), warnings,
  };
}

async function nextNumber(year) {
  const prefix = `INV-${year}-`;
  const last = await Invoice.findOne({ number: { $regex: `^${prefix}` } }).sort({ number: -1 }).select('number').lean();
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

async function createInvoice(school, { from, to, dueDate, notes, issue = false, createdBy = null }) {
  const draft = await computeInvoice(school, { from, to });
  if (!(draft.subtotal > 0)) {
    throw new HttpError(400, `Nothing to bill: ${draft.warnings.join('; ') || 'no priced plan or add-on'}. Set prices first.`, { warnings: draft.warnings });
  }
  const due = dueDate ? new Date(dueDate) : new Date(Date.now() + 15 * DAY);
  if (Number.isNaN(due.getTime())) throw new HttpError(400, 'dueDate is not a valid date');
  const { warnings, periodShare, ...fields } = draft;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const invoice = await Invoice.create({
        ...fields, number: await nextNumber(new Date().getUTCFullYear()), school: school._id,
        dueDate: due, notes: String(notes || '').slice(0, 1000), createdBy,
        status: issue ? 'issued' : 'draft', issuedAt: issue ? new Date() : null,
      });
      return { invoice, warnings };
    } catch (err) {
      if (err.code !== 11000) throw err; // two invoices took the same number at once: try the next one
    }
  }
  throw new HttpError(500, 'Could not assign an invoice number');
}

// draft -> issued -> paid; draft/issued -> void. Paying extends the school's paid period to the invoice end.
async function changeStatus(invoice, action, { paymentRef } = {}) {
  const allowed = { issue: ['draft'], mark_paid: ['issued'], void: ['draft', 'issued'] };
  if (!allowed[action]) throw new HttpError(400, 'action must be issue, mark_paid or void');
  if (!allowed[action].includes(invoice.status)) throw new HttpError(409, `A ${invoice.status} invoice cannot be ${action.replace('_', ' ')}`);
  if (action === 'issue') Object.assign(invoice, { status: 'issued', issuedAt: new Date() });
  if (action === 'void') invoice.status = 'void';
  if (action === 'mark_paid') {
    Object.assign(invoice, { status: 'paid', paidAt: new Date(), paymentRef: String(paymentRef || '').trim().slice(0, 120) });
    const school = await School.findById(invoice.school);
    if (school && school.subscription?.status !== 'suspended') {
      const current = school.subscription.currentPeriodEnd;
      if (school.subscription.status !== 'active' || (current && current < invoice.periodTo)) {
        school.subscription.currentPeriodEnd = invoice.periodTo;
      }
      school.subscription.status = 'active';
      await school.save();
    }
  }
  await invoice.save();
  return invoice;
}

module.exports = { computeInvoice, createInvoice, changeStatus, parsePeriod };
