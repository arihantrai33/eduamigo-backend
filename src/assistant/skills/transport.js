// Transport skill: buses, routes and live trip status from Transport.
//   students and parents: their bus, its route and where it is right now
//   admins: which route covers a place ("which bus goes to Chakand"), or the fleet's status
// Driver phone numbers are never included in answers here (they are on the Bus screen).

const Transport = require('../../models/Transport');
const { tokenize, closeEnough } = require('../text');
const { DOMAINS } = require('../domains');
const { plural, studentLabel, link, source } = require('./util');

const routeName = (b) => (/route$/i.test(b.routeName) ? b.routeName : `${b.routeName} route`);
const STOP_WORDS = new Set(['which', 'route', 'routes', 'bus', 'buses', 'covers', 'cover', 'goes', 'go', 'jati', 'jaati', 'jata', 'jaata', 'hai', 'kaunsi', 'kaunsa', 'kis', 'wali', 'wala', 'stop', 'the', 'to', 'for', 'tak', 'mein', 'me', 'se', 'kya', 'school', 'van', 'transport', 'from', 'area', 'near', 'pass', 'paas']);

function status(bus) {
  if (bus.busStatus === 'On Route') {
    const stops = [...(bus.stops || [])].sort((a, b) => a.order - b.order);
    const live = stops.find((s) => s.status === 'Live') || stops[bus.currentStopIndex] || null;
    const next = live ? stops.find((s) => s.order > live.order && s.status === 'Pending') : stops.find((s) => s.status === 'Pending');
    return { text: `is on the way${live ? `, now at ${live.name}` : ''}${next ? `; next stop ${next.name}${next.estimatedTime ? ` (around ${next.estimatedTime})` : ''}` : ''}`, live: live?.name || null, next: next?.name || null };
  }
  if (bus.busStatus === 'Completed') return { text: 'has finished its trip', live: null, next: null };
  return { text: 'has not started a trip yet', live: null, next: null };
}

async function forStudent(ctx, student) {
  const label = studentLabel(student);
  const bus = student.bus ? await Transport.findOne({ _id: student.bus, school: ctx.schoolId }).lean() : await Transport.findOne({ school: ctx.schoolId, assignedStudents: student._id }).lean();
  if (!bus) return { text: `${label} is not assigned to a school bus.`, facts: { student: label, bus: null }, sources: [] };
  const st = status(bus);
  return {
    text: `${label} travels on bus ${bus.busNumber} (${routeName(bus)}, driver ${bus.driverName}). The bus ${st.text}.`,
    facts: { student: label, bus: bus.busNumber, route: bus.routeName, driver: bus.driverName, status: bus.busStatus, currentStop: st.live, nextStop: st.next },
    sources: [source('bus', `Bus ${bus.busNumber} · ${bus.routeName}`, bus._id)],
  };
}

async function forAdmin(ctx) {
  const buses = await Transport.find({ school: ctx.schoolId }).lean();
  if (!buses.length) return { noData: true, text: 'No buses have been added yet.' };

  // Place names in the question, matched against stop and route names.
  const terms = new Set(DOMAINS.transport.terms.flatMap(([p]) => tokenize(p)));
  const words = tokenize(ctx.text).filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !terms.has(w));
  if (words.length) {
    const hits = buses.filter((b) => [b.routeName, ...(b.stops || []).map((s) => s.name)].some((name) => tokenize(name).some((n) => words.some((w) => closeEnough(w, n)))));
    if (hits.length) {
      return {
        text: `${hits.map((b) => {
          const stop = (b.stops || []).find((s) => tokenize(s.name).some((n) => words.some((w) => closeEnough(w, n))));
          return `Bus ${b.busNumber} (${routeName(b)})${stop ? ` stops at ${stop.name}` : ''}`;
        }).join('\n')}`,
        facts: { place: words.join(' '), buses: hits.map((b) => ({ bus: b.busNumber, route: b.routeName })) },
        sources: hits.slice(0, 3).map((b) => source('bus', `Route · ${b.routeName}`, b._id)),
      };
    }
  }
  const onRoute = buses.filter((b) => b.busStatus === 'On Route');
  const lines = [`${plural(buses.length, 'bus', 'buses')}: ${onRoute.length} on route, ${buses.filter((b) => b.busStatus === 'Completed').length} finished, ${buses.filter((b) => b.busStatus === 'Idle').length} not started.`];
  lines.push(...onRoute.slice(0, 8).map((b) => `- Bus ${b.busNumber} (${b.routeName}) ${status(b).text}`));
  return {
    text: lines.join('\n'),
    facts: { buses: buses.length, onRoute: onRoute.length, live: onRoute.slice(0, 8).map((b) => ({ bus: b.busNumber, route: b.routeName, stop: status(b).live })) },
    sources: [source('bus', 'Live bus status')],
  };
}

async function run(ctx) {
  let out;
  if (ctx.students?.length) {
    const parts = [];
    for (const s of ctx.students) parts.push(await forStudent(ctx, s));
    out = { text: parts.map((p) => p.text).join('\n\n'), facts: { items: parts.map((p) => p.facts) }, sources: parts.flatMap((p) => p.sources) };
  } else if (ctx.role === 'admin') out = await forAdmin(ctx);
  else return { noData: true, text: 'I could not find a student record linked to your account. Please ask the school office to link it.' };
  return { ...out, link: link('transport', ctx.role) };
}

module.exports = { run, needsStudent: true, staffCanName: true };
