// Single source of truth for "who can do what" in a school.
// Routes check a permission (requirePermission), never a hard-coded role list, so a new
// staff role (for example an accountant) is a change here, not across every route file.
//
// Row-level rules still apply inside controllers:
//   - teachers only see and act on their assigned classes,
//   - students only see themselves, parents only their linked children,
//   - every query is limited to the user's own school.
// See docs/ACCESS_CONTROL.md for the human-readable matrix.

const PERMISSIONS = {
  'students.read':        'View student records',
  'students.manage':      'Add, edit and deactivate students',
  'teachers.read':        'View teacher records',
  'teachers.manage':      'Add, edit and deactivate teachers, assign classes',
  'parents.read':         'View parent records',
  'parents.manage':       'Add parents and link children',
  'admissions.manage':    'Record enquiries, process applications and admit new students',
  'users.manage':         'Create logins, reset passwords, activate or deactivate accounts',
  'attendance.mark':      'Mark student attendance',
  'attendance.reports':   'School-wide attendance dashboards and reports',
  'marks.enter':          'Enter and publish marks for own classes',
  'results.read':         'View published results',
  'exams.manage':         'Manage the exam schedule',
  'timetable.manage':     'Create and edit timetables',
  'fees.read':            'View fee records and summaries',
  'fees.collect':         'Record fee payments and issue receipts',
  'fees.structure':       'Create fee structures and bill students',
  'hr.manage':            'Salaries and staff leave',
  'leaves.review':        'Review leave requests',
  'leaves.all':           'View and delete every leave request in the school',
  'communication.manage': 'Announcements, notifications and calendar events',
  'transport.manage':     'Buses, routes, stops and student assignment',
  'library.manage':       'Library catalogue',
  'bulk.manage':          'Bulk uploads, bulk attendance and class promotion',
  'notes.upload':         'Upload study material',
  'settings.manage':      'School settings such as subjects',
  'academics.manage':     'Academic sessions, classes, sections, subjects and class teachers',
  'chat.directory':       'Message anyone in the school from one inbox',
  'audit.read':           'See the school activity log (who changed marks, fees, students, settings)',
  'assistant.knowledge':  'EduAmigo Ask: add, update and remove the school documents it answers from',
  'assistant.insights':   'EduAmigo Ask: routing accuracy and resolution metrics, and every hand-off ticket in the school',
  'roles.view':           'See the school\'s roles, what each allows, and who holds them',
  'roles.manage':         'Create and change roles and give them to staff (only permissions you hold yourself)',
};

const ALL = Object.keys(PERMISSIONS);

const ROLE_PERMISSIONS = {
  admin: ALL,
  accountant: [
    'students.read', 'parents.read',
    'fees.read', 'fees.collect', 'fees.structure',
  ],
  teacher: [
    'students.read', 'teachers.read',
    'attendance.mark', 'marks.enter', 'results.read',
    'leaves.review', 'notes.upload',
  ],
  // Non-teaching staff (librarian, receptionist, principal, ...): no permission of their own, only what the roles assigned to them give.
  staff: [],
  student: [],
  parent: [],
  driver: [],
};

// Data scope of each role, per family of records, once it holds the permission:
//   school    every record of the school
//   assigned  only the classes, sections and subjects assigned to the person (a teacher profile)
//   own       only records the person created
// Anything not listed is 'none': a role with a permission but no scope for that data reaches nothing (fail closed), so a new role can
// never become unrestricted by omission. Families: students (the student directory), academic (attendance, results, report cards, marks,
// study material for a class), leaves (student leave requests), notes (study material uploaded by staff).
const ROLE_SCOPE = {
  admin:      { students: 'school', academic: 'school', leaves: 'school', notes: 'school' },
  accountant: { students: 'school' },
  teacher:    { students: 'assigned', academic: 'assigned', leaves: 'assigned', notes: 'own' },
};

// Roles that use the staff (admin) portal.
const STAFF_PORTAL_ROLES = ['admin', 'accountant', 'staff'];
// Roles an administrator may create directly from User Management. Students, parents and
// teachers are created from their own screens so the school record is created with the login.
const ASSIGNABLE_ROLES = ['admin', 'accountant', 'staff'];

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function hasPermission(role, permission) {
  return permissionsFor(role).includes(permission);
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, ROLE_SCOPE, STAFF_PORTAL_ROLES, ASSIGNABLE_ROLES, permissionsFor, hasPermission };
