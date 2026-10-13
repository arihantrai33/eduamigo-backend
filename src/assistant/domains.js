// EduAmigo Ask: the school's knowledge areas ("domains").
//
// Each domain has:
//   label     - shown on answers ("Routed to: Fees")
//   about     - one line telling the language model what the topic covers
//   ask       - how the topic is named in a clarifying question ("students' leave requests or staff leave and salary?")
//   feature   - plan feature the school must have (config/features.js); null = core module
//   roles     - who may ask about it; anyone else gets a polite "not available for your account"
//   owner     - who a hand-off ticket goes to
//   terms     - [phrase, weight] in English, Hinglish (Roman script) and Hindi (Devanagari).
//               Weight 3 = names the topic on its own, 2 = strong hint, 1 = weak hint (shared with other topics).
//
// Matching is on whole words after normalising (see text.js), with typo tolerance for longer words.

const DOMAINS = {
  fees: {
    about: "a person's own fee records: what is due or overdue, payments made, receipts, school-wide collection and defaulters, bus fees. NOT the rules about fees (late fee, refund, concession, due dates, how to pay): those are policies",
    ask: "fees",
    label: 'Fees',
    feature: 'fees',
    roles: ['student', 'parent', 'admin', 'accountant'],
    owner: 'accounts',
    terms: [
      ['fee', 3], ['fees', 3], ['fess', 3], ['feez', 3], ['fes', 2], ['school fees', 3], ['bus fee', 4], ['bus fees', 4], ['transport fees', 4], ['van fees', 4], ['tuition', 3], ['shulk', 3], ['फीस', 3], ['शुल्क', 3],
      ['fee receipt', 3], ['receipt', 2], ['rasid', 2], ['raseed', 2], ['installment', 2], ['instalment', 2], ['kisht', 2],
      ['challan', 2], ['payment', 2], ['pay', 2], ['paid', 1], ['dues', 2], ['due', 1], ['overdue', 2], ['outstanding', 2],
      ['balance', 1], ['baki', 1], ['baaki', 1], ['bakaya', 2], ['jama', 1], ['paisa', 1], ['paise', 1], ['concession', 2],
      ['defaulter', 3], ['defaulters', 3], ['collection', 2], ['collected', 2], ['pending fees', 3], ['unpaid', 2],
    ],
  },
  attendance: {
    about: "who was present, absent or late, attendance percentage and reports",
    ask: "attendance",
    label: 'Attendance',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin'],
    owner: 'class_teacher',
    terms: [
      ['attendance', 3], ['hazri', 3], ['haziri', 3], ['haajri', 3], ['हाजिरी', 3], ['उपस्थिति', 3], ['upasthiti', 3],
      ['present', 2], ['absent', 2], ['absentees', 3], ['gairhazir', 3], ['late', 1], ['school aaya', 2], ['school gaya', 2],
      ['school aayi', 2], ['school gayi', 2], ['kitne din', 1], ['bunk', 1], ['missed school', 2],
    ],
  },
  timetable: {
    about: "class timetable, periods, which teacher takes which period and when, free periods",
    ask: "the timetable",
    label: 'Timetable',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin'],
    owner: 'class_teacher',
    terms: [
      ['timetable', 3], ['time table', 3], ['routine', 2], ['period', 2], ['periods', 2], ['lecture', 2], ['lectures', 2],
      ['next class', 3], ['pehla period', 3], ['first period', 3], ['kaunsi class', 2], ['class schedule', 3],
      ['class kab', 3], ['class kb', 3], ['class kb hai', 3], ['class kab hai', 3], ['class kitne baje', 3], ['kitne baje', 1], ['kis time', 1], ['schedule', 1], ['subject', 1], ['free period', 3], ['samay sarini', 3], ['समय सारणी', 3],
    ],
  },
  exams: {
    about: "exam dates and date sheet, marks, results, grades, report cards",
    ask: "exams and results",
    label: 'Exams & results',
    feature: 'exams',
    roles: ['student', 'parent', 'teacher', 'admin'],
    owner: 'exam_cell',
    terms: [
      ['exam', 3], ['exams', 3], ['exm', 3], ['examination', 3], ['pariksha', 3], ['परीक्षा', 3], ['test', 2], ['unit test', 3],
      ['mid term', 3], ['midterm', 3], ['final exam', 3], ['date sheet', 3], ['datesheet', 3], ['result', 3], ['results', 3],
      ['marks', 3], ['mark', 2], ['score', 2], ['grade', 2], ['grades', 2], ['percentage', 2], ['report card', 3],
      ['number', 1], ['numbers', 1], ['rank', 2], ['paper', 1], ['topper', 2],
    ],
  },
  notes: {
    about: "homework, assignments, worksheets, notes and study material uploaded by teachers",
    ask: "homework and notes",
    label: 'Homework & notes',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin'],
    owner: 'subject_teacher',
    terms: [
      ['homework', 3], ['home work', 3], ['hw', 2], ['assignment', 3], ['assignments', 3], ['notes', 3], ['note', 2],
      ['study material', 3], ['worksheet', 3], ['grihkarya', 3], ['गृहकार्य', 3], ['question paper', 2], ['sample paper', 3],
      ['chapter', 1], ['pdf', 1], ['submission', 2], ['submit', 1],
    ],
  },
  transport: {
    about: "school bus, routes, stops, pick-up and drop timing, where the bus is now",
    ask: "the school bus",
    label: 'Transport',
    feature: 'transport',
    roles: ['student', 'parent', 'admin'],
    owner: 'transport',
    terms: [
      ['bus', 3], ['buses', 3], ['school bus', 3], ['van', 2], ['transport', 3], ['route', 2], ['routes', 2], ['stop', 2],
      ['bus stop', 3], ['driver', 2], ['pickup', 2], ['pick up', 2], ['drop', 2], ['trip', 2], ['gaadi', 1], ['gadi', 1],
      ['बस', 3],
    ],
  },
  notices: {
    about: "notice board circulars, school events, holidays, vacations, PTM, whether school is closed",
    ask: "notices and holidays",
    label: 'Notices & events',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin', 'accountant'],
    owner: 'office',
    terms: [
      ['notice', 3], ['notices', 3], ['circular', 3], ['circulars', 3], ['announcement', 3], ['announcements', 3],
      ['suchna', 3], ['सूचना', 3], ['event', 2], ['events', 2], ['function', 2], ['ptm', 3], ['parent teacher meeting', 3],
      ['calendar', 2], ['holiday', 3], ['holidays', 3], ['vacation', 3], ['chhutti kab', 3], ['chutti kab', 3],
      ['chhutti hai', 3], ['chutti hai', 3], ['school band', 3], ['school closed', 3], ['annual day', 3], ['sports day', 3],
      ['chhutti', 1], ['chutti', 1], ['news', 1],
    ],
  },
  leave: {
    about: "leave applications of students: applying, status, approvals",
    ask: "students' leave requests",
    label: 'Leave requests',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin'],
    owner: 'class_teacher',
    terms: [
      ['leave', 3], ['leaves', 3], ['leave application', 3], ['leave request', 3], ['leave requests', 3], ['apply leave', 3],
      ['avkash', 3], ['अवकाश', 3], ['chhutti chahiye', 3], ['chutti chahiye', 3], ['chhutti leni', 3], ['chutti leni', 3],
      ['sick leave', 2], ['student leave', 4], ['students leave', 4], ['student leave requests', 5], ['leave requests of students', 5],
      ['leave of students', 4], ['bachche ki leave', 4], ['bachchon ki leave', 4], ['bachchon ki chhutti', 4], ['chhutti', 1], ['chutti', 1], ['approve', 1], ['approved', 1],
    ],
  },
  library: {
    about: "library books: availability, author, catalogue",
    ask: "the library",
    label: 'Library',
    feature: 'library',
    roles: ['student', 'parent', 'teacher', 'admin'],
    owner: 'librarian',
    terms: [
      ['library', 3], ['book', 3], ['books', 3], ['kitab', 3], ['kitaab', 3], ['kitabein', 3], ['पुस्तक', 3], ['किताब', 3],
      ['author', 2], ['librarian', 3], ['novel', 2], ['pustakalay', 3],
    ],
  },
  admissions: {
    about: "enquiries and applications for new students (admin)",
    ask: "admissions",
    label: 'Admissions',
    feature: 'admissions',
    roles: ['admin'],
    owner: 'office',
    terms: [
      ['admission', 3], ['admissions', 3], ['enquiry', 3], ['enquiries', 3], ['inquiry', 3], ['inquiries', 3],
      ['pravesh', 3], ['प्रवेश', 3], ['new admission', 3], ['application', 1], ['applications', 1], ['walk in', 2],
    ],
  },
  hr: {
    about: "staff leave and salary: leave taken, payslips, payroll (teachers and admin)",
    ask: "staff leave and salary",
    label: 'HR & payroll',
    feature: 'hr',
    roles: ['teacher', 'admin'],
    owner: 'office',
    terms: [
      ['salary', 3], ['salaries', 3], ['payslip', 3], ['pay slip', 3], ['salary slip', 3], ['vetan', 3], ['वेतन', 3],
      ['tankhwah', 3], ['payroll', 3], ['staff leave', 3], ['casual leave', 3], ['earned leave', 3], ['leave balance', 3],
      ['leave', 3], ['leaves', 3], ['leave requests', 3], ['leave request', 3], ['sir ki leave', 4], ['madam ki leave', 4], ['mam ki leave', 4], ['sir ki chhutti', 4], ['madam ki chhutti', 4], ['staff', 1], ['teachers leave', 3], ['teacher leave', 3], ['appraisal', 2],
    ],
  },
  policies: {
    about: "the school's written rules and general information, not anyone's own records: handbook and policies such as late fee, refund, discount and concession rules, how and when to pay, leave and absence rules, uniform, school timings, exam and promotion rules, code of conduct, mobile phone rules, canteen and other facilities, admission process, contact and address. Any question about the school itself that is not a person's record, notice or timetable",
    ask: "school rules and policies",
    label: 'School information',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin', 'accountant'],
    owner: 'office',
    terms: [
      ['policy', 3], ['policies', 3], ['handbook', 3], ['rules', 2], ['rule', 2], ['regulations', 2], ['code of conduct', 3], ['guidelines', 2],
      ['uniform', 3], ['timing', 2], ['timings', 2], ['school timing', 3], ['school hours', 3], ['niyam', 3], ['नियम', 3], ['vardi', 3], ['वर्दी', 3],
      ['refund policy', 7], ['fee policy', 7], ['fees policy', 7], ['leave policy', 4], ['promotion rules', 3], ['dress code', 3], ['admission process', 3], ['procedure', 2], ['kaise karte', 1],
    ],
  },
  // Help with studying, answered by the tutor (src/learning). Never a record and never a ticket: a doubt about a lesson is
  // explained here; it only goes to a teacher when the person explicitly asks for that (kind "forward" / "human").
  learning: {
    about: "help with studying a school subject: explain a concept or a chapter, solve or check a maths or science problem, practice questions, revision and exam preparation tips, a doubt about a lesson. NOT the person's own marks, homework list, notes list or exam dates: those are records",
    ask: "help with your studies",
    label: 'Learning help',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin'],
    owner: 'subject_teacher',
    terms: [
      ['explain', 3], ['explanation', 3], ['samjhao', 3], ['samjha do', 3], ['samjhaiye', 3], ['samjha dijiye', 3], ['samjhana', 2], ['समझाओ', 3], ['समझाइए', 3],
      ['samajh nahi', 3], ['samajh nahi aaya', 3], ['samajh nahi aa raha', 3], ['dont understand', 3], ["don't understand", 3], ['not understand', 2], ['समझ नहीं', 3],
      ['kya hota hai', 2], ['kya hoti hai', 2], ['what is', 1], ['meaning of', 2], ['define', 3], ['definition', 3], ['concept', 2],
      ['solve', 3], ['hal karo', 3], ['hal kijiye', 3], ['sawal', 1], ['formula', 2], ['derive', 3], ['derivation', 3], ['theorem', 2], ['equation', 2],
      ['revise', 3], ['revision', 3], ['dohrana', 3], ['practice', 2], ['practise', 2], ['practice questions', 3], ['quiz me', 3],
      ['prepare', 2], ['preparation', 2], ['padhai', 2], ['padhna', 2], ['padhao', 3], ['पढ़ाओ', 3], ['doubt', 2], ['example do', 2], ['example dijiye', 2],
    ],
  },
  general: {
    about: "greetings, thanks, what the assistant can do",
    ask: "something general",
    label: 'General',
    feature: null,
    roles: ['student', 'parent', 'teacher', 'admin', 'accountant'],
    owner: 'office',
    terms: [
      ['hi', 3], ['hello', 3], ['hey', 3], ['namaste', 3], ['namaskar', 3], ['good morning', 3], ['good afternoon', 3],
      ['good evening', 3], ['thanks', 3], ['thank you', 3], ['thank', 2], ['dhanyavad', 3], ['shukriya', 3], ['bye', 3],
      ['help', 2], ['what can you do', 3], ['kya kar sakte', 3], ['who are you', 3], ['tum kaun', 3], ['aap kaun', 3],
      ['ok', 2], ['okay', 2], ['theek hai', 2],
    ],
  },
};

// Who handles a hand-off for each owner key (resolved to real people in handoff.js).
const OWNERS = {
  accounts: 'Accounts office',
  class_teacher: 'Class teacher',
  exam_cell: 'Exam cell',
  subject_teacher: 'Subject teacher',
  transport: 'Transport in-charge',
  librarian: 'Librarian',
  office: 'School office',
};

const DOMAIN_KEYS = Object.keys(DOMAINS);

// Domains a role may ask about.
const domainsForRole = (role) => DOMAIN_KEYS.filter((d) => DOMAINS[d].roles.includes(role));

module.exports = { DOMAINS, DOMAIN_KEYS, OWNERS, domainsForRole };
