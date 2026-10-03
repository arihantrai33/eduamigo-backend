// Public school lookup for the "find your school" screen, branded login pages and custom domains.
// Only what a login screen needs is ever returned: no contacts, plan or internal ids beyond the code.
const School = require('../models/School');
const { computeState } = require('./subscription');
const { escapeRegex } = require('../utils/http');

const PUBLIC_FIELDS = 'name code city branding customDomain isActive subscription.status subscription.trialEndsAt subscription.currentPeriodEnd subscription.graceDays';

function publicProfile(school) {
  return {
    code: school.code,
    name: school.name,
    city: school.city || '',
    appName: school.branding?.appName || school.name,
    logoUrl: school.branding?.logoUrl || '',
    primaryColor: school.branding?.primaryColor || '',
    tagline: school.branding?.tagline || '',
  };
}

// Suspended schools are hidden from search and lookup; read-only schools can still sign in.
const isListed = (school) => computeState(school).status !== 'suspended';

async function findByCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(clean)) return null;
  const school = await School.findOne({ code: clean }).select(PUBLIC_FIELDS);
  return school && isListed(school) ? school : null;
}

async function findByDomain(host) {
  const clean = String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!clean) return null;
  const school = await School.findOne({ customDomain: clean }).select(PUBLIC_FIELDS);
  return school && isListed(school) ? school : null;
}

// Name or code search; at least 3 characters, at most 10 results.
async function search(query) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  const words = q.split(/\s+/).slice(0, 5).map(escapeRegex);
  const filter = {
    $or: [
      { $and: words.map((w) => ({ name: { $regex: `(^|\\s)${w}`, $options: 'i' } })) },
      { code: q.toUpperCase() },
    ],
  };
  const schools = await School.find(filter).select(PUBLIC_FIELDS).sort({ name: 1 }).limit(20);
  return schools.filter(isListed).slice(0, 10);
}

// CORS: is this browser origin a school's own portal domain? Cached briefly; misses are cached too.
const domainCache = new Map();
const DOMAIN_CACHE_MS = 5 * 60 * 1000;

async function isSchoolDomainOrigin(origin) {
  let host;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  const cached = domainCache.get(host);
  if (cached && Date.now() - cached.at < DOMAIN_CACHE_MS) return cached.ok;
  const ok = !!(await School.exists({ customDomain: host, isActive: { $ne: false } }));
  if (domainCache.size > 1000) domainCache.clear();
  domainCache.set(host, { ok, at: Date.now() });
  return ok;
}

const clearDomainCache = () => domainCache.clear();

module.exports = { publicProfile, findByCode, findByDomain, search, isSchoolDomainOrigin, clearDomainCache };
