// What each platform (owner console) role may do. Separate from school permissions: nothing here applies to school accounts.
// A superadmin account with no platformRole set is an owner, so accounts made before roles existed keep full access.
const PLATFORM_PERMISSIONS = {
  'analytics.read': 'See the overview numbers',
  'health.read': 'See platform health',
  'schools.read': 'See schools and plans',
  'schools.manage': 'Add schools and change their profile and branding',
  'billing.read': 'See invoices and invoice previews',
  'billing.manage': 'Change plans, subscriptions and invoices',
  'support.read': 'Read support requests and announcements',
  'support.manage': 'Reply to support requests',
  'notices.manage': 'Publish announcements',
  'support.session': 'Sign in as a school administrator for support',
  'audit.read': 'Read the audit log',
  'integrations.read': 'See email and SMS settings and logs',
  'integrations.manage': 'Change and test email and SMS settings',
  'users.read': 'See the console team',
  'users.manage': 'Add people, change roles, passwords and access',
  'settings.read': 'See platform settings',
  'settings.manage': 'Change platform settings',
};
const ALL = Object.keys(PLATFORM_PERMISSIONS);
const READ = ['analytics.read', 'health.read', 'schools.read', 'billing.read', 'support.read', 'audit.read'];

const PLATFORM_ROLES = {
  owner:   { label: 'Owner', description: 'Everything, including the team, settings and integrations.', permissions: ALL },
  billing: { label: 'Billing', description: 'Schools, plans, subscriptions and invoices. Cannot reply to support or change settings.', permissions: [...READ, 'schools.manage', 'billing.manage'] },
  support: { label: 'Support', description: 'Support requests, announcements and support sign-ins. Cannot change billing or settings.', permissions: [...READ, 'support.manage', 'notices.manage', 'support.session', 'integrations.read'] },
  viewer:  { label: 'Viewer', description: 'Read only: overview, schools, invoices, support requests and the audit log.', permissions: READ },
};

const roleOf = (user) => (PLATFORM_ROLES[user?.platformRole] ? user.platformRole : 'owner');
const permissionsOf = (user) => PLATFORM_ROLES[roleOf(user)].permissions;
const can = (user, permission) => permissionsOf(user).includes(permission);

module.exports = { PLATFORM_PERMISSIONS, PLATFORM_ROLES, roleOf, permissionsOf, can };
