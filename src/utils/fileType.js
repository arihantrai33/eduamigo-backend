// What an uploaded file really is, from its first bytes (and, for Office files, its name). Used for homework and chat attachments.
// Nothing that runs in a browser is accepted: no SVG, HTML, scripts or executables. Every file is served as a download with the
// type decided here, never the one the sender claimed.
const { detectImageType, isPdf } = require('./imageType');

const AUDIO_MIME = { webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };
const OFFICE = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

function audioType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return AUDIO_MIME.webm; // browser recordings (EBML)
  if (b.toString('ascii', 0, 4) === 'OggS') return AUDIO_MIME.ogg;
  if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return AUDIO_MIME.mp3;
  if (b.toString('ascii', 4, 8) === 'ftyp') return AUDIO_MIME.m4a;
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return AUDIO_MIME.wav;
  return null;
}

// -> { mime, kind: 'image' | 'pdf' | 'audio' | 'document' } or null when the file is not one of the allowed kinds.
function detectFile(buffer, filename = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const image = detectImageType(buffer);
  if (image) return { mime: image, kind: 'image' };
  if (isPdf(buffer)) return { mime: 'application/pdf', kind: 'pdf' };
  const audio = audioType(buffer);
  if (audio) return { mime: audio, kind: 'audio' };
  const ext = String(filename).toLowerCase().split('.').pop();
  if (OFFICE[ext] && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return { mime: OFFICE[ext], kind: 'document' };
  if (ext === 'txt' && !buffer.subarray(0, 2000).includes(0)) return { mime: 'text/plain; charset=utf-8', kind: 'document' };
  return null;
}

module.exports = { detectFile };
