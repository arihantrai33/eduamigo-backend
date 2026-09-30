// One canonical representation for classes and sections across the platform.
//   Student:  { class: "10", section: "A" }
//   Teacher.assignedClasses: ["10-A", "9-B"]   (class-section keys)
//   Notes / embeddings: { class: "10", section: "A" }  or section "" = all sections
//
// Everything that accepts user input for a class goes through these helpers so
// "Class 10", "10", " 10 " and "10-a" all resolve to the same values.

function normalizeClass(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/^class\s+/i, '').trim();
}

function normalizeSection(value) {
  if (value === undefined || value === null) return '';
  const s = String(value).trim().toUpperCase();
  return s === 'ALL' ? '' : s;
}

// Accepts "10-A", "10 - A", "Class 10-A", or separate class/section values.
function parseClassKey(classValue, sectionValue) {
  const raw = normalizeClass(classValue);
  const dash = raw.indexOf('-');
  if (dash !== -1) {
    return {
      class: raw.slice(0, dash).trim(),
      section: normalizeSection(raw.slice(dash + 1)),
    };
  }
  return { class: raw, section: normalizeSection(sectionValue) };
}

function classKey(cls, section) {
  const c = normalizeClass(cls);
  const s = normalizeSection(section);
  return s ? `${c}-${s}` : c;
}

// True when a teacher's assignedClasses cover the given class/section.
// "10" (no section) in assignedClasses means the whole class.
function teacherCoversClass(teacher, cls, section) {
  if (!teacher) return false;
  const c = normalizeClass(cls);
  const s = normalizeSection(section);
  return (teacher.assignedClasses || []).some((entry) => {
    const parsed = parseClassKey(entry);
    if (parsed.class !== c) return false;
    return !parsed.section || !s || parsed.section === s;
  });
}

module.exports = { normalizeClass, normalizeSection, parseClassKey, classKey, teacherCoversClass };
