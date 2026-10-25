// The one place "may this person do this" is decided from a role. Everything else (route middleware, controllers, the dashboard
// service, the login answer) asks here instead of looking at a role name.
//
// Today the answer comes from the static role table in config/permissions.js, so behaviour is unchanged. Keeping the decision in one
// function is what lets roles later be read from the database (tenant-scoped SchoolRole documents, extra roles on a user) without
// touching 120 routes. A static test (tests/authorization.test.js) fails if any other file uses the role table directly.
//
//   can(user, 'fees.collect')                  the role may; this is what requirePermission uses
//   can(user, 'fees.collect', entitlements)    and the school's plan includes the module (what login reports to the apps)
//   effectivePermissions(user, entitlements)   the full list
//   explain(user, permission, entitlements)    { allowed, reason }, for support and tests
//
// Deny by default: no user, an inactive account, a role the table does not know, a permission that is not in the catalogue, or a
// platform (superadmin) account all give no permission here. The platform owner has its own API and middleware.
const { PERMISSIONS, ROLE_PERMISSIONS, ROLE_SCOPE } = require('../config/permissions');
const { PERMISSION_FEATURE } = require('../config/features');

const own = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);

function rolePermissions(role) {
  return own(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role] : [];
}

// A user whose roles were resolved for this request (services/roles.js: resolveAuthz, done by protect) carries `authz`. Anything else
// (a role-only stand-in, a user loaded outside a request) is read from the static table, which is what the built-in roles are seeded from.
function effectivePermissions(user, entitlements) {
  if (!user || user.isActive === false) return [];
  const base = user.authz ? user.authz.permissions : rolePermissions(user.role);
  if (!entitlements) return base;
  const features = entitlements.features || [];
  return base.filter((p) => !PERMISSION_FEATURE[p] || features.includes(PERMISSION_FEATURE[p]));
}

function can(user, permission, entitlements) {
  return own(PERMISSIONS, permission) && effectivePermissions(user, entitlements).includes(permission);
}

function explain(user, permission, entitlements) {
  if (!user) return { allowed: false, reason: 'no-user' };
  if (user.isActive === false) return { allowed: false, reason: 'inactive-account' };
  if (!own(PERMISSIONS, permission)) return { allowed: false, reason: 'unknown-permission' };
  if (!effectivePermissions(user).includes(permission)) return { allowed: false, reason: 'role-lacks-permission' };
  if (entitlements && PERMISSION_FEATURE[permission] && !(entitlements.features || []).includes(PERMISSION_FEATURE[permission])) {
    return { allowed: false, reason: 'module-not-in-plan' };
  }
  return { allowed: true, reason: 'allowed' };
}

// 'school' | 'assigned' | 'own' | 'none' (see ROLE_SCOPE). Like permissions: an inactive account or an unknown role gets 'none'.
function scopeOf(user, resource) {
  if (!user || user.isActive === false) return 'none';
  const scopes = user.authz ? user.authz.scopes : (own(ROLE_SCOPE, user.role) ? ROLE_SCOPE[user.role] : {});
  return own(scopes, resource) ? scopes[resource] : 'none';
}

module.exports = { effectivePermissions, can, explain, scopeOf };
