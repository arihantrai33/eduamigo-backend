// Starting points for a school's roles (guide: "role catalogue"). A template is a suggestion, not a job title: choosing one copies its
// permissions and scopes into a new role of that school, which the school can then change. Only permissions that exist in
// config/permissions.js and modules that exist in the product are used; roles whose module is not built yet (counsellor, nurse,
// inventory) are not offered.
//
// scopes: students (the student directory), academic (attendance, results, marks, report cards, study material of a class),
//         leaves (student leave requests), notes (study material uploaded by staff). school | assigned | own.
const T = (key, name, description, permissions, scopes = {}) => ({ key, name, description, permissions, scopes });
const SCHOOL = { students: 'school', academic: 'school', leaves: 'school' };

const ROLE_TEMPLATES = [
  T('owner', 'School owner / management', 'Reads reports and results across the school. Does not run day-to-day operations or change records.',
    ['students.read', 'teachers.read', 'parents.read', 'attendance.reports', 'results.read', 'fees.read', 'audit.read', 'assistant.insights'], SCHOOL),
  T('principal', 'Principal', 'Academic oversight, reports and approvals of leave. No fee collection, payroll or school settings.',
    ['students.read', 'teachers.read', 'parents.read', 'attendance.reports', 'results.read', 'exams.manage', 'timetable.manage', 'fees.read',
      'leaves.review', 'leaves.all', 'communication.manage', 'chat.directory', 'audit.read', 'assistant.insights'], SCHOOL),
  T('vice_principal', 'Vice principal', 'Delegated academic oversight. Not inherited from the principal: only what is listed here.',
    ['students.read', 'teachers.read', 'attendance.reports', 'results.read', 'timetable.manage', 'leaves.review', 'communication.manage', 'chat.directory'], SCHOOL),
  T('office_manager', 'Office manager', 'Admissions, student and parent records, notices and bulk uploads. No fees, payroll or settings.',
    ['students.read', 'students.manage', 'parents.read', 'parents.manage', 'teachers.read', 'admissions.manage', 'communication.manage', 'bulk.manage'], SCHOOL),
  T('receptionist', 'Receptionist / front desk', 'Admission enquiries and applications. No financial or academic records.',
    ['students.read', 'parents.read', 'admissions.manage'], { students: 'school' }),
  T('admission_officer', 'Admission officer', 'The admission pipeline and the student record it creates.',
    ['students.read', 'students.manage', 'parents.read', 'parents.manage', 'admissions.manage'], { students: 'school' }),
  T('fee_collector', 'Fee collector / cashier', 'Finds a student and records a payment. Cannot change fee structures.',
    ['students.read', 'fees.read', 'fees.collect'], { students: 'school' }),
  T('academic_coordinator', 'Academic coordinator / HOD', 'Timetable and exams for the classes assigned to the person; results of those classes.',
    ['students.read', 'teachers.read', 'attendance.reports', 'results.read', 'exams.manage', 'timetable.manage', 'notes.upload'], { students: 'assigned', academic: 'assigned', notes: 'own' }),
  T('exam_controller', 'Examination controller', 'Exam schedule and results across the school. Does not enter marks.',
    ['students.read', 'results.read', 'exams.manage'], { students: 'school', academic: 'school' }),
  T('class_teacher', 'Class teacher (extra duties)', 'Add to a teacher: class-level attendance reports and leave decisions for their classes.',
    ['attendance.reports', 'leaves.review'], { academic: 'assigned', leaves: 'assigned' }),
  T('librarian', 'Librarian', 'The library catalogue and circulation only.', ['library.manage']),
  T('transport_manager', 'Transport manager', 'Buses, routes, stops and student assignment to buses.', ['transport.manage']),
  T('hr_officer', 'HR / payroll officer', 'Staff records, salaries and staff leave. No student records.', ['teachers.read', 'teachers.manage', 'hr.manage']),
  T('sports_coordinator', 'Sports / activities coordinator', 'The school calendar and notices for events.', ['communication.manage']),
];

// Families that a scope can be set for, and what they cover, for the role editor.
const SCOPE_FAMILIES = {
  students: 'Student directory (names, classes, parents)',
  academic: 'Attendance, results, marks, report cards and class study material',
  leaves: 'Student leave requests',
  notes: 'Study material uploaded by staff',
};

module.exports = { ROLE_TEMPLATES, SCOPE_FAMILIES };
