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
  student: [],
  parent: [],
  driver: [],
};

// Roles that use the staff (admin) portal.
const STAFF_PORTAL_ROLES = ['admin', 'accountant'];
// Roles an administrator may create directly from User Management. Students, parents and
// teachers are created from their own screens so the school record is created with the login.
const ASSIGNABLE_ROLES = ['admin', 'accountant'];

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function hasPermission(role, permission) {
  return permissionsFor(role).includes(permission);
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, STAFF_PORTAL_ROLES, ASSIGNABLE_ROLES, permissionsFor, hasPermission };
