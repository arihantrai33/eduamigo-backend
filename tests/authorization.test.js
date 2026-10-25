// The one place permissions are resolved: services/authorization.js. In this phase it must behave exactly like the static role table
// (so nothing changes for any user) while giving every caller one seam to later read roles from the database.
const fs = require('fs');
const path = require('path');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('../src/config/permissions');
const { PERMISSION_FEATURE } = require('../src/config/features');
const authz = require('../src/services/authorization');

const user = (role, over = {}) => ({ _id: 'u1', role, isActive: true, ...over });
const ALL_KEYS = Object.keys(PERMISSIONS);
const entitlementsWith = (features) => ({ features });

describe('parity with the static role table', () => {
  test.each(Object.keys(ROLE_PERMISSIONS))('%s: same permissions, same answers for every key', (role) => {
    expect([...authz.effectivePermissions(user(role))].sort()).toEqual([...ROLE_PERMISSIONS[role]].sort());
    for (const key of ALL_KEYS) expect(authz.can(user(role), key)).toBe(ROLE_PERMISSIONS[role].includes(key));
  });
});

describe('deny by default', () => {
  test('no user, an inactive user, an unknown role and the platform owner have no school permissions', () => {
    expect(authz.effectivePermissions(undefined)).toEqual([]);
    expect(authz.effectivePermissions(user('admin', { isActive: false }))).toEqual([]);
    expect(authz.effectivePermissions(user('principal-of-the-moon'))).toEqual([]);
    expect(authz.effectivePermissions(user('superadmin'))).toEqual([]);
    expect(authz.can(undefined, 'students.read')).toBe(false);
  });

  test('an unknown permission is refused even for the administrator', () => {
    expect(authz.can(user('admin'), 'students.teleport')).toBe(false);
    expect(authz.can(user('admin'), '')).toBe(false);
    expect(authz.can(user('admin'), undefined)).toBe(false);
    expect(authz.can(user('admin'), '__proto__')).toBe(false);
  });

  test('a role name that is an object key of the table (prototype names) gives nothing', () => {
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(authz.effectivePermissions(user(role))).toEqual([]);
  });
});

describe('plan entitlements cap what a role may use', () => {
  const noFees = entitlementsWith(['exams', 'chat']);
  test('without entitlements given, only the role decides (what the route middleware does today)', () => {
    expect(authz.can(user('accountant'), 'fees.collect')).toBe(true);
  });
  test('with entitlements, permissions of a module the school does not have are dropped', () => {
    expect(authz.can(user('accountant'), 'fees.collect', noFees)).toBe(false);
    expect(authz.effectivePermissions(user('admin'), noFees).filter((p) => PERMISSION_FEATURE[p] === 'fees')).toEqual([]);
    expect(authz.effectivePermissions(user('admin'), noFees)).toContain('students.read');
    expect(authz.can(user('admin'), 'fees.collect', entitlementsWith(['fees']))).toBe(true);
  });
});

describe('explain', () => {
  test('says why', () => {
    expect(authz.explain(user('admin'), 'students.read')).toEqual({ allowed: true, reason: 'allowed' });
    expect(authz.explain(user('teacher'), 'fees.collect').reason).toBe('role-lacks-permission');
    expect(authz.explain(user('admin', { isActive: false }), 'students.read').reason).toBe('inactive-account');
    expect(authz.explain(user('admin'), 'nope.nope').reason).toBe('unknown-permission');
    expect(authz.explain(user('accountant'), 'fees.collect', entitlementsWith([])).reason).toBe('module-not-in-plan');
    expect(authz.explain(undefined, 'students.read').reason).toBe('no-user');
  });
});

describe('no other code decides permissions from a role name', () => {
  // A static guard: if someone calls hasPermission(role, ...) or reads ROLE_PERMISSIONS directly, the seam is bypassed.
  test('only config/permissions.js, services/authorization.js and the role seeding (services/roles.js) use the role table', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const rel = path.relative(path.join(__dirname, '..', 'src'), full);
          if (['config/permissions.js', 'services/authorization.js', 'services/roles.js'].includes(rel)) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (/\bhasPermission\(|\bROLE_PERMISSIONS\b|\bpermissionsFor\(/.test(text)) offenders.push(rel);
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('controllers do not decide access from a staff role name', () => {
  // The relationship roles (student, parent) are account types and still branch in code. Staff roles are not: access follows the
  // permission (services/authorization.can) and the data scope (scopeOf / services/scope). EduAmigo Ask (src/assistant) is
  // reviewed separately and is not covered here.
  test("no 'role === admin | teacher | accountant' in controllers, routes, middleware or services", () => {
    const offenders = [];
    const pattern = /role\s*[!=]==?\s*'(admin|teacher|accountant)'/;
    for (const dir of ['controllers', 'routes', 'middleware', 'services']) {
      const base = path.join(__dirname, '..', 'src', dir);
      for (const file of fs.readdirSync(base)) {
        if (!file.endsWith('.js')) continue;
        const text = fs.readFileSync(path.join(base, file), 'utf8');
        text.split('\n').forEach((line, i) => { if (pattern.test(line) && !/^\s*\/\//.test(line)) offenders.push(`${dir}/${file}:${i + 1}`); });
      }
    }
    expect(offenders).toEqual([]);
  });
});
