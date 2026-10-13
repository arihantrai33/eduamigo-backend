// Visual explanations as data, never as code. The tutor writes a ```diagram block holding one JSON object; it is validated
// here against a fixed set of shapes and limits, and the app draws it with its own components (no model HTML, SVG or script
// is ever rendered). A function graph is sampled here with the safe evaluator in mathcheck.js. An invalid block is dropped
// and the written explanation stands on its own.
//
//   {"type":"numberline","min":-5,"max":5,"step":1,"points":[{"value":-2,"label":"A"}],"ranges":[{"from":1,"to":3,"label":"x > 1"}]}
//   {"type":"bar","title":"Rainfall","labels":["Jan","Feb"],"values":[12,30],"unit":"mm"}
//   {"type":"graph","expr":"x^2 - 1","xMin":-3,"xMax":3,"title":"y = x² − 1"}
//   {"type":"flow","title":"Photosynthesis","steps":["Light is absorbed","Water is split","Glucose is made"]}
//   {"type":"cycle","title":"Water cycle","steps":["Evaporation","Condensation","Precipitation","Collection"]}
//   {"type":"table","headers":["Planet","Moons"],"rows":[["Earth","1"],["Mars","2"]]}
// Every diagram gets "alt": a text description for screen readers (written by the tutor, or built here).

const { evaluate } = require('./mathcheck');

const MAX_DIAGRAMS = 3;
const str = (v, n = 80) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[<>]/g, '').trim().slice(0, n) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));

const VALIDATORS = {
  numberline(d) {
    const min = num(d.min); const max = num(d.max);
    if (min === null || max === null || max <= min || max - min > 1000) return null;
    const step = num(d.step) && num(d.step) > 0 && (max - min) / num(d.step) <= 40 ? num(d.step) : Math.max(1, Math.ceil((max - min) / 20));
    const points = (Array.isArray(d.points) ? d.points : []).slice(0, 10).map((p) => ({ value: num(p?.value), label: str(p?.label, 20) })).filter((p) => p.value !== null && p.value >= min && p.value <= max);
    const ranges = (Array.isArray(d.ranges) ? d.ranges : []).slice(0, 4).map((r) => ({ from: num(r?.from), to: num(r?.to), label: str(r?.label, 30) }))
      .filter((r) => r.from !== null && r.to !== null && r.from < r.to && r.from >= min && r.to <= max);
    return { type: 'numberline', min, max, step, points, ranges, title: str(d.title) };
  },
  bar(d) {
    const labels = (Array.isArray(d.labels) ? d.labels : []).slice(0, 12).map((l) => str(l, 24));
    const values = (Array.isArray(d.values) ? d.values : []).slice(0, 12).map(num);
    if (!labels.length || labels.length !== values.length || values.some((v) => v === null)) return null;
    return { type: 'bar', labels, values, unit: str(d.unit, 12), title: str(d.title) };
  },
  graph(d) {
    const xMin = num(d.xMin) ?? -5; const xMax = num(d.xMax) ?? 5;
    if (xMax <= xMin || xMax - xMin > 200 || typeof d.expr !== 'string' || d.expr.length > 80) return null;
    const points = [];
    for (let i = 0; i <= 60; i += 1) {
      const x = xMin + ((xMax - xMin) * i) / 60;
      const xv = { f: x };
      const y = evaluate(d.expr, { x: xv });
      if (!y.ok) { if (/unknown name|unexpected|incomplete/.test(y.error)) return null; continue; } // gaps (1/x at 0) are skipped
      const yv = Number(y.text);
      if (Number.isFinite(yv) && Math.abs(yv) < 1e6) points.push([Math.round(x * 1000) / 1000, Math.round(yv * 1000) / 1000]);
    }
    if (points.length < 5) return null;
    return { type: 'graph', expr: str(d.expr), xMin, xMax, points, title: str(d.title) || `y = ${str(d.expr)}` };
  },
  flow(d) {
    const steps = (Array.isArray(d.steps) ? d.steps : []).slice(0, 8).map((s) => str(s, 90)).filter(Boolean);
    return steps.length >= 2 ? { type: 'flow', steps, title: str(d.title) } : null;
  },
  cycle(d) {
    const steps = (Array.isArray(d.steps) ? d.steps : []).slice(0, 6).map((s) => str(s, 40)).filter(Boolean);
    return steps.length >= 3 ? { type: 'cycle', steps, title: str(d.title) } : null;
  },
  table(d) {
    const headers = (Array.isArray(d.headers) ? d.headers : []).slice(0, 6).map((h) => str(h, 30));
    const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 12).map((r) => (Array.isArray(r) ? r.slice(0, headers.length).map((c) => str(c, 60)) : null)).filter((r) => r && r.length === headers.length);
    return headers.length >= 2 && rows.length ? { type: 'table', headers, rows, title: str(d.title) } : null;
  },
};

function describe(d) {
  switch (d.type) {
    case 'numberline': return `Number line from ${d.min} to ${d.max}${d.points.length ? `, marking ${d.points.map((p) => `${p.label ? `${p.label} at ` : ''}${p.value}`).join(', ')}` : ''}${d.ranges.length ? `, shading ${d.ranges.map((r) => `${r.from} to ${r.to}`).join(' and ')}` : ''}.`;
    case 'bar': return `Bar chart${d.title ? ` of ${d.title}` : ''}: ${d.labels.map((l, i) => `${l} ${d.values[i]}${d.unit ? ` ${d.unit}` : ''}`).join(', ')}.`;
    case 'graph': return `Graph of ${d.title} for x from ${d.xMin} to ${d.xMax}.`;
    case 'flow': return `${d.title ? `${d.title}: ` : ''}${d.steps.map((s, i) => `step ${i + 1}, ${s}`).join('; ')}.`;
    case 'cycle': return `${d.title ? `${d.title}, ` : ''}a cycle: ${d.steps.join(', then ')}, and back to ${d.steps[0]}.`;
    case 'table': return `Table with columns ${d.headers.join(', ')} and ${d.rows.length} rows.`;
    default: return '';
  }
}

// Validates one parsed spec. Returns the clean diagram or null.
function validate(spec) {
  if (!spec || typeof spec !== 'object' || !VALIDATORS[spec.type]) return null;
  const clean = VALIDATORS[spec.type](spec);
  if (!clean) return null;
  clean.alt = str(spec.alt, 300) || describe(clean);
  return clean;
}

// Pulls ```diagram blocks out of an answer. Returns { text, diagrams, dropped } (dropped = blocks that failed validation).
function extractDiagrams(answer) {
  const diagrams = [];
  let dropped = 0;
  const text = String(answer || '').replace(/```diagram\s*\n([\s\S]*?)```/g, (_, body) => {
    let spec = null;
    try { spec = JSON.parse(body.trim()); } catch { spec = null; }
    const clean = diagrams.length < MAX_DIAGRAMS ? validate(spec) : null;
    if (clean) { diagrams.push(clean); return `\n[[diagram:${diagrams.length - 1}]]\n`; }
    dropped += 1;
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), diagrams, dropped };
}

module.exports = { validate, extractDiagrams, describe, TYPES: Object.keys(VALIDATORS) };
