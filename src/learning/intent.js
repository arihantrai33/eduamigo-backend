// What the student is asking the tutor to DO, found without a model (no cost, same answer every time). Teaching questions are
// left to the model, which reads the conversation; only requests that need a different action are recognised here:
//
//   revise_notes     "Mujhe mere notes revise karwa do", "revise my notes of Science"   -> read the student's own notes and revise them
//   practice         "Ab isi concept ke 5 questions poochho", "quiz me"                  -> offer a checked practice set (Practice & Assessment)
//   plan             "Revision plan banao", "make me a study schedule"                 -> point to the Revision Planner (real exam dates, no guessing)
//   contact_teacher  "Teacher ko bolo ...", "tell my teacher ..."                        -> the tutor cannot contact anyone: say so, send nothing
//   teach            everything else
//
// A request to contact a teacher is never turned into a ticket from here: tickets belong to EduAmigo Ask, and only when the
// person asks for one. A revision request is never a contact request.

const { hasPhrase, normalize } = require('../assistant/text');

const CONTACT = ['teacher ko bolo', 'teacher ko batao', 'teacher ko message', 'teacher se baat', 'teacher se milna', 'teacher ko bata do', 'sir ko bolo', 'madam ko bolo', 'mam ko bolo',
  'sir se baat', 'madam se baat', 'tell my teacher', 'tell the teacher', 'message my teacher', 'message the teacher', 'contact my teacher', 'contact the teacher', 'talk to my teacher',
  'talk to the teacher', 'inform my teacher', 'inform the teacher', 'ask my teacher to', 'call my teacher', 'principal se baat', 'speak to my teacher', 'complaint karni', 'complaint darj',
  'टीचर को बोलो', 'टीचर से बात', 'शिक्षक को बताओ', 'शिक्षक से बात'];
const PLAN = ['revision plan', 'revision schedule', 'study plan', 'study schedule', 'revision ka plan', 'padhai ka plan', 'padhai ka schedule', 'plan banao', 'schedule banao', 'timetable banao', 'रिवीजन प्लान', 'पढ़ाई का प्लान'];
const NOTES = ['notes', 'note', 'chapter', 'nots', 'नोट्स', 'अध्याय'];
const REVISE = ['revise', 'revision', 'revising', 'dohra', 'dohrao', 'dohrana', 'recap', 'summary', 'summarise', 'summarize', 'yaad karwa', 'yad karwa', 'रिवाइज़', 'रिवाइज', 'दोहरा', 'दोहराओ'];
const ASK_ME = ['poochho', 'puchho', 'pucho', 'poocho', 'ask me', 'quiz me', 'test me', 'questions do', 'questions dedo', 'sawal do', 'sawal dedo', 'questions banao', 'give me questions',
  'give me some questions', 'practice questions', 'practice karao', 'practice karwao', 'mujhe questions', 'mujhe sawal', 'questions chahiye', 'sawal chahiye', 'quiz banao', 'quiz do',
  'सवाल पूछो', 'प्रश्न पूछो', 'सवाल दो', 'क्विज़'];
const NOT_PRACTICE = ['solve', 'hal karo', 'hal kijiye', 'explain', 'samjhao', 'samjhaiye', 'समझाओ', 'हल करो'];
const QUESTION_WORD = ['question', 'questions', 'sawal', 'sawaal', 'prashn', 'quiz', 'सवाल', 'प्रश्न', 'क्विज़'];

// "5 questions", "5 sawal", "paanch" are not parsed as words: a digit is looked for, 1 to 10, else 5.
function countIn(text) {
  const m = String(text).match(/\b(\d{1,2})\b/);
  const n = m ? Number(m[1]) : null;
  return n && n >= 1 && n <= 10 ? n : 5;
}

// subjects: the school's subject names for this class (to spot "revise my Science notes"). Returns { intent, count?, subject? }.
function detect(message, { subjects = [] } = {}) {
  const text = String(message || '');
  const t = normalize(text);
  if (!t) return { intent: 'teach' };
  const subject = subjects.find((s) => t.includes(normalize(s))) || null;

  // Revision wins over contact: "mere notes revise karwa do" has no person to contact.
  if (hasPhrase(text, REVISE) && hasPhrase(text, NOTES)) return { intent: 'revise_notes', subject };
  if (hasPhrase(text, CONTACT)) return { intent: 'contact_teacher' };
  if (hasPhrase(text, PLAN) && (hasPhrase(text, REVISE) || /study|padhai|पढ़ाई|exam|test|pariksha|परीक्षा/.test(t))) return { intent: 'plan' };
  if (hasPhrase(text, ASK_ME) && (hasPhrase(text, QUESTION_WORD) || /quiz|test me/.test(t)) && !hasPhrase(text, NOT_PRACTICE)) return { intent: 'practice', count: countIn(text), subject };
  return { intent: 'teach' };
}

