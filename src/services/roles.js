// School roles as data: built-in roles seeded from the code table, custom roles made from templates, and the one function that turns
// a person into what they may do (resolveAuthz).
//
// Resolution (every request, in `protect`, so a change applies on the very next call and nothing is cached across requests):
//   permissions = the person's own role (its SchoolRole, or the code table while the school has not been seeded)
//                 + every active extra role of this school the person holds
//   scopes      = per family of records, the widest of those roles (school > assigned > own); a family no role mentions is 'none'
// A role of another school, an inactive role, or one that no longer exists gives nothing.
const SchoolRole = require('../models/SchoolRole');
const User = require('../models/User');
const { PERMISSIONS, ROLE_PERMISSIONS, ROLE_SCOPE } = require('../config/permissions');
const { ROLE_TEMPLATES, SCOPE_FAMILIES } = require('../config/roleTemplates');
const { can, scopeOf, effectivePermissions } = require('./authorization');
const { HttpError } = require('../utils/http');

const SYSTEM_ROLES = { admin: 'Administrator', accountant: 'Accountant', teacher: 'Teacher' };
const RANK = { none: 0, own: 1, assigned: 2, school: 3 };
const SCOPE_VALUES = ['school', 'assigned', 'own'];
// Accounts that take extra roles: staff of the school, not students, parents, drivers or the platform owner.
const ROLE_HOLDERS = ['accountant', 'teacher', 'staff'];
const idOf = (v) => String(v?._id || v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function ensureSystemRoles(schoolId) {
  for (const key of Object.keys(SYSTEM_ROLES)) {
    await SchoolRole.updateOne(
      { school: schoolId, key },
      { $setOnInsert: { school: schoolId, key, name: SYSTEM_ROLES[key], description: 'Built-in role', permissions: ROLE_PERMISSIONS[key], scopes: ROLE_SCOPE[key], isSystem: true, isActive: true } },
      { upsert: true },
    );
  }
}

const widest = (a, b) => (RANK[b] > RANK[a || 'none'] ? b : a);

async function resolveAuthz(user) {
  const school = idOf(user.school);
  const extra = (user.extraRoles || []).map(idOf);
  // Students, parents and staff accounts without extra roles have no role document to look up: no query (most requests).
  const docs = !extra.length && !own(SYSTEM_ROLES, user.role) ? [] : await SchoolRole.find({ school, $or: [{ key: user.role, isSystem: true }, ...(extra.length ? [{ _id: { $in: extra } }] : [])] }).lean();
  const own_ = docs.find((d) => d.isSystem && d.key === user.role);
  // Base role: the school's seeded role, or the code table before the school has been seeded (what protect fell back to before roles were data).
  const base = own_ ? { permissions: own_.permissions, scopes: own_.scopes } : { permissions: own(ROLE_PERMISSIONS, user.role) ? ROLE_PERMISSIONS[user.role] : [], scopes: own(ROLE_SCOPE, user.role) ? ROLE_SCOPE[user.role] : {} };
  const permissions = new Set(base.permissions.filter((p) => own(PERMISSIONS, p)));
  const scopes = { ...plain(base.scopes) };
  const held = [];
  for (const d of docs) {
    if (d === own_ || d.isActive === false || !extra.includes(String(d._id))) continue;
    if (d.isSystem && d.key === 'admin') continue; // never handed out as an extra role
    held.push({ id: String(d._id), key: d.key, name: d.name });
    d.permissions.filter((p) => own(PERMISSIONS, p)).forEach((p) => permissions.add(p));
    for (const [family, level] of Object.entries(plain(d.scopes))) scopes[family] = widest(scopes[family], level);
  }
  return { permissions: [...permissions], scopes, roles: held };
}

// Mongo returns a Map for `scopes` from a document and a plain object from .lean(): both become a plain object.
const plain = (m) => (m instanceof Map ? Object.fromEntries(m) : { ...(m || {}) });

// ---------------- Validating what a role may be made of ----------------

function cleanName(v) {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Give the role a name of 2 to 60 characters');
  return name;
}

function cleanPermissions(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Permissions must be a list');
  const out = [...new Set(list.map(String))];
  const unknown = out.filter((p) => !own(PERMISSIONS, p));
  if (unknown.length) throw new HttpError(400, `Unknown permission: ${unknown.join(', ')}`);
  return out;
}

function cleanScopes(obj) {
  if (obj === undefined || obj === null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new HttpError(400, 'Scopes must be an object');
  const out = {};
  for (const [family, level] of Object.entries(obj)) {
    if (!own(SCOPE_FAMILIES, family)) throw new HttpError(400, `Unknown scope family: ${family}`);
    if (!SCOPE_VALUES.includes(level)) throw new HttpError(400, `Scope for ${family} must be one of ${SCOPE_VALUES.join(', ')}`);
    out[family] = level;
  }
  return out;
}

// The actor may only hand out what they hold: every permission, and for every family a scope no wider than their own.
function assertDelegable(actor, permissions, scopes) {
  const lacking = permissions.filter((p) => !can(actor, p));
  if (lacking.length) throw new HttpError(403, `You cannot give permissions you do not hold: ${lacking.join(', ')}`);
  for (const [family, level] of Object.entries(scopes)) {
    if (RANK[level] > RANK[scopeOf(actor, family)]) throw new HttpError(403, `You cannot give wider access to ${SCOPE_FAMILIES[family].toLowerCase()} than you have`);
  }
}

function isFullAdministrator(user) {
  const held = effectivePermissions(user);
  return Object.keys(PERMISSIONS).every((p) => held.includes(p));
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'role';

async function uniqueKey(school, name) {
  const base = /^[a-z]/.test(slug(name)) ? slug(name) : `r_${slug(name)}`;
  for (let i = 0; i < 20; i += 1) {
    const key = i ? `${base}_${i + 1}` : base;
    if (!(await SchoolRole.exists({ school, key }))) return key;
  }
  throw new HttpError(409, 'Could not make a unique key for this role, try another name');
}

async function createRole(actor, school, body = {}) {
  const name = cleanName(body.name);
  const template = body.templateKey ? ROLE_TEMPLATES.find((t) => t.key === body.templateKey) : null;
  if (body.templateKey && !template) throw new HttpError(400, 'Unknown template');
  const permissions = cleanPermissions(body.permissions !== undefined ? body.permissions : template ? template.permissions : undefined);
  if (!permissions.length) throw new HttpError(400, 'Choose at least one permission');
  const scopes = cleanScopes(body.scopes !== undefined ? body.scopes : template ? template.scopes : {});
  assertDelegable(actor, permissions, scopes);
  if (await SchoolRole.exists({ school, name }).collation({ locale: 'en', strength: 2 })) throw new HttpError(409, 'A role with this name already exists');
  return SchoolRole.create({
    school, key: await uniqueKey(school, name), name, description: typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '',
    templateKey: template?.key || '', permissions, scopes, isSystem: false, isActive: true, createdBy: actor._id,
  });
}

const heldBy = (user, role) => (user.extraRoles || []).map(idOf).includes(String(role._id)) || (role.isSystem && role.key === user.role);

async function loadRole(school, id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) throw new HttpError(404, 'Role not found');
  const role = await SchoolRole.findOne({ _id: id, school });
  if (!role) throw new HttpError(404, 'Role not found');
  return role;
}

// What changing a role would do, without doing it.
async function previewChange(school, role, body = {}) {
  const permissions = body.permissions !== undefined ? cleanPermissions(body.permissions) : role.permissions;
  const scopes = body.scopes !== undefined ? cleanScopes(body.scopes) : plain(role.scopes);
  const before = new Set(role.permissions);
  const after = new Set(permissions);
  const old = plain(role.scopes);
  const scopeChanges = Object.keys({ ...old, ...scopes }).filter((f) => old[f] !== scopes[f]).map((f) => ({ family: f, from: old[f] || 'none', to: scopes[f] || 'none' }));
  const affectedUsers = await User.countDocuments({ school, extraRoles: role._id });
  return { added: [...after].filter((p) => !before.has(p)).sort(), removed: [...before].filter((p) => !after.has(p)).sort(), scopeChanges, affectedUsers };
}

async function updateRole(actor, school, id, body = {}) {
  const role = await loadRole(school, id);
  if (role.isSystem) throw new HttpError(403, 'Built-in roles cannot be changed. Make a new role from them instead.');
  if (heldBy(actor, role)) throw new HttpError(403, 'You cannot change a role you hold yourself. Ask another administrator.');
  const before = { permissions: [...role.permissions], scopes: plain(role.scopes), name: role.name, isActive: role.isActive };
  if (body.name !== undefined) {
    role.name = cleanName(body.name);
    if (role.name.toLowerCase() !== before.name.toLowerCase() && await SchoolRole.exists({ school, name: role.name, _id: { $ne: role._id } }).collation({ locale: 'en', strength: 2 })) throw new HttpError(409, 'A role with this name already exists');
  }
  if (body.description !== undefined) role.description = String(body.description).trim().slice(0, 300);
  if (body.permissions !== undefined) role.permissions = cleanPermissions(body.permissions);
  if (body.scopes !== undefined) role.scopes = cleanScopes(body.scopes);
  if (body.isActive !== undefined) role.isActive = !!body.isActive;
  if (!role.permissions.length) throw new HttpError(400, 'Choose at least one permission');
  assertDelegable(actor, role.permissions, plain(role.scopes));
  await role.save();
  const added = role.permissions.filter((p) => !before.permissions.includes(p));
  const removed = before.permissions.filter((p) => !role.permissions.includes(p));
  return { role, details: { name: role.name, added, removed, isActive: role.isActive } };
}

async function deleteRole(actor, school, id) {
  const role = await loadRole(school, id);
  if (role.isSystem) throw new HttpError(403, 'Built-in roles cannot be deleted');
  if (heldBy(actor, role)) throw new HttpError(403, 'You cannot delete a role you hold yourself');
  const users = await User.countDocuments({ school, extraRoles: role._id });
  if (users) throw new HttpError(409, `${users} ${users === 1 ? 'person has' : 'people have'} this role. Remove it from them first.`);
  await SchoolRole.deleteOne({ _id: role._id, school });
  return role;
}

// Sets the extra roles of one staff account.
async function assignRoles(actor, school, targetId, roleIds) {
  if (!Array.isArray(roleIds)) throw new HttpError(400, 'roleIds must be a list');
  if (String(targetId) === String(actor._id)) throw new HttpError(403, 'You cannot change your own roles. Ask another administrator.');
  const target = /^[a-f0-9]{24}$/.test(String(targetId)) ? await User.findOne({ _id: targetId, school }) : null;
  if (!target) throw new HttpError(404, 'Person not found');
  if (!ROLE_HOLDERS.includes(target.role)) throw new HttpError(400, 'Roles can only be given to school staff (teachers, accountants and other staff)');
  const ids = [...new Set(roleIds.map(String))];
  if (ids.some((i) => !/^[a-f0-9]{24}$/.test(i))) throw new HttpError(400, 'Unknown role');
  const found = ids.length ? await SchoolRole.find({ _id: { $in: ids }, school }) : [];
  if (found.length !== ids.length) throw new HttpError(400, 'One or more roles do not exist in this school');
  for (const r of found) {
    if (r.isSystem && r.key === 'admin') throw new HttpError(400, 'The administrator role cannot be given as an extra role');
    if (r.isActive === false) throw new HttpError(400, `The role "${r.name}" is switched off`);
    assertDelegable(actor, r.permissions, plain(r.scopes));
  }
  const before = (target.extraRoles || []).map(String);
  // Roles the actor is taking away are checked too: removing a role with permissions they lack is also giving up their reach.
  const removedIds = before.filter((i) => !ids.includes(i));
  if (removedIds.length) {
    const gone = await SchoolRole.find({ _id: { $in: removedIds }, school });
    for (const r of gone) assertDelegable(actor, r.permissions, plain(r.scopes));
  }
  target.extraRoles = ids;
  await target.save();
  return { target, details: { added: ids.filter((i) => !before.includes(i)), removed: removedIds } };
}

// Who holds what, for a clear summary of one person's access.
async function accessOf(school, userId) {
  const user = /^[a-f0-9]{24}$/.test(String(userId)) ? await User.findOne({ _id: userId, school }) : null;
  if (!user) throw new HttpError(404, 'Person not found');
  const authz = await resolveAuthz(user);
  return { user: { _id: user._id, name: user.name, role: user.role, isActive: user.isActive }, ...authz };
}

module.exports = {
  ensureSystemRoles, resolveAuthz, createRole, updateRole, deleteRole, assignRoles, previewChange, loadRole, accessOf, isFullAdministrator, plain,
  SYSTEM_ROLES, ROLE_HOLDERS,
};
