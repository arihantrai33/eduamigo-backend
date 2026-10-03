// Product catalogue: which modules exist, which are part of every plan, and the default plans.
//
// A school's features = its plan's features + bought add-ons + per-school overrides (see
// services/subscription.js). Routes check a feature with requireFeature(); the API returns the
// feature list at login so the apps only show what the school has bought.
//
// Plans and prices live in the database (Plan and AddOn, edited from the platform API).
// DEFAULT_PLANS is used until a plan is saved there, so a fresh install works out of the box.

const FEATURES = {
  fees:            { name: 'Fees & Billing',           description: 'Fee structures, collection, receipts and reminders' },
  online_payments: { name: 'Online Fee Payments',      description: 'Parents pay fees online into the school\'s Razorpay account', requires: ['fees'] },
  exams:           { name: 'Exams & Report Cards',     description: 'Exam schedule, marks entry, results and report cards' },
  admissions:      { name: 'Admissions',               description: 'Enquiry to admission pipeline' },
  hr:              { name: 'HR & Payroll',             description: 'Staff salaries and staff leave' },
  transport:       { name: 'Transport & Live Bus',     description: 'Buses, routes and live bus tracking for parents' },
  library:         { name: 'Library',                  description: 'Library catalogue' },
  chat:            { name: 'Parent-Teacher Chat',      description: 'Messaging between parents, students and staff' },
  ai_revision:     { name: 'AI Revision Assistant',    description: 'Students revise from their class notes with AI' },
};

// Always included, in every plan. Listed for the apps and documentation; never gated.
const CORE_MODULES = [
  'Students, teachers and parents', 'Classes and sections', 'Attendance', 'Timetable',
  'Notice board, notifications and calendar', 'Leave requests', 'Study material', 'Bulk upload and promotion',
];

const FEATURE_KEYS = Object.keys(FEATURES);

// Limits: null means unlimited.
//   maxStudents          - active students the school can have
//   aiQuestionsPerMonth  - AI revision questions per school per calendar month
const DEFAULT_PLANS = [
  {
    code: 'basic', name: 'Basic', sortOrder: 1,
    description: 'Core school management: students, attendance, timetable and communication',
    features: [],
    limits: { maxStudents: null, aiQuestionsPerMonth: 0 },
    pricePerStudentYear: null,
  },
  {
    code: 'standard', name: 'Standard', sortOrder: 2,
    description: 'Core plus fees, exams, admissions and chat',
    features: ['fees', 'exams', 'admissions', 'chat'],
    limits: { maxStudents: null, aiQuestionsPerMonth: 0 },
    pricePerStudentYear: null,
  },
  {
    code: 'premium', name: 'Premium', sortOrder: 3,
    description: 'Everything, including online payments, transport, HR and the AI assistant',
    features: FEATURE_KEYS,
    limits: { maxStudents: null, aiQuestionsPerMonth: 5000 },
    pricePerStudentYear: null,
  },
];

// Which feature a permission belongs to. Permissions of features a school does not have are
// removed from the permission list returned to the apps, so menus for them stay hidden.
const PERMISSION_FEATURE = {
  'fees.read': 'fees', 'fees.collect': 'fees', 'fees.structure': 'fees',
  'exams.manage': 'exams', 'marks.enter': 'exams', 'results.read': 'exams',
  'admissions.manage': 'admissions',
  'hr.manage': 'hr',
  'transport.manage': 'transport',
  'library.manage': 'library',
  'chat.directory': 'chat',
};

const SUBSCRIPTION_STATUSES = ['trial', 'active', 'read_only', 'suspended'];
const DEFAULT_TRIAL_DAYS = 30;
const DEFAULT_GRACE_DAYS = 7;

module.exports = {
  FEATURES, FEATURE_KEYS, CORE_MODULES, DEFAULT_PLANS, PERMISSION_FEATURE,
  SUBSCRIPTION_STATUSES, DEFAULT_TRIAL_DAYS, DEFAULT_GRACE_DAYS,
};
