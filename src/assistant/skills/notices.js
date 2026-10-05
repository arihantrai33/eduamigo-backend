// Notices & events skill: Announcement (notice board) and Event (school calendar), filtered to what
// the asker's role is meant to see.
//   "last notice", "circular"           -> latest notices (pinned first)
//   "holiday", "PTM", "event", "chhutti" -> calendar; "is tomorrow a holiday?" gets a yes/no answer

const Announcement = require('../../models/Announcement');
const Event = require('../../models/Event');
const { hasPhrase } = require('../text');
const { parseWhen } = require('../entities');
const { day, today, addDays, link, source } = require('./util');

const EVENT_WORDS = ['event', 'events', 'function', 'ptm', 'parent teacher meeting', 'calendar', 'holiday', 'holidays', 'vacation', 'chhutti', 'chutti', 'school band', 'school closed', 'annual day', 'sports day'];
const HOLIDAY_WORDS = ['holiday', 'holidays', 'vacation', 'chhutti', 'chutti', 'school band', 'school closed', 'off'];

// Staff see every notice; others see notices for everyone and for their own role.
const roleFilter = (role) => (role === 'admin' || role === 'accountant' ? {} : { targetRole: { $in: ['all', role] } });
const clip = (s, n = 180) => (String(s || '').length > n ? `${String(s).slice(0, n).trim()}...` : String(s || ''));

async function notices(ctx) {
  const rows = await Announcement.find({ school: ctx.schoolId, ...roleFilter(ctx.role) }).sort({ isPinned: -1, createdAt: -1 }).limit(3).lean();
  if (!rows.length) return { text: 'There are no notices on the notice board.', facts: { notices: 0 }, sources: [], screen: 'notices' };
  const [first, ...rest] = rows;
  const lines = [`Latest notice${first.isPinned ? ' (pinned)' : ''}, ${day(first.createdAt)}: "${first.title}"`, clip(first.message)];
  if (rest.length) lines.push(`Earlier: ${rest.map((r) => `"${r.title}" (${day(r.createdAt, { short: true })})`).join(', ')}`);
  return {
    text: lines.join('\n'),
    facts: { notices: rows.map((r) => ({ title: r.title, date: day(r.createdAt), priority: r.priority, pinned: r.isPinned, message: clip(r.message) })) },
    sources: rows.map((r) => source('notice', `Notice · ${r.title}`, r._id, r)),
    screen: 'notices',
  };
}

async function events(ctx) {
  const when = parseWhen(ctx.text, { direction: 'future', now: ctx.now });
  const holidaysOnly = hasPhrase(ctx.text, HOLIDAY_WORDS);
  const base = { school: ctx.schoolId, ...(ctx.role === 'admin' ? {} : { targetRole: { $in: ['all', ctx.role] } }), ...(holidaysOnly ? { type: 'holiday' } : {}) };

  // A yes/no question about one day.
  if (when?.day) {
    const end = addDays(when.day, 1);
    const onDay = await Event.find({ ...base, date: { $lt: end }, $or: [{ endDate: { $gte: when.day } }, { endDate: null, date: { $gte: when.day } }] }).lean();
    const dayText = `${when.label === 'today' || when.label === 'tomorrow' ? `${when.label[0].toUpperCase()}${when.label.slice(1)} ` : ''}(${day(when.day, { weekday: true })})`;
    if (holidaysOnly && when.day.getUTCDay() === 0 && !onDay.length) {
      return { text: `${dayText} is a Sunday, so school is closed.`, facts: { date: day(when.day), holiday: true, reason: 'Sunday' }, sources: [], screen: 'events' };
    }
    if (!onDay.length) {
      return { text: holidaysOnly ? `${dayText} is not a holiday on the school calendar.` : `Nothing is on the school calendar for ${dayText}.`, facts: { date: day(when.day), events: 0, holiday: holidaysOnly ? false : undefined }, sources: [source('calendar', 'School calendar')], screen: 'events' };
    }
    return {
      text: `${dayText}: ${onDay.map((e) => `${e.title}${e.type === 'holiday' ? ' (holiday)' : ''}`).join(', ')}.`,
      facts: { date: day(when.day), events: onDay.map((e) => ({ title: e.title, type: e.type })) },
      sources: onDay.slice(0, 3).map((e) => source('event', `Calendar · ${e.title}`, e._id, e)),
      screen: 'events',
    };
  }

  const from = when?.from && when.from > today(ctx.now) ? when.from : today(ctx.now);
  const to = when?.to || addDays(ctx.now, 90);
  const rows = await Event.find({ ...base, date: { $gte: from, $lte: to } }).sort({ date: 1 }).limit(6).lean();
  const what = holidaysOnly ? 'holidays' : 'events';
  if (!rows.length) return { text: `No upcoming ${what} are on the school calendar${when?.label ? ` for ${when.label}` : ''}.`, facts: { [what]: 0 }, sources: [source('calendar', 'School calendar')], screen: 'events' };
  return {
    text: `Upcoming ${what}:\n${rows.map((e) => `- ${day(e.date, { weekday: true })}${e.endDate && day(e.endDate) !== day(e.date) ? ` to ${day(e.endDate, { short: true })}` : ''}: ${e.title}${!holidaysOnly && e.type !== 'event' ? ` (${e.type})` : ''}`).join('\n')}`,
    facts: { [what]: rows.map((e) => ({ title: e.title, type: e.type, date: day(e.date), endDate: e.endDate ? day(e.endDate) : null })) },
    sources: rows.slice(0, 3).map((e) => source('event', `Calendar · ${e.title}`, e._id, e)),
    screen: 'events',
  };
}

const NOTICE_WORDS = ['notice', 'notices', 'circular', 'circulars', 'announcement', 'announcements', 'suchna', 'सूचना', 'notice board'];

async function run(ctx) {
  const wantsEvents = hasPhrase(ctx.text, EVENT_WORDS);
  const wantsNotices = !wantsEvents || hasPhrase(ctx.text, NOTICE_WORDS);
  const parts = [];
  if (wantsEvents) parts.push(await events(ctx));
  if (wantsNotices) parts.push(await notices(ctx));
  const first = parts[0];
  return {
    text: parts.map((p) => p.text).join('\n\n'),
    facts: parts.length > 1 ? { calendar: parts[0].facts, notices: parts[1].facts } : first.facts,
    sources: parts.flatMap((p) => p.sources),
    link: link(first.screen, ctx.role) || link('notices', ctx.role),
  };
}

module.exports = { run, needsStudent: false };
