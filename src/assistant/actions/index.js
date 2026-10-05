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
// -> { name, state, ok, executed, verified, denied, data, error, checks }
//
// state says what really happened, and the reply is chosen from it:
//   denied      the person may not do this (nothing ran)
//   invalid     the parameters were not usable (nothing ran)
//   not_executed  it failed before changing anything, confirmed by looking (safe to try again)
//   error       it failed part-way and the contract cannot tell whether anything was saved (do NOT blindly retry)
//   unverified  it ran, but reading the result back did not confirm it (it may well have happened)
//   verified    it ran and the result was read back
async function run(name, ctx, params) {
  const contract = registry.get(name);
  const base = { name, state: 'invalid', ok: false, executed: false, verified: false, denied: false, data: null, error: null, checks: [] };
  const done = (out, details = {}, ok = out.ok) => { ctx.trace?.step(`action:${name}`, { state: out.state, ...details }, ok); return out; };
  if (!contract) return { ...base, error: `Unknown action ${name}` };
  const started = Date.now();

  let auth;
  try { auth = await contract.authorize(ctx, params); } catch (err) { return done({ ...base, state: 'not_executed', error: String(err.message || err).slice(0, 200) }); }
  if (!auth.ok) return done({ ...base, state: 'denied', denied: true, error: auth.why || 'not_allowed' }, { denied: true, why: auth.why || 'not_allowed' });
  const problems = contract.validate(params);
  if (problems.length) return done({ ...base, state: 'invalid', error: `Invalid: ${problems.join(', ')}` }, { invalid: problems });

  let data = null;
  let recovered = false;
  try {
    data = await contract.execute(ctx, params);
  } catch (err) {
    const message = String(err.message || err).slice(0, 200);
    // The write may have happened before the failure. A contract that can look for its own result says so; otherwise nobody knows.
    let found; let looked = false;
    if (contract.recover) { try { found = await contract.recover(ctx, params); looked = true; } catch { looked = false; } }
    if (found) { data = { ...found, recovered: true }; recovered = true; }
    else if (looked) return done({ ...base, state: 'not_executed', error: message }, { error: message.slice(0, 120), looked: true });
    else return done({ ...base, state: 'error', error: message }, { error: message.slice(0, 120), looked: false });
  }

  let verdict;
  try { verdict = await contract.verify(ctx, params, data); } catch (err) { verdict = { ok: false, checks: [{ name: 'verify_failed', ok: false }], error: String(err.message || err).slice(0, 120) }; }
  const failed = (verdict.checks || []).filter((c) => !c.ok).map((c) => c.name);
  const out = { ...base, failed, state: verdict.ok ? 'verified' : 'unverified', executed: true, verified: !!verdict.ok, ok: !!verdict.ok, data, checks: verdict.checks || [], error: verdict.ok ? null : (verdict.error || 'not_verified') };
  return done(out, { executed: true, verified: out.verified, ...(failed.length ? { failedChecks: failed } : {}), recovered, ms: Date.now() - started });
}

require('./ticketActions')(register);

module.exports = { run, catalog, register };
