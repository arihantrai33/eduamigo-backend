// Independent checks of the tutor's arithmetic, so a worked answer is not trusted on the model's word alone.
//
// The tutor ends a worked solution with one or more ```check blocks (JSON, one per line):
//   {"type":"value","expr":"3/4 + 1/8","answer":"7/8"}                       the expression equals the answer
//   {"type":"equation","equation":"2x + 3 = 11","variable":"x","answer":"4"} the answer satisfies the equation
//   {"type":"equation","equation":"x^2 - 5x + 6 = 0","variable":"x","answer":"2, 3"}   every listed root does
// The server evaluates them here with its own parser (no eval): exact fractions with BigInt where possible, floating point
// for roots and trigonometry. A check that cannot be evaluated is "unsupported", never "passed". Passing a check means only
// that this calculation is right, not that the explanation around it is.

const MAX_LEN = 240;
const MAX_DEPTH = 40;
const MAX_EXP = 64;
const EPS = 1e-9;

// ---- numbers: exact fractions { n, d } (BigInt, d > 0) or floats { f } ----
const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const frac = (n, d = 1n) => {
  if (d === 0n) throw new Error('division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
};
const isExact = (x) => x.n !== undefined;
const toFloat = (x) => (isExact(x) ? Number(x.n) / Number(x.d) : x.f);
const flt = (f) => { if (!Number.isFinite(f)) throw new Error('not a finite number'); return { f }; };

function fromDecimal(text) {
  const [i, fpart = ''] = text.split('.');
  return frac(BigInt(`${i || '0'}${fpart}`), 10n ** BigInt(fpart.length));
}

const ops = {
  add: (a, b) => (isExact(a) && isExact(b) ? frac(a.n * b.d + b.n * a.d, a.d * b.d) : flt(toFloat(a) + toFloat(b))),
  sub: (a, b) => (isExact(a) && isExact(b) ? frac(a.n * b.d - b.n * a.d, a.d * b.d) : flt(toFloat(a) - toFloat(b))),
  mul: (a, b) => (isExact(a) && isExact(b) ? frac(a.n * b.n, a.d * b.d) : flt(toFloat(a) * toFloat(b))),
  div: (a, b) => {
    if (isExact(a) && isExact(b)) return frac(a.n * b.d, a.d * b.n);
    if (Math.abs(toFloat(b)) < 1e-300) throw new Error('division by zero');
    return flt(toFloat(a) / toFloat(b));
  },
  pow: (a, b) => {
    if (isExact(a) && isExact(b) && b.d === 1n) {
      if (b.n > BigInt(MAX_EXP) || b.n < -BigInt(MAX_EXP)) throw new Error('exponent too large');
      const e = b.n < 0n ? -b.n : b.n;
      const r = frac(a.n ** e, a.d ** e);
      return b.n < 0n ? frac(r.d, r.n) : r;
    }
    return flt(toFloat(a) ** toFloat(b));
  },
  neg: (a) => (isExact(a) ? frac(-a.n, a.d) : flt(-a.f)),
};

const isqrt = (n) => { if (n < 2n) return n; let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x -= 1n; while ((x + 1n) * (x + 1n) <= n) x += 1n; return x; };
const FUNCS = {
  sqrt: (a) => {
    if (isExact(a) && a.n >= 0n) { const rn = isqrt(a.n); const rd = isqrt(a.d); if (rn * rn === a.n && rd * rd === a.d) return frac(rn, rd); }
    if (toFloat(a) < 0) throw new Error('square root of a negative number');
    return flt(Math.sqrt(toFloat(a)));
  },
  // School trigonometry is in degrees.
  sin: (a) => flt(Math.sin((toFloat(a) * Math.PI) / 180)),
  cos: (a) => flt(Math.cos((toFloat(a) * Math.PI) / 180)),
  tan: (a) => flt(Math.tan((toFloat(a) * Math.PI) / 180)),
  abs: (a) => (isExact(a) ? frac(a.n < 0n ? -a.n : a.n, a.d) : flt(Math.abs(a.f))),
  log: (a) => flt(Math.log10(toFloat(a))),
  ln: (a) => flt(Math.log(toFloat(a))),
};
const CONSTS = { pi: () => flt(Math.PI), e: () => flt(Math.E) };

// ---- tokenizer and recursive-descent parser ----
function tokenize(src) {
  const text = String(src).replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/\*\*/g, '^').replace(/√/g, 'sqrt')
    .replace(/π/g, 'pi').replace(/²/g, '^2').replace(/³/g, '^3');
  if (text.length > MAX_LEN) throw new Error('expression too long');
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(text.slice(i));
    if (num) { tokens.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[a-zA-Z]+/.exec(text.slice(i));
    if (id) { tokens.push({ t: 'id', v: id[0].toLowerCase() }); i += id[0].length; continue; }
    if ('+-*/^(),%'.includes(c)) { tokens.push({ t: c }); i += 1; continue; }
    throw new Error(`unexpected "${c}"`);
  }
  // Implicit multiplication: 2x, 3(4+1), (a)(b), x(2).
  const out = [];
  for (const tok of tokens) {
    const prev = out[out.length - 1];
    const prevEnds = prev && (prev.t === 'num' || prev.t === ')' || (prev.t === 'id' && !FUNCS[prev.v]));
    const starts = tok.t === 'num' || tok.t === '(' || tok.t === 'id';
    if (prevEnds && starts && !(prev.t === 'num' && tok.t === 'num')) out.push({ t: '*' });
    out.push(tok);
  }
  return out;
}

