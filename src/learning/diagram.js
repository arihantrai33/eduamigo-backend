// Visual explanations as data, never as code. The tutor writes a ```diagram block holding one JSON object; it is validated
// here against a fixed set of shapes and limits, and the app draws it with its own components (no model HTML, SVG or script
// is ever rendered). A function graph is sampled here with the safe evaluator in mathcheck.js. An invalid block is dropped
// and the written explanation stands on its own.
//
//   {"type":"numberline","min":-5,"max":5,"step":1,"points":[{"value":-2,"label":"A"}],"ranges":[{"from":1,"to":3,"label":"x > 1"}]}
//   {"type":"bar","title":"Rainfall","labels":["Jan","Feb"],"values":[12,30],"unit":"mm"}
//   {"type":"graph","expr":"x^2 - 1","xMin":-3,"xMax":3,"title":"y = x² − 1"}
//   {"type":"graph","series":[{"expr":"x","label":"y = x"},{"expr":"x^2","label":"y = x²"}],"xMin":-2,"xMax":2,"xLabel":"x","yLabel":"y"}
//   {"type":"conceptmap","center":"Photosynthesis","branches":[{"label":"Needs","children":["Light","Water","CO2"]},{"label":"Makes","children":["Glucose","Oxygen"]}]}
//   {"type":"flow","title":"Photosynthesis","steps":["Light is absorbed","Water is split","Glucose is made"]}
//   {"type":"cycle","title":"Water cycle","steps":["Evaporation","Condensation","Precipitation","Collection"]}
//   {"type":"table","headers":["Planet","Moons"],"rows":[["Earth","1"],["Mars","2"]]}
//   {"type":"lens","kind":"convex","u":20,"f":15,"unit":"cm"}   a ray diagram worked out here from 1/v - 1/u = 1/f (also "kind":"concave")
//   {"type":"labeled","subject":"plant_cell"}   a ready-made labelled drawing: plant_cell, animal_cell, atom, earth_layers, circuit
//   {"type":"scene","title":"Plant cell","h":60,"elements":[{"t":"rect","x":10,"y":8,"w":80,"h":44,"r":8,"color":"green"},{"t":"text","x":50,"y":30,"text":"Cell wall","anchor":"middle"}]}
//      a drawing from simple shapes on a 100 x h canvas (line, circle, ellipse, rect, poly, curve, text), with named colours only
// Every diagram gets "alt": a text description for screen readers (written by the tutor, or built here).

const { evaluate } = require('./mathcheck');
const drawings = require('./drawings');

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
    if (xMax <= xMin || xMax - xMin > 200) return null;
    // One expression, or up to three lines with a label each (shown as a legend).
    const specs = Array.isArray(d.series) && d.series.length ? d.series.slice(0, 3) : [{ expr: d.expr, label: d.label }];
    const series = [];
    for (const spec of specs) {
      if (typeof spec?.expr !== 'string' || spec.expr.length > 80) return null;
      const points = [];
      for (let i = 0; i <= 60; i += 1) {
        const x = xMin + ((xMax - xMin) * i) / 60;
        const y = evaluate(spec.expr, { x: { f: x } });
        if (!y.ok) { if (/unknown name|unexpected|incomplete/.test(y.error)) return null; continue; } // gaps (1/x at 0) are skipped
        const yv = Number(y.text);
        if (Number.isFinite(yv) && Math.abs(yv) < 1e6) points.push([Math.round(x * 1000) / 1000, Math.round(yv * 1000) / 1000]);
      }
      if (points.length < 5) return null;
      series.push({ expr: str(spec.expr), label: str(spec.label, 30) || `y = ${str(spec.expr)}`, points });
    }
    return {
      type: 'graph', expr: series[0].expr, xMin, xMax, points: series[0].points, series,
      xLabel: str(d.xLabel, 20), yLabel: str(d.yLabel, 20), title: str(d.title) || (series.length === 1 ? series[0].label : ''),
    };
  },
  conceptmap(d) {
    const center = str(d.center, 40);
    const branches = (Array.isArray(d.branches) ? d.branches : []).slice(0, 6).map((b) => ({
      label: str(b?.label, 30), children: (Array.isArray(b?.children) ? b.children : []).slice(0, 3).map((c) => str(c, 30)).filter(Boolean),
    })).filter((b) => b.label);
    return center && branches.length >= 2 ? { type: 'conceptmap', center, branches, title: str(d.title) } : null;
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

// ---- Drawings -------------------------------------------------------------------------------------------------------
// A scene is a small drawing on a 100 x h canvas made of a few kinds of shapes. The model sends only numbers, short labels and
// colour NAMES; this validates and clamps all of it, and the app draws it itself. No markup from the model is ever used.
const COLORS = ['ink', 'brand', 'green', 'orange', 'red', 'blue', 'grey'];
const color = (v, d = 'ink') => (COLORS.includes(v) ? v : d);
const coord = (v, lo, hi) => { const n = num(v); return n === null ? null : Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)); };
const MAX_ELEMENTS = 70;

