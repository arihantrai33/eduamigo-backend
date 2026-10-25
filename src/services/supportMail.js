// Email notices about support requests. Best effort: a failed or missing email never blocks the reply itself, and the result is
// reported to the owner (never to the school) so nobody assumes a message was delivered when it was not.
const { sendEmail } = require('./email');
const { describeError } = require('./integrations');

async function notify(to, subject, text) {
  if (!to) return { sent: false, reason: 'No email address to send to' };
  try {
    const r = await sendEmail({ to, subject, text });
    return r.delivered ? { sent: true } : { sent: false, reason: 'No email provider is switched on (set one up under Integrations)' };
  } catch (err) {
    return { sent: false, reason: describeError(err).message };
  }
}

const trim = (t) => String(t || '').replace(/\s+/g, ' ').slice(0, 600);

// EduAmigo replied: tell the person who opened the request.
const notifySchoolOfReply = (request, to, text) => notify(to, `EduAmigo replied: ${request.subject}`,
  `EduAmigo support replied to your request "${request.subject}":\n\n${trim(text)}\n\nOpen Help and support in your EduAmigo office portal to read the conversation and answer.`);

// The school wrote: tell EduAmigo's support address (set in the console under Settings).
const notifySupportOfMessage = (request, schoolName, to, text) => notify(to, `[${schoolName}] ${request.subject}`,
  `${schoolName} wrote on the support request "${request.subject}":\n\n${trim(text)}\n\nReply in the owner console under Support requests.`);

module.exports = { notifySchoolOfReply, notifySupportOfMessage };