function parse(src, vars = {}) {
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const take = (t) => { if (peek()?.t !== t) throw new Error(`expected "${t}"`); pos += 1; };
  const guard = (fn) => { depth += 1; if (depth > MAX_DEPTH) throw new Error('expression too deep'); try { return fn(); } finally { depth -= 1; } };

  const expr = () => guard(() => {
    let v = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) { const op = peek().t; pos += 1; v = op === '+' ? ops.add(v, term()) : ops.sub(v, term()); }
    return v;
  });
  const term = () => {
    let v = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) { const op = peek().t; pos += 1; v = op === '*' ? ops.mul(v, unary()) : ops.div(v, unary()); }
    return v;
  };
  const unary = () => guard(() => {
    if (peek()?.t === '-') { pos += 1; return ops.neg(unary()); }
    if (peek()?.t === '+') { pos += 1; return unary(); }
    return power();
  });
  const power = () => {
    const base = postfix();
    if (peek()?.t === '^') { pos += 1; return ops.pow(base, unary()); } // right-associative
    return base;
  };
  const postfix = () => {
    let v = atom();
    while (peek()?.t === '%') { pos += 1; v = ops.div(v, frac(100n)); }
    return v;
  };
  const atom = () => guard(() => {
    const tok = peek();
    if (!tok) throw new Error('incomplete expression');
    if (tok.t === 'num') { pos += 1; return fromDecimal(tok.v); }
    if (tok.t === '(') { pos += 1; const v = expr(); take(')'); return v; }
    if (tok.t === 'id') {
      pos += 1;
      if (FUNCS[tok.v]) { take('('); const v = expr(); take(')'); return FUNCS[tok.v](v); }
      if (Object.prototype.hasOwnProperty.call(vars, tok.v)) return vars[tok.v];
      if (CONSTS[tok.v]) return CONSTS[tok.v]();
      throw new Error(`unknown name "${tok.v}"`);
    }
    throw new Error(`unexpected "${tok.t}"`);
  });

  const v = expr();
  if (pos !== tokens.length) throw new Error(`unexpected "${peek().t === 'num' || peek().t === 'id' ? peek().v : peek().t}"`);
  return v;
}

const equal = (a, b) => {
  if (isExact(a) && isExact(b)) return a.n === b.n && a.d === b.d;
  const x = toFloat(a); const y = toFloat(b);
  return Math.abs(x - y) <= EPS * Math.max(1, Math.abs(x), Math.abs(y));
};
// A rounded answer ("1.73") is accepted for an irrational value when it matches to the digits given.
const matchesRounded = (value, answerText) => {
  const m = /^-?\d+\.(\d+)$/.exec(String(answerText).trim());
  if (!m || isExact(value)) return false;
  const digits = m[1].length;
  return Math.abs(toFloat(value) - Number(answerText)) <= 0.5 * 10 ** -digits + EPS;
};