function sceneElements(list, H) {
  const X = (v) => coord(v, -5, 105); const Y = (v) => coord(v, -5, H + 5);
  const out = [];
  for (const e of (Array.isArray(list) ? list : []).slice(0, MAX_ELEMENTS)) {
    const t = e?.t;
    const base = { color: color(e?.color), dash: !!e?.dash, fill: e?.fill === true || COLORS.includes(e?.fill) ? (e.fill === true ? color(e.color) : e.fill) : null, sw: Math.min(3, Math.max(0.5, num(e?.sw) || 1)) };
    let el = null;
    if (t === 'line' || t === 'curve') {
      const v = ['x1', 'y1', 'x2', 'y2'].map((k, i) => (i % 2 ? Y(e[k]) : X(e[k])));
      if (v.some((n) => n === null)) continue;
      el = { t, x1: v[0], y1: v[1], x2: v[2], y2: v[3], arrow: !!e.arrow };
      if (t === 'curve') { const cx = X(e.cx); const cy = Y(e.cy); if (cx === null || cy === null) continue; el.cx = cx; el.cy = cy; }
    } else if (t === 'circle') {
      const cx = X(e.cx); const cy = Y(e.cy); const r = coord(e.r, 0.3, 60);
      if (cx === null || cy === null || r === null) continue;
      el = { t, cx, cy, r };
    } else if (t === 'ellipse') {
      const cx = X(e.cx); const cy = Y(e.cy); const rx = coord(e.rx, 0.3, 60); const ry = coord(e.ry, 0.3, 60);
      if (cx === null || cy === null || rx === null || ry === null) continue;
      el = { t, cx, cy, rx, ry };
    } else if (t === 'rect') {
      const x = X(e.x); const y = Y(e.y); const w = coord(e.w, 0.5, 110); const h = coord(e.h, 0.5, 90);
      if (x === null || y === null || w === null || h === null) continue;
      el = { t, x, y, w, h, r: coord(e.r, 0, 30) ?? 0 };
    } else if (t === 'poly') {
      const pts = (Array.isArray(e.points) ? e.points : []).slice(0, 16).map((p) => (Array.isArray(p) ? [X(p[0]), Y(p[1])] : [null, null]));
      if (pts.length < 2 || pts.some((p) => p[0] === null || p[1] === null)) continue;
      el = { t, points: pts, closed: e.closed !== false };
    } else if (t === 'text') {
      const x = X(e.x); const y = Y(e.y); const text = str(e.text, 40);
      if (x === null || y === null || !text) continue;
      el = { t, x, y, text, size: coord(e.size, 2, 9) ?? 3.6, anchor: ['start', 'middle', 'end'].includes(e.anchor) ? e.anchor : 'middle', bold: !!e.bold };
    }
    if (el) out.push({ ...base, ...el });
  }
  return out;
}

