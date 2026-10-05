// Action contracts: the only way UnifiedAI changes anything.
//
// The language model never writes to the database. It can only *propose* an action by name (through the planner). The backend
// then runs the action through one fixed pipeline:
//
//   authorize  may THIS person do this to THIS record?          (backend rules, never the model)
//   validate   are the parameters complete and sane?
//   execute    do it
//   verify     read the result back: did it actually happen?
//
// The reply to the person is built from the verified result, so the assistant can only say what really happened
// ("raised", "added to your ticket", "notified Anita Verma") and never claim an unconfirmed success.
//
// Each contract: { name, describe, requires (what must be true of the caller), params (name -> description),
//                  authorize(ctx, p) -> { ok, why? }, validate(p) -> [errors], execute(ctx, p) -> data,
//                  verify(ctx, p, data) -> { ok, checks } }

const registry = new Map();

function register(contract) {
  for (const key of ['name', 'describe', 'authorize', 'validate', 'execute', 'verify']) {
    if (!contract[key]) throw new Error(`Action contract ${contract.name || '?'} is missing ${key}`);
  }
  registry.set(contract.name, contract);
}

// What the person may do right now (used by documentation, tests and the planner's vocabulary).
const catalog = () => [...registry.values()].map((a) => ({ name: a.name, describe: a.describe, requires: a.requires || null, params: a.params || {} }));

// Runs one action. Never throws: failures are returned so the caller can tell the person honestly.
// -> { name, ok, executed, verified, denied, data, error, checks }
async function run(name, ctx, params) {
  const contract = registry.get(name);
  const base = { name, ok: false, executed: false, verified: false, denied: false, data: null, error: null, checks: [] };
  if (!contract) return { ...base, error: `Unknown action ${name}` };
  const started = Date.now();
  try {
    const auth = await contract.authorize(ctx, params);
    if (!auth.ok) { const out = { ...base, denied: true, error: auth.why || 'not_allowed' }; ctx.trace?.step(`action:${name}`, { denied: true, why: out.error }, false); return out; }
    const problems = contract.validate(params);
    if (problems.length) { ctx.trace?.step(`action:${name}`, { invalid: problems }, false); return { ...base, error: `Invalid: ${problems.join(', ')}` }; }
    const data = await contract.execute(ctx, params);
    const verdict = await contract.verify(ctx, params, data);
    const out = { ...base, executed: true, verified: !!verdict.ok, ok: !!verdict.ok, data, checks: verdict.checks || [] };
    ctx.trace?.step(`action:${name}`, { executed: true, verified: out.verified, ms: Date.now() - started }, out.ok);
    return out;
  } catch (err) {
    ctx.trace?.step(`action:${name}`, { error: String(err.message || err).slice(0, 120) }, false);
    return { ...base, error: String(err.message || err).slice(0, 200) };
  }
}

require('./ticketActions')(register);

module.exports = { run, catalog, register };
