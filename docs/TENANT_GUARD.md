# Tenant guard

One forgotten `school` filter in a query can show one school's data to another. The tenant guard (`src/config/tenantGuard.js`)
turns that mistake into an error.

## What it checks
Inside a signed-in school request (`protect` calls `enterTenant`), every query on a model that has a `school` field must:
1. include `school`, with one concrete id (not `undefined`, `null`, `$in`, `$ne` or inside `$or`), and
2. use the **same school as the request**.

Covered: `find`, `findOne`, `countDocuments`, `distinct`, `findOneAnd*`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`,
`deleteMany`, `aggregate` (first `$match`) and `bulkWrite` (each operation). Document methods such as `doc.deleteOne()` run through the
same hook with only `_id`, so use `Model.deleteOne({ _id, school })` instead. `doc.save()` is not a query and is not checked.

## What it does not check
- Requests with no school context: platform owner routes, login and password reset, driver tokens, webhooks, background jobs, scripts.
  Those must scope themselves; their tests live next to them.
- `populate()`. Its internal `find({ _id: { $in } })` is allowed, because the ids come from documents that were fetched with a school
  filter. A hand-written `find({ _id: { $in } })` is allowed for the same reason, so take such ids from scoped documents only.
- Inserts (`create`, `insertMany`) and `save()`. `school` is `required` on most models, which is the check there.
- `$lookup` and other collections reached from inside an aggregation pipeline.

## Deliberate cross-school queries
Say so, with a reason:

    User.exists({ email }).setOptions({ crossTenant: 'login emails are unique across all schools' })

## Mode
`TENANT_GUARD=enforce` (default) throws; `warn` logs a `tenant_guard` line and continues; `off` disables.
`warn` is the escape hatch if a rarely used route turns out to have a missing filter in production; fix the filter, then go back to `enforce`.

## Tests
`tests/tenant-guard.test.js` covers the rules. `tests/tenant-delete-paths.test.js` exercises the delete routes that used to call
`doc.deleteOne()`. The whole suite runs in `enforce` mode, so any new route test also checks its own queries.