VALIDATORS.scene = (d) => {
  const h = Math.min(80, Math.max(30, num(d.h) || 60));
  const elements = sceneElements(d.elements, h);
  return elements.length >= 3 ? { type: 'scene', title: str(d.title), h, elements, caption: str(d.caption, 200) } : null;
};

// A ready-made labelled drawing (plant cell, animal cell, atom, layers of the Earth, simple circuit); see drawings.js.
VALIDATORS.labeled = (d) => {
  const art = drawings.labeled(d, str);
  return art ? { type: 'scene', title: art.title, h: 70, elements: art.shapes, caption: '' } : null;
};

// A ray diagram for a thin lens, worked out from the lens formula so every distance in the picture is right. Object distance u and
// focal length f are positive numbers (same unit); "kind" says convex (converging) or concave (diverging).
VALIDATORS.lens = (d) => {
  const u = num(d.u); const f = num(d.f);
  const convex = d.kind !== 'concave';
  if (u === null || f === null || u <= 0 || f <= 0 || u > 1e4 || f > 1e4) return null;
  const unit = str(d.unit, 6) || 'cm';
  // Signed image distance (positive = on the far side of the lens, a real image): convex 1/v = 1/f - 1/u, concave 1/v = -1/f - 1/u.
  const inv = (convex ? 1 / f : -1 / f) - 1 / u;
  if (Math.abs(inv) < 1e-9) return null; // the image is at infinity: nothing to draw
  const v = 1 / inv;
  const m = -v / u; // negative = inverted
  if (Math.abs(v) > 4 * Math.max(u, f)) return null;
  const s = 40 / Math.max(u, Math.abs(v), f * 1.4, 1);
  const cx = 50; const ay = 30;
  const oh = Math.min(11, 19 / Math.max(1, Math.abs(m))); // the object's height on the page (small enough that the image fits)
  const ih = m * oh;
  const ox = cx - u * s; const ix = cx + v * s;
  const tipY = ay - oh; const itipY = ay - ih;
  const n = (x) => Math.round(x * 100) / 100;
  const real = v > 0;
  const el = [];
  const line = (x1, y1, x2, y2, extra = {}) => el.push({ t: 'line', x1: n(x1), y1: n(y1), x2: n(x2), y2: n(y2), color: 'grey', dash: false, fill: null, sw: 1, arrow: false, ...extra });
  const text = (x, y, tx, extra = {}) => el.push({ t: 'text', x: n(x), y: n(y), text: tx, size: 3.4, anchor: 'middle', bold: false, color: 'ink', dash: false, fill: null, sw: 1, ...extra });
  // Axis, lens and the two focal points.
  line(3, ay, 97, ay);
  el.push({ t: 'curve', x1: cx, y1: 6, x2: cx, y2: 54, cx: convex ? cx + 9 : cx - 7, cy: ay, color: 'blue', dash: false, fill: null, sw: 1.6, arrow: false });
  el.push({ t: 'curve', x1: cx, y1: 6, x2: cx, y2: 54, cx: convex ? cx - 9 : cx + 7, cy: ay, color: 'blue', dash: false, fill: null, sw: 1.6, arrow: false });
  for (const side of [-1, 1]) {
    const fx = cx + side * f * s;
    el.push({ t: 'circle', cx: n(fx), cy: ay, r: 0.9, color: 'ink', dash: false, fill: 'ink', sw: 1 });
    text(fx, ay + 5.5, 'F');
  }
  text(cx, ay + 5.5, 'O', { color: 'blue' });
  // Object and image.
  line(ox, ay, ox, tipY, { color: 'ink', sw: 1.8, arrow: true });
  // For a virtual image the object and image are close together above the axis, so their names go on rows below it.
  if (real) text(ox, tipY - 3.2, 'Object', { bold: true });
  else text(Math.min(86, Math.max(10, ox)), ay + 11, 'Object', { bold: true });
  line(ix, ay, ix, itipY, { color: 'orange', sw: 1.8, arrow: true, dash: !real });
  if (real) text(Math.min(86, Math.max(14, ix)), itipY + (itipY < ay ? -3.2 : 5.2), 'Real image', { bold: true, color: 'orange' });
  else text(Math.min(38, Math.max(14, ix)), ay + 17, 'Virtual image', { bold: true, color: 'orange' });
  // Two rays: one parallel to the axis then refracted, one straight through the optical centre. Both lie on lines through the image tip.
  const through = (y0) => {
    if (real) { line(cx, y0, ix, itipY, { color: 'brand', sw: 1.1, arrow: true }); return; }
    const dx = cx - ix; const dy = y0 - itipY; // from the image tip to the lens point, extended to the right edge
    const k = (96 - cx) / (dx || 1);
    line(cx, y0, 96, y0 + dy * k, { color: 'brand', sw: 1.1, arrow: true });
    line(cx, y0, ix, itipY, { color: 'brand', sw: 1, dash: true });
  };
  line(ox, tipY, cx, tipY, { color: 'brand', sw: 1.1, arrow: true });
  through(tipY);
  // Ray through the optical centre (undeviated): from the object tip through O.
  line(ox, tipY, cx, ay, { color: 'green', sw: 1.1, arrow: true });
  if (real) line(cx, ay, ix, itipY, { color: 'green', sw: 1.1, arrow: true });
  else {
    const k = (96 - cx) / ((cx - ix) || 1);
    line(cx, ay, 96, ay + (ay - itipY) * k, { color: 'green', sw: 1.1, arrow: true });
    line(cx, ay, ix, itipY, { color: 'green', sw: 1, dash: true });
  }
  text(24, 58, `u = ${n(u)} ${unit}`, { color: 'grey' });
  text(76, 58, `v = ${n(Math.abs(v))} ${unit}`, { color: 'grey' });
  const nature = `${real ? 'real' : 'virtual'}, ${real ? 'inverted' : 'upright'}, ${Math.abs(m) > 1.02 ? 'magnified' : Math.abs(m) < 0.98 ? 'diminished' : 'same size'}`;
  const caption = `${convex ? 'Convex' : 'Concave'} lens, u = ${n(u)} ${unit}, f = ${n(f)} ${unit}: image at ${n(Math.abs(v))} ${unit} on the ${real ? 'other side' : 'same side as the object'}; ${nature} (magnification ${n(m)}).`;
  return { type: 'scene', title: str(d.title) || `${convex ? 'Convex' : 'Concave'} lens ray diagram`, h: 60, elements: el, caption };
};

