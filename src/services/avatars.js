// Profile photos of people who are not students. A person's own photo (User.avatarKey) wins over any older one on their
// profile record, so what they upload shows in every list, chat and ID card. Students keep their photo on the student record.
const User = require('../models/User');
const photos = require('./photos');

// userIds -> Map(userId string -> private link)
async function linksFor(userIds, schoolId) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids }, school: schoolId, avatarKey: { $ne: null } }).select('avatarKey').lean();
  return new Map(users.map((u) => [String(u._id), photos.linkFor(u.avatarKey)]));
}

// Plain objects with `photo` set to the person's own photo when they have one. `userIdOf(doc)` says whose photo it is.
async function withPhotos(docs, userIdOf, schoolId) {
  const list = (Array.isArray(docs) ? docs : [docs]).map((d) => (d && d.toObject ? d.toObject() : d));
  const links = await linksFor(list.map(userIdOf), schoolId);
  const out = list.map((d) => {
    const link = d && links.get(String(userIdOf(d)));
    return link ? { ...d, photo: link } : d;
  });
  return Array.isArray(docs) ? out : out[0];
}

module.exports = { linksFor, withPhotos };
