// Ready-made school drawings for the AI Tutor: the shapes are drawn here (once, carefully), and the model only chooses which
// one to show. A freehand drawing from a language model is usually crude; these are exact, labelled and consistent.
//   {"type":"labeled","subject":"plant_cell"}                      all the parts
//   {"type":"labeled","subject":"plant_cell","parts":["Nucleus"]}   only the named parts are labelled
// A drawing is { shapes: [scene elements], parts: [{ name, ax, ay (the point on the part), side: 'l' | 'r', ly (label height) }] }.
// Labels sit in the two side columns with a thin line to the part. Everything is on a 100 x 70 canvas.

const E = (t, o) => ({ t, color: 'ink', dash: false, fill: null, sw: 1, ...o });
const rect = (x, y, w, h, r, o = {}) => E('rect', { x, y, w, h, r, ...o });
const circle = (cx, cy, r, o = {}) => E('circle', { cx, cy, r, ...o });
const ellipse = (cx, cy, rx, ry, o = {}) => E('ellipse', { cx, cy, rx, ry, ...o });
const line = (x1, y1, x2, y2, o = {}) => E('line', { x1, y1, x2, y2, arrow: false, ...o });
const poly = (points, o = {}) => E('poly', { points, closed: true, ...o });
const curve = (x1, y1, cx, cy, x2, y2, o = {}) => E('curve', { x1, y1, cx, cy, x2, y2, arrow: false, ...o });

const DRAWINGS = {
  plant_cell: {
    title: 'Plant cell',
    shapes: [
      rect(32, 7, 36, 56, 7, { color: 'green', sw: 2.4, fill: 'green' }),
      rect(34.5, 9.5, 31, 51, 5, { color: 'brand', sw: 1 }),
      ellipse(50, 36, 8.5, 17, { color: 'blue', fill: 'blue', sw: 1 }),
      circle(41, 19, 5.5, { color: 'red', fill: 'red', sw: 1.2 }), circle(41, 19, 1.8, { color: 'red', fill: 'red', sw: 1 }),
      ellipse(60.5, 17, 3.4, 2, { color: 'green', fill: 'green', sw: 1.2 }), ellipse(60, 54, 3.4, 2, { color: 'green', fill: 'green', sw: 1.2 }), ellipse(40, 51, 3.4, 2, { color: 'green', fill: 'green', sw: 1.2 }),
      ellipse(61, 36, 2.8, 1.5, { color: 'orange', fill: 'orange', sw: 1 }),
    ],
    parts: [
      { name: 'Nucleus', ax: 41, ay: 19, side: 'l', ly: 14 },
      { name: 'Cytoplasm', ax: 37, ay: 31, side: 'l', ly: 28 },
      { name: 'Cell membrane', ax: 34.5, ay: 41, side: 'l', ly: 42 },
      { name: 'Chloroplast', ax: 40, ay: 51, side: 'l', ly: 56 },
      { name: 'Cell wall', ax: 68, ay: 12, side: 'r', ly: 8 },
      { name: 'Chloroplast ', ax: 60.5, ay: 17, side: 'r', ly: 22, hide: true },
      { name: 'Large vacuole', ax: 52, ay: 34, side: 'r', ly: 34 },
      { name: 'Mitochondrion', ax: 61, ay: 36, side: 'r', ly: 46 },
    ],
  },
  animal_cell: {
    title: 'Animal cell',
    shapes: [
      ellipse(50, 36, 19, 27, { color: 'brand', sw: 2, fill: 'brand' }),
      circle(48, 33, 8, { color: 'red', fill: 'red', sw: 1.2 }), circle(48, 33, 2.6, { color: 'red', fill: 'red', sw: 1 }),
      ellipse(58, 49, 3.6, 1.9, { color: 'orange', fill: 'orange', sw: 1 }), ellipse(40, 50, 3.6, 1.9, { color: 'orange', fill: 'orange', sw: 1 }),
      circle(41, 21, 1.1, { color: 'ink', fill: 'ink', sw: 1 }), circle(60, 25, 1.1, { color: 'ink', fill: 'ink', sw: 1 }), circle(55, 55, 1.1, { color: 'ink', fill: 'ink', sw: 1 }),
      ellipse(60, 38, 2.6, 1.6, { color: 'green', fill: 'green', sw: 1 }),
    ],
    parts: [
      { name: 'Nucleus', ax: 48, ay: 33, side: 'l', ly: 16 },
      { name: 'Nucleolus', ax: 48, ay: 33, side: 'l', ly: 30, hide: true },
      { name: 'Cytoplasm', ax: 38, ay: 38, side: 'l', ly: 38 },
      { name: 'Mitochondrion', ax: 40, ay: 50, side: 'l', ly: 54 },
      { name: 'Cell membrane', ax: 68.6, ay: 28, side: 'r', ly: 14 },
      { name: 'Ribosome', ax: 60, ay: 25, side: 'r', ly: 28 },
      { name: 'Golgi body', ax: 60, ay: 38, side: 'r', ly: 42 },
    ],
  },
  atom: {
    title: 'Structure of an atom (Bohr model)',
    shapes: [
      circle(50, 35, 8, { color: 'red', fill: 'red', sw: 1.4 }),
      circle(47.5, 33, 1.9, { color: 'red', fill: 'red', sw: 0.8 }), circle(52.5, 33, 1.9, { color: 'red', fill: 'red', sw: 0.8 }),
      circle(50, 38.5, 1.9, { color: 'blue', fill: 'blue', sw: 0.8 }), circle(46, 37, 1.9, { color: 'blue', fill: 'blue', sw: 0.8 }),
      circle(50, 35, 15, { color: 'grey', sw: 1 }), circle(50, 35, 25, { color: 'grey', sw: 1 }),
      circle(50, 20, 2, { color: 'blue', fill: 'blue', sw: 1 }), circle(50, 50, 2, { color: 'blue', fill: 'blue', sw: 1 }),
      circle(75, 35, 2, { color: 'blue', fill: 'blue', sw: 1 }), circle(25, 35, 2, { color: 'blue', fill: 'blue', sw: 1 }),
    ],
    parts: [
      { name: 'Nucleus', ax: 44.5, ay: 30, side: 'l', ly: 14 },
      { name: 'Proton (+)', ax: 52.5, ay: 33, side: 'r', ly: 14 },
      { name: 'Neutron', ax: 46, ay: 37, side: 'l', ly: 56 },
      { name: 'Electron (-)', ax: 75, ay: 35, side: 'r', ly: 56 },
      { name: 'Orbit (shell)', ax: 35, ay: 35, side: 'l', ly: 35 },
    ],
  },
  earth_layers: {
    title: 'Layers of the Earth',
    shapes: [
      circle(50, 35, 24, { color: 'brand', fill: 'brand', sw: 1.8 }),
      circle(50, 35, 22, { color: 'orange', fill: 'orange', sw: 1 }),
      circle(50, 35, 14, { color: 'red', fill: 'red', sw: 1 }),
      circle(50, 35, 7, { color: 'orange', fill: 'orange', sw: 1 }),
    ],
    parts: [
      { name: 'Crust', ax: 27.2, ay: 35, side: 'l', ly: 12 },
      { name: 'Mantle', ax: 34, ay: 23, side: 'l', ly: 24 },
      { name: 'Outer core', ax: 41, ay: 44, side: 'l', ly: 56 },
      { name: 'Inner core', ax: 52, ay: 35, side: 'r', ly: 36 },
    ],
  },
  circuit: {
    title: 'A simple electric circuit',
    shapes: [
      line(34, 54, 66, 54, { color: 'ink', sw: 1.4 }), line(66, 54, 66, 41, { color: 'ink', sw: 1.4 }), line(66, 25, 66, 16, { color: 'ink', sw: 1.4 }),
      line(66, 16, 34, 16, { color: 'ink', sw: 1.4 }), line(34, 16, 34, 24, { color: 'ink', sw: 1.4 }), line(34, 40, 34, 54, { color: 'ink', sw: 1.4 }),
      line(28, 32, 40, 32, { color: 'ink', sw: 1.2 }), line(31, 40, 37, 40, { color: 'ink', sw: 2.4 }), line(31, 24, 37, 24, { color: 'ink', sw: 1.2 }), line(34, 24, 34, 32, { color: 'ink', sw: 1.4 }),
      circle(66, 33, 8, { color: 'orange', fill: 'orange', sw: 1.4 }), line(61, 28, 71, 38, { color: 'orange', sw: 1 }), line(61, 38, 71, 28, { color: 'orange', sw: 1 }),
      line(46, 54, 54, 48, { color: 'blue', sw: 1.4 }), circle(46, 54, 1.1, { color: 'ink', fill: 'ink', sw: 1 }), circle(54, 54, 1.1, { color: 'ink', fill: 'ink', sw: 1 }),
      line(40, 12, 58, 12, { color: 'red', arrow: true, sw: 1.2 }),
    ],
    parts: [
      { name: 'Cell (battery)', ax: 34, ay: 32, side: 'l', ly: 32 },
      { name: 'Bulb', ax: 71, ay: 33, side: 'r', ly: 33 },
      { name: 'Switch', ax: 50, ay: 51, side: 'r', ly: 60 },
      { name: 'Wire', ax: 34, ay: 48, side: 'l', ly: 56 },
      { name: 'Direction of current', ax: 58, ay: 12, side: 'r', ly: 8 },
    ],
  },
};

