// Pure checks behind the AI Tutor: the calculation checker, diagram validation, the reliability note and practice-key validation.
const { evaluate, sameNumber, runCheck, extractChecks } = require('../src/learning/mathcheck');
const { validate, extractDiagrams } = require('../src/learning/diagram');
const { rate, citedPassages } = require('../src/learning/confidence');
const { cleanQuestion } = require('../src/learning/practice');

describe('calculation checker', () => {
  test('exact fractions, decimals, percentages, powers, roots and degrees', () => {
    expect(evaluate('3/4 + 1/8').text).toBe('7/8');
    expect(evaluate('0.1 + 0.2').text).toBe('3/10'); // exact, no floating-point error
    expect(evaluate('15% * 200').text).toBe('30');
    expect(evaluate('2^10').text).toBe('1024');
    expect(evaluate('(-2)^3').text).toBe('-8');
    expect(evaluate('sqrt(49/4)').text).toBe('7/2');
    expect(evaluate('2(3+4)').text).toBe('14'); // implicit multiplication
    expect(evaluate('6 ÷ 3 × 2').text).toBe('4');
    expect(Number(evaluate('sin(30)').text)).toBeCloseTo(0.5, 9);
  });

  test('equivalent answers are the same number; different ones are not; nonsense is "unknown"', () => {
    expect(sameNumber('3/4', '0.75')).toBe(true);
    expect(sameNumber('75%', '6/8')).toBe(true);
    expect(sameNumber('1.41', 'sqrt(2)')).toBe(true); // rounded to the digits given
    expect(sameNumber('1.5', 'sqrt(2)')).toBe(false);
    expect(sameNumber('2', '3')).toBe(false);
    expect(sameNumber('two', '2')).toBeNull();
  });

  test('checks: passed, failed with the reason, or unsupported (never "passed" by default)', () => {
    expect(runCheck({ type: 'equation', equation: 'x^2 - 5x + 6 = 0', variable: 'x', answer: 'x = 2, x = 3' }).status).toBe('passed');
    expect(runCheck({ type: 'equation', equation: '2x + 3 = 11', variable: 'x', answer: '5' })).toMatchObject({ status: 'failed', detail: 'x = 5 gives 13 on the left and 11 on the right' });
    expect(runCheck({ type: 'value', expr: '12 * 12', answer: '144' }).status).toBe('passed');
    for (const bad of [
      { type: 'value', expr: 'process.exit(1)', answer: '1' },
      { type: 'value', expr: 'constructor', answer: '1' },
      { type: 'value', expr: '1/0', answer: '1' },
      { type: 'value', expr: '9^999999', answer: '1' },
      { type: 'value', expr: `${'('.repeat(200)}1${')'.repeat(200)}`, answer: '1' },
      { type: 'equation', equation: 'x = 1 = 2', variable: 'x', answer: '1' },
      { type: 'nonsense' },
      null,
    ]) expect(runCheck(bad).status).toBe('unsupported');
  });

  test('check blocks are taken out of the text shown to the student', () => {
    const out = extractChecks('x = 4\n```check\n{"type":"value","expr":"8/2","answer":"4"}\nnot json\n```\nDone.');
    expect(out.text).toBe('x = 4\n\nDone.');
    expect(out.checks).toEqual([{ type: 'value', expr: '8/2', answer: '4' }, { type: 'invalid', raw: 'not json' }]);
  });
});

describe('drawings: scene and lens', () => {
  test('a lens ray diagram is worked out from the lens formula, not taken from the model', () => {
    const real = validate({ type: 'lens', kind: 'convex', u: 20, f: 15, unit: 'cm' });
    expect(real.type).toBe('scene');
    expect(real.caption).toMatch(/image at 60 cm on the other side; real, inverted, magnified \(magnification -3\)/);
    expect(validate({ type: 'lens', kind: 'convex', u: 10, f: 15 }).caption).toMatch(/image at 30 cm on the same side as the object; virtual, upright, magnified/);
    expect(validate({ type: 'lens', kind: 'concave', u: 20, f: 15 }).caption).toMatch(/image at 8\.57 cm.*virtual, upright, diminished/);
    expect(validate({ type: 'lens', kind: 'convex', u: 15, f: 15 })).toBeNull(); // image at infinity
    expect(validate({ type: 'lens', u: -3, f: 15 })).toBeNull();
    expect(real.elements.every((e) => ['line', 'curve', 'circle', 'text'].includes(e.t))).toBe(true);
    expect(real.alt).toContain('Convex lens');
  });

  test('ready-made labelled drawings: the model only picks the subject; unknown subjects and part names are handled', () => {
    for (const subject of ['plant_cell', 'animal_cell', 'atom', 'earth_layers', 'circuit']) {
      const d = validate({ type: 'labeled', subject });
      expect(d.type).toBe('scene');
      expect(d.elements.filter((e) => e.t === 'text').length).toBeGreaterThanOrEqual(4);
    }
    const plant = validate({ type: 'labeled', subject: 'Plant cell' });
    expect(plant.elements.filter((e) => e.t === 'text').map((e) => e.text)).toEqual(['Nucleus', 'Cytoplasm', 'Cell membrane', 'Chloroplast', 'Cell wall', 'Large vacuole', 'Mitochondrion']);
    const some = validate({ type: 'labeled', subject: 'plant_cell', parts: ['nucleus', 'Large vacuole', 'Ghost part'] });
    expect(some.elements.filter((e) => e.t === 'text').map((e) => e.text)).toEqual(['Nucleus', 'Large vacuole']);
    expect(validate({ type: 'labeled', subject: 'dinosaur' })).toBeNull();
  });

  test('a scene keeps only known shapes, colour names and coordinates inside the canvas', () => {
    const d = validate({ type: 'scene', title: 'Cell', h: 500, elements: [
      { t: 'rect', x: 10, y: 5, w: 80, h: 40, r: 6, color: 'green', fill: true },
      { t: 'text', x: 50, y: 25, text: '<script>Nucleus</script>', color: 'purple' },
      { t: 'circle', cx: 1e9, cy: 20, r: 3 },
      { t: 'html', x: 1 }, { t: 'line', x1: 'a', y1: 0, x2: 1, y2: 1 }, { t: 'line', x1: 0, y1: 0, x2: 5, y2: 5, arrow: true },
    ] });
    expect(d.h).toBe(80);
    expect(d.elements.map((e) => e.t)).toEqual(['rect', 'text', 'circle', 'line']);
    expect(d.elements[0]).toMatchObject({ color: 'green', fill: 'green', w: 80 });
    expect(d.elements[1].text).not.toMatch(/[<>]/);
    expect(d.elements[1].color).toBe('ink');
    expect(d.elements[2].cx).toBe(105);
    expect(validate({ type: 'scene', elements: [{ t: 'line', x1: 0, y1: 0, x2: 1, y2: 1 }] })).toBeNull(); // too little to be a drawing
  });
});

