// Uploads are judged by what the file really is, not by the type the browser says it has.
const { api, connect, disconnect, clear, auth, seedSchool } = require('./helpers');
const { isPdf, detectImageType } = require('../src/utils/imageType');

let A;
beforeAll(connect);
afterAll(disconnect);
beforeEach(async () => { await clear(); A = await seedSchool('Upload School'); });

const HTML = Buffer.from('<html><script>alert(document.cookie)</script></html>');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

describe('file type detection', () => {
  test('a PDF starts with %PDF-', () => {
    expect(isPdf(PDF)).toBe(true);
    expect(isPdf(HTML)).toBe(false);
    expect(isPdf(Buffer.from('%PDF'))).toBe(false);
    expect(isPdf('%PDF-1.4')).toBe(false);
  });
});

describe('notes upload', () => {
  const send = (file, contentType = 'application/pdf') => api().post('/api/notes/upload').set(auth(A.teacherUser))
    .field('title', 'Chapter 1').field('subject', 'Science').field('class', '10').field('section', 'A')
    .attach('file', file, { filename: 'chapter1.pdf', contentType });

  test('an HTML page sent as "application/pdf" is refused before it is stored or read', async () => {
    const res = await send(HTML);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a valid PDF/i);
  });

  test('a file that really is a PDF gets past the check (it is refused later only for the class or storage)', async () => {
    const res = await send(PDF);
    expect(res.body.message || '').not.toMatch(/not a valid PDF/i);
  });
});

describe('chat attachments', () => {
  const send = (file, contentType) => api().post('/api/chat/upload').set(auth(A.studentUser)).attach('file', file, { filename: 'a.bin', contentType });

  test('HTML sent as a PDF, and HTML sent as a PNG, are refused', async () => {
    const asPdf = await send(HTML, 'application/pdf');
    expect(asPdf.status).toBe(400);
    expect(asPdf.body.message).toMatch(/valid PDF, JPG, PNG or WEBP/i);
    const asPng = await send(HTML, 'image/png');
    expect(asPng.status).toBe(400);
  });

  test('a PDF claiming to be an image is refused, and the real type of an image is used', async () => {
    expect((await send(PDF, 'image/png')).status).toBe(400);
    expect(detectImageType(PNG)).toBe('image/png');
  });
});
