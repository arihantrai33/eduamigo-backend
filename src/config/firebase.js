const admin = require('firebase-admin');

// Server-side Firebase access (bus tracking). Credentials come from either
//   FIREBASE_SERVICE_ACCOUNT  - the service account JSON as one environment variable (recommended on Render), or
//   src/config/serviceAccountKey.json - a local file (git-ignored).
function credentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // eslint-disable-next-line global-require
  return require('./serviceAccountKey.json');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(credentials()),
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://eduamigo-375c7-default-rtdb.asia-southeast1.firebasedatabase.app',
  });
}

const db = admin.database();
module.exports = { admin, db };
