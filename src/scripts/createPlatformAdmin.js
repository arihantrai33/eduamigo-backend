/* eslint-disable no-console */
// Creates an EduAmigo platform owner account (role "superadmin", not linked to any school).
//
//   npm run create-platform-admin -- --name "Arihant Rai" --email you@eduamigo.in
//
// Prints a temporary password once. Sign in at POST /api/platform/login.

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const User = require('../models/User');
const { temporaryPassword, hashPassword } = require('../services/credentials');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function createPlatformAdmin({ name, email }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!name || !cleanEmail) throw new Error('--name and --email are required');
  if (await User.exists({ email: cleanEmail })) throw new Error(`A user with email ${cleanEmail} already exists`);
  const password = `${temporaryPassword()}-${temporaryPassword()}`;
  const user = await User.create({ name: name.trim(), email: cleanEmail, role: 'superadmin', school: null, password: await hashPassword(password) });
  return { user, password };
}

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const { user, password } = await createPlatformAdmin({ name: arg('name'), email: arg('email') });
    console.log('\nPlatform admin created');
    console.log(`  Name:     ${user.name} <${user.email}>`);
    console.log(`  Password: ${password}   (store it in a password manager)\n`);
    await mongoose.disconnect();
  })().catch(async (err) => {
    console.error('Failed:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  });
}

module.exports = { createPlatformAdmin };
