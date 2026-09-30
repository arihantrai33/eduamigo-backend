// Single grading scale used by marks, results and reports.
function percentage(obtained, max) {
  if (!(max > 0)) return 0;
  return Math.round((obtained / max) * 1000) / 10;
}

function gradeFor(pct) {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 60) return 'C';
  if (pct >= 50) return 'D';
  if (pct >= 33) return 'E';
  return 'F';
}

module.exports = { percentage, gradeFor };
