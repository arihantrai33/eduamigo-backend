/* eslint-disable no-console */
// Onboard a new school: creates the School and its first admin account.
//
//   npm run create-school -- --name "Green Valley Public School" --admin-name "Priya Sharma" \
//     --admin-email principal@greenvalley.edu.in [--code GVPS] [--city Jaipur] [--phone 9876543210] \
//     [--address "..."] [--plan standard] [--trial-days 30]
//
// Prints the school code and a temporary password for the admin (they must change it on first login).
// The same can be done from the platform API (POST /api/platform/schools).

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { onboardSchool } = require('../services/schoolOnboarding');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// Kept for older callers: { name, adminName, adminEmail, phone, address, email }
const createSchool = (input) => onboardSchool(input);

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const { school, admin, password } = await onboardSchool({
      name: arg('name'), adminName: arg('admin-name'), adminEmail: arg('admin-email'), code: arg('code'),
      city: arg('city'), phone: arg('phone'), address: arg('address'), plan: arg('plan'),
      trialDays: arg('trial-days'),
    });
    console.log('\nSchool created');
    console.log(`  School:   ${school.name} (${school._id})`);
    console.log(`  Code:     ${school.code}`);
    console.log(`  Plan:     ${school.subscription.plan} (${school.subscription.status})`);
    console.log(`  Admin:    ${admin.name} <${admin.email}>`);
    console.log(`  Password: ${password}   (temporary, must be changed on first login)\n`);
    await mongoose.disconnect();
  })().catch(async (err) => {
    console.error('Failed:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  });
}

module.exports = { createSchool };
