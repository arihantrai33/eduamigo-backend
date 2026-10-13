// Learning help inside EduAmigo Ask: a short tutor answer (src/learning/tutor.js) to a study question, grounded in the
// student's own class notes when they cover it. It never creates a ticket, sends a message or reads anyone's records.
// Students get a link to continue in the AI Tutor. Without a model the person is told so plainly; nothing is guessed and
// nothing is passed to a teacher unless they ask for that.

const { teach } = require('../../learning/tutor');

async function run(ctx) {
  const student = ctx.role === 'student' ? await ctx.profile.student() : null;
  const continueLink = ctx.role === 'student'
    ? { path: `/student/learn?q=${encodeURIComponent(String(ctx.question || ctx.text).slice(0, 300))}`, label: 'Continue in AI Tutor' }
    : null;
  if (!ctx.aiAllowed) {
    return {
      text: 'I cannot explain topics right now because the AI tutor is not available for your school at the moment. Your question has not been sent to anyone. Please try again later, or read the notes your teachers uploaded.',
      sources: [], generated: true, link: continueLink,
    };
  }
  const out = await teach({ role: ctx.role, student, schoolId: ctx.schoolId, message: ctx.question || ctx.text, brief: true });
  if (out.type !== 'final') {
    return { text: `${out.message || 'The AI tutor could not answer just now.'} Your question has not been sent to anyone.`, sources: [], generated: true, link: continueLink };
  }
  return {
    text: out.text,
    generated: true,
    ai: out.provider ? { provider: out.provider } : null,
    sources: out.used.map((p) => ({ type: 'notes', label: `${p.title} (${p.type}, ${p.subject})` })),
    confidence: out.confidence,
    diagrams: out.diagrams,
    link: continueLink,
  };
}

module.exports = { run };
