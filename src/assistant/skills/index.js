// Domain -> skill. Each skill's run(ctx) returns one of:
//   { text, facts, sources, link?, actions?, options? }   an answer grounded in the records
//   { need: { kind, question, options? } }                  a detail is missing (which class, which teacher)
//   { noData: true, text, handoffOffer? }                   nothing to answer from
//   { blocked: true, text }                                 not allowed for this person
module.exports = {
  fees: require('./fees'),
  attendance: require('./attendance'),
  timetable: require('./timetable'),
  exams: require('./exams'),
  notes: require('./notes'),
  transport: require('./transport'),
  notices: require('./notices'),
  leave: require('./leave'),
  library: require('./library'),
  admissions: require('./admissions'),
  hr: require('./hr'),
  policies: require('./policies'),
  general: require('./general'),
  learning: require('./learning'),
};
