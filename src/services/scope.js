// Reusable record-scope checks. Controllers ask "what may this person reach?" here instead of branching on a role name.
//
//   const scope = await classScope(req.user, 'academic');      // { level: 'school' | 'assigned' | 'none', teacher? }
//   if (!coversClass(scope, cls, section)) throw new HttpError(403, ...);
//
// The level comes from the role's scope (services/authorization.js: scopeOf). 'assigned' is resolved from the person's own teacher
// record, never from anything the client sent, and a person with that scope but no teacher record covers nothing.
const { scopeOf } = require('./authorization');
const { teacherForUser } = require('./directory');
const { teacherCoversClass } = require('../utils/classes');

async function classScope(user, resource) {
  const level = scopeOf(user, resource);
  if (level === 'assigned') return { level, teacher: await teacherForUser(user) };
  return { level: level === 'school' ? 'school' : 'none' };
}

const coversClass = (scope, cls, section) => scope.level === 'school'
  || (scope.level === 'assigned' && teacherCoversClass(scope.teacher, cls, section));

module.exports = { classScope, coversClass };
