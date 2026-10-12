// Push notifications to the EduAmigo mobile apps through Firebase Cloud Messaging.
// Every in-app notification is also pushed to the recipient's registered devices. Nothing is sent when Firebase is not
// configured (FIREBASE_SERVICE_ACCOUNT, or src/config/serviceAccountKey.json) or PUSH_DISABLED=true; the in-app
// notification is always saved first, and a failed push never fails the request that caused it.
const User = require('../models/User');
const { log, errorFields } = require('../utils/logger');

const MAX_DEVICES = 5;
const BATCH = 500; // FCM multicast limit
const DEAD_TOKEN = /registration-token-not-registered|invalid-registration-token|invalid-argument/;

let messagingOverride; // tests
const setMessaging = (m) => { messagingOverride = m; };

function messaging() {
  if (messagingOverride !== undefined) return messagingOverride;
  // Automated tests never reach Firebase; they install a fake with setMessaging.
  if (process.env.PUSH_DISABLED === 'true' || process.env.NODE_ENV === 'test') return null;
  try {
    return require('../config/firebase').admin.messaging();
  } catch {
    return null; // not configured on this server
  }
}

// Devices still signed in: registered after the user's last "sign out everywhere" / password change.
const liveTokens = (user) => (user.devices || []).filter((d) => d.v === (user.tokenVersion || 0)).map((d) => d.token);

async function sendToUsers(school, filter, { title, body, data = {} }) {
  const m = messaging();
  if (!m) return { sent: 0, skipped: 'not configured' };
  const users = await User.find({ ...filter, school, isActive: true, 'devices.0': { $exists: true } })
    .select('devices tokenVersion').lean();
  const tokens = [...new Set(users.flatMap(liveTokens))];
  let sent = 0;
  const dead = [];
  for (let i = 0; i < tokens.length; i += BATCH) {
    const chunk = tokens.slice(i, i + BATCH);
    const res = await m.sendEachForMulticast({
      tokens: chunk,
      notification: { title: String(title).slice(0, 120), body: String(body || '').slice(0, 300) },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high' },
    });
    sent += res.successCount;
    res.responses.forEach((r, j) => { if (!r.success && DEAD_TOKEN.test(r.error?.code || '')) dead.push(chunk[j]); });
  }
  if (dead.length) await User.updateMany({ school, 'devices.token': { $in: dead } }, { $pull: { devices: { token: { $in: dead } } } });
  return { sent, removed: dead.length };
}

// Fire and forget: the caller has already saved the in-app notification.
function pushSoon(school, filter, payload) {
  sendToUsers(school, filter, payload).catch((err) => log.warn('push_failed', errorFields(err)));
}

const toUser = (school, userId, payload) => pushSoon(school, { _id: userId }, payload);
const toRole = (school, role, payload) => pushSoon(school, role === 'all' ? {} : { role }, payload);

// Called when the app signs in on a device. A device belongs to one person at a time: when someone else signs in on
// a shared phone, the previous person stops receiving pushes there.
async function registerDevice(user, schoolId, token, platform = '') {
  const t = String(token || '').trim();
  if (!t || t.length > 4096) return false;
  await User.updateMany({ _id: { $ne: user._id }, 'devices.token': t }, { $pull: { devices: { token: t } } })
    .setOptions({ crossTenant: 'a device token may move to a person in another school on a shared phone' });
  const entry = { token: t, platform: String(platform).slice(0, 20), v: user.tokenVersion || 0, updatedAt: new Date() };
  await User.updateOne({ _id: user._id, school: schoolId }, { $pull: { devices: { token: t } } });
  await User.updateOne({ _id: user._id, school: schoolId }, { $push: { devices: { $each: [entry], $sort: { updatedAt: -1 }, $slice: MAX_DEVICES } } });
  return true;
}

async function unregisterDevice(user, schoolId, token) {
  await User.updateOne({ _id: user._id, school: schoolId }, { $pull: { devices: { token: String(token || '') } } });
}

module.exports = { sendToUsers, toUser, toRole, registerDevice, unregisterDevice, setMessaging, liveTokens, MAX_DEVICES };