const charW = 1.95; // average width of a label letter at size 3.4 on the 100-wide canvas

// The scene elements for one drawing, or null.
function labeled(d, str) {
  const key = String(d?.subject || '').toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '');
  const aliases = { plant: 'plant_cell', plantcell: 'plant_cell', animal: 'animal_cell', animalcell: 'animal_cell', electric_circuit: 'circuit', simple_circuit: 'circuit', earth: 'earth_layers', layers_of_the_earth: 'earth_layers', atom_structure: 'atom', bohr: 'atom' };
  const art = DRAWINGS[key] || DRAWINGS[aliases[key]];
  if (!art) return null;
  const want = Array.isArray(d.parts) && d.parts.length ? new Set(d.parts.map((p) => str(p, 30).toLowerCase())) : null;
  const parts = art.parts.filter((p) => (want ? want.has(p.name.trim().toLowerCase()) : !p.hide));
  const els = [...art.shapes];
  for (const p of parts) {
    const label = p.name.trim();
    const w = label.length * charW;
    const tx = p.side === 'l' ? 3 : 97;
    const lx = p.side === 'l' ? tx + w + 1.5 : tx - w - 1.5;
    els.push(line(lx, p.ly - 1.3, p.ax, p.ay, { color: 'grey', sw: 0.6 }));
    els.push(circle(p.ax, p.ay, 0.7, { color: 'grey', fill: 'grey', sw: 0.5 }));
    els.push(E('text', { x: tx, y: p.ly, text: label, size: 3.4, anchor: p.side === 'l' ? 'start' : 'end', bold: true }));
  }
  return { title: art.title, shapes: els, subjects: Object.keys(DRAWINGS) };
}

module.exports = { labeled, SUBJECTS: Object.keys(DRAWINGS) };
