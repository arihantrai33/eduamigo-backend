// Transactional email (password reset codes and similar).
// EMAIL_PROVIDER chooses the service:
//   brevo  - needs BREVO_API_KEY
//   resend - needs RESEND_API_KEY
//   log    - prints to the console and sends nothing (default outside production)
// EMAIL_FROM is the sender, e.g. "EduAmigo <no-reply@eduamigo.in>".
const axios = require('axios');

function provider() {
  return String(process.env.EMAIL_PROVIDER || (process.env.NODE_ENV === 'production' ? '' : 'log')).toLowerCase();
}

function isConfigured() {
  const p = provider();
  if (p === 'log') return true;
  if (p === 'brevo') return !!(process.env.BREVO_API_KEY && process.env.EMAIL_FROM);
  if (p === 'resend') return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
  return false;
}

// "Name <addr>" or "addr" -> { name, email }
function parseFrom(from) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return match ? { name: match[1] || 'EduAmigo', email: match[2].trim() } : { name: 'EduAmigo', email: String(from || '').trim() };
}

async function sendEmail({ to, subject, text }) {
  const p = provider();
  if (p === 'log') {
    if (process.env.NODE_ENV !== 'test') console.log(`[email] to=${to} subject="${subject}"\n${text}\n`);
    return { delivered: false, provider: 'log' };
  }
  if (!isConfigured()) throw new Error(`Email provider "${p || 'none'}" is not configured (set EMAIL_PROVIDER, its API key and EMAIL_FROM)`);

  if (p === 'brevo') {
    await axios.post('https://api.brevo.com/v3/smtp/email',
      { sender: parseFrom(process.env.EMAIL_FROM), to: [{ email: to }], subject, textContent: text },
      { headers: { 'api-key': process.env.BREVO_API_KEY }, timeout: 15000 });
  } else {
    await axios.post('https://api.resend.com/emails',
      { from: process.env.EMAIL_FROM, to: [to], subject, text },
      { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 });
  }
  return { delivered: true, provider: p };
}

module.exports = { sendEmail, isConfigured, provider, parseFrom };