describe('diagram validation', () => {
  test('known shapes are cleaned and described; anything else is dropped', () => {
    expect(validate({ type: 'numberline', min: -5, max: 5, points: [{ value: 2, label: 'A' }, { value: 99 }] })).toMatchObject({ points: [{ value: 2, label: 'A' }], alt: expect.stringContaining('A at 2') });
    expect(validate({ type: 'bar', labels: ['Jan', 'Feb'], values: [1, 'x'] })).toBeNull();
    expect(validate({ type: 'cycle', steps: ['Evaporation', 'Condensation', 'Precipitation'] }).alt).toMatch(/back to Evaporation/);
    expect(validate({ type: 'graph', expr: 'alert(1)', xMin: 0, xMax: 1 })).toBeNull();
    expect(validate({ type: 'graph', expr: '1/x', xMin: -2, xMax: 2 }).points.length).toBeGreaterThan(50); // the gap at 0 is skipped
    expect(validate({ type: 'html', html: '<b>x</b>' })).toBeNull();
    const t = validate({ type: 'table', headers: ['A<script>', 'B'], rows: [['1', '2', '3']] });
    expect(t.headers[0]).toBe('Ascript');
    expect(t.rows).toEqual([['1', '2']]);
  });

  test('at most three diagrams; invalid blocks are counted and removed', () => {
    const block = '```diagram\n{"type":"flow","steps":["a","b"]}\n```';
    const out = extractDiagrams(`${block}\n${block}\n${block}\n${block}\n\`\`\`diagram\nnot json\n\`\`\``);
    expect(out.diagrams).toHaveLength(3);
    expect(out.dropped).toBe(2);
  });
});

describe('reliability note', () => {
  const p = { ref: 'S1', title: 'Chapter 6' };
  test('evidence decides the level, never the model', () => {
    expect(rate({ usedPassages: [p], materialsChecked: true })).toMatchObject({ level: 'high' });
    expect(rate({ materialsChecked: true }).reason).toMatch(/do not cover/);
    expect(rate({ materialsChecked: false, materialsError: 'down' }).reason).toMatch(/could not be searched just now/);
    expect(rate({ usedPassages: [p], checks: [{ status: 'failed' }] }).level).toBe('needs_verification');
    expect(rate({ checks: [{ status: 'passed', kind: 'value' }] }).reason).toMatch(/not every statement/);
    expect(rate({ clarifying: true })).toBeNull();
    expect(JSON.stringify(rate({ usedPassages: [p] }))).not.toMatch(/%|\d\d/);
  });
  test('only cited passages count as sources', () => {
    expect(citedPassages('as in [S2]', [p, { ref: 'S2', title: 'B' }])).toEqual([{ ref: 'S2', title: 'B' }]);
    expect(citedPassages('no citation', [p])).toEqual([]);
  });
});

describe('practice answer keys', () => {
  test('a key must be an option, a calculation must check out, a numeric key needs a check', () => {
    expect(cleanQuestion({ format: 'mcq', prompt: 'Pick the even one', options: ['1', '2', '3', '5'], answer: 'B' }).q.answer).toBe('2');
    expect(cleanQuestion({ format: 'mcq', prompt: 'Pick the even one', options: ['1', '1', '3', '5'], answer: '1' }).error).toMatch(/4 different/);
    expect(cleanQuestion({ format: 'numeric', prompt: 'What is 7 x 8?', answer: '54', check: { type: 'value', expr: '7*8', answer: '54' } }).error).toMatch(/failed its check/);
    expect(cleanQuestion({ format: 'numeric', prompt: 'What is 7 x 8?', answer: '56' }).error).toMatch(/could not be checked/);
    expect(cleanQuestion({ format: 'short', prompt: 'Define a noun.', answer: 'A naming word.' }).error).toMatch(/marking points/);
  });
});

describe('clarifying questions versus answers that end with a question', () => {
  const { finish } = require('../src/learning/tutor');
  const base = { passages: [], materialsChecked: true, studentContext: true };
  test('a short question back gets no reliability note; an explanation ending in a check question does', () => {
    expect(finish('Which chapter do you mean?', base).confidence).toBeNull();
    const answer = 'Gravity is the force that pulls objects towards each other. The Earth pulls everything towards its centre, which is why things fall down.\n\nCan you think of one example of gravity at home?';
    expect(finish(answer, base).confidence).toMatchObject({ level: 'moderate' });
  });
});