function describe(d) {
  switch (d.type) {
    case 'numberline': return `Number line from ${d.min} to ${d.max}${d.points.length ? `, marking ${d.points.map((p) => `${p.label ? `${p.label} at ` : ''}${p.value}`).join(', ')}` : ''}${d.ranges.length ? `, shading ${d.ranges.map((r) => `${r.from} to ${r.to}`).join(' and ')}` : ''}.`;
    case 'bar': return `Bar chart${d.title ? ` of ${d.title}` : ''}: ${d.labels.map((l, i) => `${l} ${d.values[i]}${d.unit ? ` ${d.unit}` : ''}`).join(', ')}.`;
    case 'graph': return `Graph of ${d.series.length > 1 ? d.series.map((x) => x.label).join(' and ') : (d.title || d.series[0].label)} for x from ${d.xMin} to ${d.xMax}.`;
    case 'conceptmap': return `Concept map of ${d.center}: ${d.branches.map((b) => `${b.label}${b.children.length ? ` (${b.children.join(', ')})` : ''}`).join('; ')}.`;
    case 'flow': return `${d.title ? `${d.title}: ` : ''}${d.steps.map((s, i) => `step ${i + 1}, ${s}`).join('; ')}.`;
    case 'cycle': return `${d.title ? `${d.title}, ` : ''}a cycle: ${d.steps.join(', then ')}, and back to ${d.steps[0]}.`;
    case 'scene': return `Drawing${d.title ? `: ${d.title}` : ''}.${d.caption ? ` ${d.caption}` : ''}`;
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
