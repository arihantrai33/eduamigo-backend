// Tenant guard: inside a signed-in school request, every query on a tenant model must filter by that request's school.
//
// Why: isolation depends on every query remembering `school`. One forgotten filter would show another school's data.
// This turns that mistake into an error (or a log line) instead of a silent leak.
//
// How it works
//  - `protect` calls enterTenant(schoolId) once the user is verified. AsyncLocalStorage carries it through the request.
//  - A global Mongoose plugin adds hooks to every model that has a `school` path.
//  - Outside a school request (platform owner routes, login, background jobs, scripts, tests setting up data) nothing is checked.
//  - A deliberate cross-school query must say so and why: Model.find(...).setOptions({ crossTenant: 'reason' }).
//
// Mode (env TENANT_GUARD): "enforce" (default) throws, "warn" logs and continues, "off" disables.
// It must be required before the models are compiled (server.js and src/app.js do this first).
const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

const storage = new AsyncLocalStorage();

const mode = () => (process.env.TENANT_GUARD || 'enforce').toLowerCase();

function enterTenant(schoolId) {
  storage.enterWith({ schoolId: String(schoolId) });
}
// Same context for just one async call; used by tests (and available to code that works on behalf of one school).
const runAsTenant = (schoolId, fn) => storage.run({ schoolId: String(schoolId) }, fn);
const currentTenant = () => storage.getStore()?.schoolId || null;

// Test hook: records what the guard saw instead of acting on it.
const seen = [];

class TenantGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantGuardError';
    this.status = 500;
  }
}

// Returns 'ok' | 'missing' | 'other'. A school value counts only if it is one concrete id equal to the request's school.
function checkFilter(filter, tenant) {
  if (!filter || typeof filter !== 'object') return 'missing';
  let result = 'missing';
  if (Object.prototype.hasOwnProperty.call(filter, 'school')) {
    const v = filter.school;
    const concrete = v && typeof v === 'object' && !(v instanceof mongoose.Types.ObjectId) && '$eq' in v ? v.$eq : v;
    if (concrete === undefined || concrete === null) return 'missing';
    if (typeof concrete === 'string' || concrete instanceof mongoose.Types.ObjectId) {
      return String(concrete) === tenant ? 'ok' : 'other';
    }
    return 'missing'; // operators such as $in / $ne / $exists do not pin the query to one school
  }
  if (Array.isArray(filter.$and)) {
    for (const part of filter.$and) {
      const r = checkFilter(part, tenant);
      if (r === 'ok') return 'ok';
      if (r === 'other') result = 'other';
    }
  }
  return result;
}

// Mongoose's populate() runs find({ _id: { $in: ids } }) on the referenced model, and gives that query no marker.
// The ids come from documents that were already fetched with a school filter, so this one exact shape is allowed.
// Trade-off: a hand-written find({ _id: { $in } }) is allowed too, so such code must take its ids from scoped documents.
function isIdListLookup(filter) {
  const keys = Object.keys(filter || {});
  if (keys.length !== 1 || keys[0] !== '_id') return false;
  const v = filter._id;
  return !!v && typeof v === 'object' && Object.keys(v).length === 1 && Array.isArray(v.$in);
}

function checkPipeline(pipeline, tenant) {
  const first = (pipeline || [])[0];
  return first && first.$match ? checkFilter(first.$match, tenant) : 'missing';
}

function report(model, op, problem, extra = {}) {
  const tenant = currentTenant();
  const where = (new Error().stack || '').split('\n').filter((l) => l.includes('/src/') && !l.includes('tenantGuard')).slice(0, 2).map((l) => l.trim()).join(' <- ');
  const message = `Tenant guard: ${model}.${op} ${problem === 'other' ? 'filters by a different school than the request' : 'has no school filter'} (${where || 'unknown caller'})`;
  seen.push({ model, op, problem, where, tenant, ...extra });
  if (mode() === 'warn') {
    require('../utils/logger').log.warn('tenant_guard', { model, op, problem, where, ...extra });
    return;
  }
  throw new TenantGuardError(message);
}

const QUERY_OPS = [
  'find', 'findOne', 'countDocuments', 'distinct',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace',
  'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
];

function tenantGuardPlugin(schema) {
  if (!schema.path('school')) return;
  QUERY_OPS.forEach((op) => {
    schema.pre(op, function guard() {
      if (mode() === 'off') return;
      const tenant = currentTenant();
      if (!tenant) return;
      if (this.getOptions().crossTenant) return;
      const filter = this.getFilter();
      if ((op === 'find') && isIdListLookup(filter)) return;
      const problem = checkFilter(filter, tenant);
      if (problem !== 'ok') report(this.model.modelName, op, problem, { keys: Object.keys(this.getFilter() || {}).join(',') });
    });
  });
  // bulkWrite skips query middleware, so each operation is checked here: its filter, or the school of a new document.
  schema.pre('bulkWrite', function guard(...args) {
    if (mode() === 'off') return;
    const tenant = currentTenant();
    if (!tenant) return;
    const ops = args.find(Array.isArray) || [];
    for (const operation of ops) {
      const [kind, body] = Object.entries(operation)[0] || [];
      if (!body) continue;
      const target = kind === 'insertOne' ? { school: body.document && body.document.school } : body.filter;
      const problem = checkFilter(target, tenant);
      if (problem !== 'ok') report(this.modelName, `bulkWrite.${kind}`, problem, { keys: Object.keys(target || {}).join(',') });
    }
  });
  schema.pre('aggregate', function guard() {
    if (mode() === 'off') return;
    const tenant = currentTenant();
    if (!tenant) return;
    if (this.options && this.options.crossTenant) return;
    const problem = checkPipeline(this.pipeline(), tenant);
    if (problem !== 'ok') report(this.model().modelName, 'aggregate', problem);
  });
}

mongoose.plugin(tenantGuardPlugin);

module.exports = { enterTenant, runAsTenant, currentTenant, checkFilter, TenantGuardError, seen };
