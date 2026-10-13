// A short, honest reliability note for a tutor answer, built only from evidence the server has: which school passages the
// answer actually cited, whether the school's material was searched at all, and the results of the independent calculation
// checks. The model's own claim of being sure is never used. There is no percentage: no calibration has been done that
// would make a number meaningful.
//
//   needs_verification  a calculation did not check out
//   high                the answer cites the school's material, or its final calculation was checked
//   moderate            a standard explanation without school material (and why: not covered, or not searched)
//   null                nothing to rate (a clarifying question, a greeting, a refusal)

function rate({ usedPassages = [], materialsChecked = false, materialsError = null, checks = [], clarifying = false, studentContext = true }) {
  if (clarifying) return null;
  const failed = checks.filter((c) => c.status === 'failed');
  const passed = checks.filter((c) => c.status === 'passed');
  const calcNote = passed.length
    ? (passed.some((c) => c.kind === 'equation') ? 'The final answer was checked by substitution.' : 'The calculation was checked independently.')
    : null;
  if (failed.length) {
    return { level: 'needs_verification', label: 'Needs verification', reason: 'A calculation in this answer did not check out. Please work through the steps again or ask your teacher.' };
  }
  if (usedPassages.length) {
    const titles = [...new Set(usedPassages.map((p) => p.title))].slice(0, 2).join(' and ');
    return { level: 'high', label: 'High confidence', reason: [`Consistent with your school material: ${titles}.`, calcNote].filter(Boolean).join(' ') };
  }
  if (passed.length) {
    return { level: 'high', label: 'High confidence', reason: `${calcNote} This checks the calculation, not every statement in the explanation.` };
  }
  const why = !studentContext
    ? 'A standard explanation; school material is only searched for students.'
    : materialsChecked
      ? 'A standard explanation; your school notes do not cover this topic.'
      : `A standard explanation; your school notes could not be searched${materialsError ? ' just now' : ''}.`;
  return { level: 'moderate', label: 'Moderate confidence', reason: why };
}

// The passages the answer cited with [S1]-style markers. A passage that was found but not cited is not claimed as a source.
function citedPassages(text, passages) {
  const refs = new Set([...String(text || '').matchAll(/\[S(\d{1,2})\]/g)].map((m) => `S${m[1]}`));
  return passages.filter((p) => refs.has(p.ref));
}

module.exports = { rate, citedPassages };
