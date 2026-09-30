/* eslint-disable no-console */
// Onboard a new school: creates the School and its first admin account.
//
//   npm run create-school -- --name "Green Valley Public School" --admin-name "Priya Sharma" \
//     --admin-email principal@greenvalley.edu.in [--phone 9876543210] [--address "..."]
//
// Prints a temporary password for the admin (they must change it on first login).

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const School = require('../models/School');
const User = require('../models/User');
const { temporaryPassword, hashPassword } = require('../services/credentials');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function createSchool({ name, adminName, adminEmail, phone, address, email }) {
  if (!name || !adminName || !adminEmail) throw new Error('--name, --admin-name and --admin-email are required');
  const normalizedEmail = adminEmail.trim().toLowerCase();
  if (await User.exists({ email: normalizedEmail })) throw new Error(`A user with email ${normalizedEmail} already exists`);

  const school = await School.create({ name: name.trim(), phone: phone || '', address: address || '', email: email || normalizedEmail });
  const password = temporaryPassword();
  const admin = await User.create({
    name: adminName.trim(), email: normalizedEmail, role: 'admin', school: school._id, phone: phone || null,
    password: await hashPassword(password), mustChangePassword: true,
  });
  return { school, admin, password };
}

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const { school, admin, password } = await createSchool({
      name: arg('name'), adminName: arg('admin-name'), adminEmail: arg('admin-email'),
      phone: arg('phone'), address: arg('address'),
    });
    console.log('\nSchool created');
    console.log(`  School:   ${school.name} (${school._id})`);
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