const show = (x) => (isExact(x) ? (x.d === 1n ? String(x.n) : `${x.n}/${x.d}`) : String(Math.round(x.f * 1e9) / 1e9));

// Evaluates an expression for the tutor and the answer checker. Returns { ok, value, text } or { ok: false, error }.
function evaluate(src, vars = {}) {
  try {
    const v = parse(src, vars);
    return { ok: true, value: v, text: show(v), exact: isExact(v) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// True when two written answers are the same number (3/4, 0.75, 75% and 6/8 are all the same).
function sameNumber(a, b) {
  const x = evaluate(a); const y = evaluate(b);
  if (!x.ok || !y.ok) return null;
  return equal(x.value, y.value) || matchesRounded(x.value, b) || matchesRounded(y.value, a);
}

// Runs one check block. Returns { status: 'passed'|'failed'|'unsupported', kind, detail }.
function runCheck(check) {
  try {
    if (!check || typeof check !== 'object') return { status: 'unsupported', detail: 'not a check' };
    if (check.type === 'value') {
      const v = evaluate(check.expr);
      if (!v.ok) return { status: 'unsupported', kind: 'value', detail: v.error };
      const a = evaluate(check.answer);
      if (!a.ok) return { status: 'unsupported', kind: 'value', detail: a.error };
      const ok = equal(v.value, a.value) || matchesRounded(v.value, check.answer);
      return { status: ok ? 'passed' : 'failed', kind: 'value', detail: ok ? `${check.expr} = ${v.text}` : `${check.expr} is ${v.text}, not ${check.answer}` };
    }
    if (check.type === 'equation') {
      const variable = String(check.variable || 'x').toLowerCase();
      if (!/^[a-z]$/.test(variable)) return { status: 'unsupported', kind: 'equation', detail: 'one-letter variable expected' };
      const [left, right, extra] = String(check.equation || '').split('=');
      if (!left || right === undefined || extra !== undefined) return { status: 'unsupported', kind: 'equation', detail: 'one "=" expected' };
      const answers = String(check.answer || '').split(/[,;]| or | and /).map((s) => s.replace(new RegExp(`^\\s*${variable}\\s*=`), '').trim()).filter(Boolean);
      if (!answers.length || answers.length > 4) return { status: 'unsupported', kind: 'equation', detail: 'no answer to check' };
      for (const ans of answers) {
        const val = evaluate(ans);
        if (!val.ok) return { status: 'unsupported', kind: 'equation', detail: val.error };
        const l = evaluate(left, { [variable]: val.value });
        const r = evaluate(right, { [variable]: val.value });
        if (!l.ok || !r.ok) return { status: 'unsupported', kind: 'equation', detail: l.error || r.error };
        if (!equal(l.value, r.value)) return { status: 'failed', kind: 'equation', detail: `${variable} = ${ans} gives ${l.text} on the left and ${r.text} on the right` };
      }
      return { status: 'passed', kind: 'equation', detail: `${variable} = ${answers.join(', ')} checked by substitution` };
    }
    return { status: 'unsupported', detail: `unknown check type "${check.type}"` };
  } catch (err) {
    return { status: 'unsupported', detail: err.message };
  }
}

// Pulls ```check blocks out of an answer. Returns { text without the blocks, checks: [parsed objects] }.
function extractChecks(answer) {
  const checks = [];
  const text = String(answer || '').replace(/```check\s*\n([\s\S]*?)```/g, (_, body) => {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { checks.push(JSON.parse(t)); } catch { checks.push({ type: 'invalid', raw: t.slice(0, 120) }); }
    }
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), checks: checks.slice(0, 6) };
}

module.exports = { evaluate, sameNumber, runCheck, extractChecks, parse };
