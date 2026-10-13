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