// Fixed replies for the intents that need no model. language: en | hi | hinglish. Nothing here names a person or a record.
const TEXT = {
  contact_teacher: {
    en: 'I am your learning tutor, so I cannot contact your teacher or send any message from here, and nothing has been sent. To ask a teacher something, use the EduAmigo Ask button on your Home screen and say who it is for.',
    hinglish: 'Main aapka learning tutor hoon, isliye yahan se teacher ko koi message ya request nahi bhej sakta, aur kuch bheja nahi gaya hai. Teacher ko kuch bolna ho to Home screen par EduAmigo Ask button se bataiye aur likhiye ki kisko bolna hai.',
    hi: 'मैं आपका लर्निंग ट्यूटर हूँ, इसलिए यहाँ से टीचर को कोई संदेश या अनुरोध नहीं भेज सकता, और कुछ भेजा नहीं गया है। टीचर से कुछ कहना हो तो होम स्क्रीन पर EduAmigo Ask बटन से बताइए और लिखिए कि किसे कहना है।',
  },
  plan: {
    en: 'I can help you plan this in the Revision Planner. It uses your real exam date (from your school\'s schedule or one you enter) and the topics you choose, and puts the topics you find hard first. Press "Open Revision Planner" below.',
    hinglish: 'Iske liye Revision Planner sabse sahi hai. Wo aapki asli exam date (school ke schedule se ya aapki daali hui) aur aapke chune hue topics se plan banata hai, aur jo topics mushkil lagte hain unhe pehle rakhta hai. Neeche "Open Revision Planner" dabaiye.',
    hi: 'इसके लिए रिवीज़न प्लानर सबसे सही है। यह आपकी असली परीक्षा की तारीख़ (स्कूल के शेड्यूल से या आपकी डाली हुई) और आपके चुने विषयों से योजना बनाता है, और कठिन लगने वाले विषय पहले रखता है। नीचे "Open Revision Planner" दबाइए।',
  },
  practice_topic: {
    en: (n, topic) => `Sure: ${n} practice question${n === 1 ? '' : 's'} on ${topic}. Press "Start practice" below. Every answer key is checked before you see the questions, and you get hints and solutions after you try.`,
    hinglish: (n, topic) => `Theek hai: ${topic} par ${n} practice question${n === 1 ? '' : 's'}. Neeche "Start practice" dabaiye. Har sawal ki answer key aapko dikhane se pehle check ki jaati hai, aur try karne ke baad hint aur solution milte hain.`,
    hi: (n, topic) => `ठीक है: ${topic} पर ${n} अभ्यास प्रश्न। नीचे "Start practice" दबाइए। प्रश्न दिखाने से पहले हर उत्तर-कुंजी जाँची जाती है, और कोशिश करने के बाद संकेत और हल मिलते हैं।`,
  },
  practice_ask_topic: {
    en: 'Which topic should the questions be on? For example "Fractions" or "Photosynthesis". Tell me and I will set up the practice.',
    hinglish: 'Questions kis topic par chahiye? Jaise "Fractions" ya "Photosynthesis". Bata dijiye, main practice set kar dunga.',
    hi: 'प्रश्न किस विषय पर चाहिए? जैसे "भिन्न" या "प्रकाश संश्लेषण"। बताइए, मैं अभ्यास तैयार कर दूँगा।',
  },
  notes_not_ready: {
    en: 'Your teachers have added notes for your class, but their text is not ready for the AI yet (it may still be processing, or the file could not be read). I cannot revise them right now. Tell me a subject or topic and I can revise it from general knowledge, but that will not be from your school\'s notes.',
    hinglish: 'Aapke teachers ne notes add kiye hain, par unka text abhi AI ke liye ready nahi hai (ho sakta hai processing chal rahi ho, ya file padhi na ja saki ho). Abhi main unhe revise nahi kara sakta. Subject ya topic bataiye, main general knowledge se revise kara dunga, par wo aapke school ke notes se nahi hoga.',
    hi: 'आपके शिक्षकों ने नोट्स जोड़े हैं, पर उनका टेक्स्ट अभी AI के लिए तैयार नहीं है (प्रोसेसिंग चल रही हो सकती है, या फ़ाइल पढ़ी नहीं जा सकी)। अभी मैं उन्हें रिवाइज़ नहीं करा सकता। विषय या टॉपिक बताइए, मैं सामान्य ज्ञान से रिवाइज़ करा दूँगा, पर वह आपके स्कूल के नोट्स से नहीं होगा।',
  },
  no_notes: {
    en: 'No notes have been uploaded for your class yet, so I cannot revise "your notes". Tell me a subject or topic and I can revise it from general knowledge, but that will not be from your school\'s notes.',
    hinglish: 'Aapki class ke liye abhi koi notes upload nahi hue hain, isliye main "aapke notes" revise nahi kara sakta. Subject ya topic bataiye, main general knowledge se revise kara dunga, par wo aapke school ke notes se nahi hoga.',
    hi: 'आपकी कक्षा के लिए अभी कोई नोट्स अपलोड नहीं हुए हैं, इसलिए मैं "आपके नोट्स" रिवाइज़ नहीं करा सकता। विषय या टॉपिक बताइए, मैं सामान्य ज्ञान से रिवाइज़ करा दूँगा, पर वह आपके स्कूल के नोट्स से नहीं होगा।',
  },
};

function reply(key, language, ...args) {
  const set = TEXT[key];
  const v = set[language] || set.en;
  return typeof v === 'function' ? v(...args) : v;
}

module.exports = { detect, reply, countIn };
