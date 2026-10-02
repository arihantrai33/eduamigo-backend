// Static guard: every literal field name used in a model query must exist on that model's schema.
// This would have caught bugs such as filtering on `schoolId` when the field is `school`.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const models = {};
for (const f of fs.readdirSync(path.join(ROOT, 'models'))) {
  const M = require(path.join(ROOT, 'models', f));
  if (M && M.schema) models[M.modelName] = M;
}
function fieldsOf(M) {
  const s = new Set(['_id', 'id', 'createdAt', 'updatedAt', '__v']);
  M.schema.eachPath((p) => { s.add(p); s.add(p.split('.')[0]); });
  Object.keys(M.schema.virtuals).forEach((v) => s.add(v));
  return s;
}
const known = (fields, key) => fields.has(key) || fields.has(key.split('.')[0]);
const sourceFiles = ['controllers', 'services', 'routes', 'jobs', 'middleware']
  .flatMap((d) => fs.readdirSync(path.join(ROOT, d)).map((f) => path.join(ROOT, d, f)));

function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  const problems = [];
  const line = (i) => src.slice(0, i).split('\n').length;
  const queryRe = /\b([A-Z]\w+)\.(find|findOne|findOneAndUpdate|findOneAndDelete|updateOne|updateMany|deleteOne|deleteMany|countDocuments|exists|create|distinct)\(\s*\{([^{}]*)\}/g;
  let m;
  while ((m = queryRe.exec(src))) {
    const M = models[m[1]];
    if (!M) continue;
    const fields = fieldsOf(M);
    for (const k of m[3].matchAll(/(?:^|,|\{)\s*['"]?([a-zA-Z_][\w.]*)['"]?\s*:/g)) {
      if (!k[1].startsWith('$') && !known(fields, k[1])) problems.push(`${path.relative(ROOT, file)}:${line(m.index)} ${m[1]} has no field "${k[1]}"`);
    }
    for (const k of m[3].matchAll(/(?:^|,|\{)\s*([a-zA-Z_]\w*)\s*(?=,|$)/g)) {
      if (!known(fields, k[1])) problems.push(`${path.relative(ROOT, file)}:${line(m.index)} ${m[1]} has no field "${k[1]}"`);
    }
  }
  // The chain may not run into another model call (e.g. two queries inside one Promise.all).
  const selectRe = /\b([A-Z]\w+)\.\w+\((?:(?!\b[A-Z]\w+\.(?:find|findOne|findById)\()[^;])*?\.select\(\s*'([^']+)'\s*\)/gs;
  while ((m = selectRe.exec(src))) {
    const M = models[m[1]];
    if (!M) continue;
    const fields = fieldsOf(M);
    for (const raw of m[2].split(/\s+/)) {
      const k = raw.replace(/^[-+]/, '');
      if (k && !known(fields, k)) problems.push(`${path.relative(ROOT, file)}:${line(m.index)} ${m[1]} select has no field "${k}"`);
    }
  }
  return problems;
}

test('queries only use field names that exist on the model', () => {
  expect(sourceFiles.flatMap(scan)).toEqual([]);
});

test('no code reads req.user.schoolId (the scoped id is req.schoolId, set by protect)', () => {
  const hits = sourceFiles.filter((f) => /req\.user\.schoolId/.test(fs.readFileSync(f, 'utf8')));
  expect(hits).toEqual([]);
});
