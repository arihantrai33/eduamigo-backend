// One list of exam types and terms for the whole platform. The frontend reads it from
// GET /api/exams/options so the two can never drift apart.
const EXAM_TYPES = [
  'Unit Test', 'Mid Term', 'Half Yearly', 'Pre-Board', 'Final Exam', 'Board Exam',
  'Practical', 'Quiz', 'Assignment', 'Custom',
];

// Indian schools report results in two terms: Term 1 runs April to September, Term 2 October to March.
const TERMS = ['Term 1', 'Term 2'];

// Older records used shorter names; they are mapped on read and by the migration.
const LEGACY_TYPES = { Final: 'Final Exam' };

function normalizeExamType(value) {
  const v = LEGACY_TYPES[value] || value;
  return EXAM_TYPES.includes(v) ? v : 'Custom';
}

function termForDate(date) {
  const month = new Date(date).getUTCMonth(); // 0 = January
  return month >= 3 && month <= 8 ? 'Term 1' : 'Term 2';
}

module.exports = { EXAM_TYPES, TERMS, normalizeExamType, termForDate };
