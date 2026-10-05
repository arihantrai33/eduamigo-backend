// The school documents EduAmigo Ask answers from (handbook, policies, FAQs, circulars). Admins only
// (permission assistant.knowledge); everything is limited to the admin's own school.

const SchoolDocument = require('../models/SchoolDocument');
const { splitSections, MAX_DOCS_PER_SCHOOL, MAX_TEXT } = require('../services/knowledge');
const { HttpError, asyncHandler, isValidId } = require('../utils/http');
const { audit } = require('../services/audit');

const CATEGORIES = ['handbook', 'policy', 'faq', 'circular', 'other'];
const AUDIENCES = ['student', 'parent', 'teacher', 'accountant'];

const view = (d) => ({
  id: String(d._id), title: d.title, category: d.category, audience: d.audience, sourceType: d.sourceType, fileName: d.fileName,
  sections: d.sections.length, characters: d.sections.reduce((n, s) => n + s.text.length, 0), version: d.version, isActive: d.isActive,
  preview: d.sections[0] ? d.sections[0].text.slice(0, 160) : '', updatedAt: d.updatedAt, createdAt: d.createdAt,
});

function readFields(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title || '').trim().slice(0, 160);
    if (!title) throw new HttpError(400, 'Give the document a title');
    out.title = title;
  }
  if (body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) throw new HttpError(400, 'Invalid category');
    out.category = body.category;
  }
  if (body.audience !== undefined) {
    let list = body.audience;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = list.split(',').map((x) => x.trim()).filter(Boolean); } }
    if (!Array.isArray(list) || list.some((a) => !AUDIENCES.includes(a))) throw new HttpError(400, 'Invalid audience');
    out.audience = [...new Set(list)];
  }
  return out;
}

async function pdfText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try { return (await parser.getText()).text || ''; } finally { await parser.destroy(); }
}

const sectionsFrom = (text) => {
  const sections = splitSections(text);
  if (!sections.length) throw new HttpError(400, 'No readable text was found. Paste the text, or upload a PDF that is not a scan.');
  return sections;
};

// GET /api/assistant/knowledge
const list = asyncHandler(async (req, res) => {
  const docs = await SchoolDocument.find({ school: req.schoolId }).sort({ updatedAt: -1 }).limit(MAX_DOCS_PER_SCHOOL).lean();
  res.json({ success: true, data: docs.map(view), limits: { documents: MAX_DOCS_PER_SCHOOL, characters: MAX_TEXT } });
});

// POST /api/assistant/knowledge  { title, category?, audience?, text }  or multipart with a PDF in "file"
const create = asyncHandler(async (req, res) => {
  const fields = readFields(req.body || {});
  if (await SchoolDocument.countDocuments({ school: req.schoolId }) >= MAX_DOCS_PER_SCHOOL) {
    throw new HttpError(400, `A school can keep up to ${MAX_DOCS_PER_SCHOOL} documents. Remove one you no longer need.`);
  }
  const fromPdf = !!req.file;
  const text = fromPdf ? await pdfText(req.file.buffer).catch(() => { throw new HttpError(400, 'This PDF could not be read'); }) : String(req.body.text || '');
  const doc = await SchoolDocument.create({
    school: req.schoolId, ...fields, sections: sectionsFrom(text), sourceType: fromPdf ? 'pdf' : 'text', fileName: fromPdf ? String(req.file.originalname).slice(0, 160) : null,
    uploadedBy: req.user._id,
  });
  audit(req, 'assistant.knowledge_added', { targetType: 'school_document', targetId: doc._id, details: { title: doc.title, sections: doc.sections.length } });
  res.status(201).json({ success: true, data: view(doc) });
});

// PATCH /api/assistant/knowledge/:id  { title?, category?, audience?, isActive?, text? }
const update = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) throw new HttpError(400, 'Invalid document');
  const doc = await SchoolDocument.findOne({ _id: req.params.id, school: req.schoolId });
  if (!doc) throw new HttpError(404, 'Document not found');
  Object.assign(doc, readFields(req.body || {}, { partial: true }));
  if (typeof req.body.isActive === 'boolean') doc.isActive = req.body.isActive;
  if (req.body.text !== undefined) { doc.sections = sectionsFrom(req.body.text); doc.version += 1; doc.sourceType = 'text'; doc.fileName = null; }
  await doc.save();
  audit(req, 'assistant.knowledge_updated', { targetType: 'school_document', targetId: doc._id, details: { title: doc.title, version: doc.version, active: doc.isActive } });
  res.json({ success: true, data: view(doc) });
});

// DELETE /api/assistant/knowledge/:id
const remove = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) throw new HttpError(400, 'Invalid document');
  const doc = await SchoolDocument.findOneAndDelete({ _id: req.params.id, school: req.schoolId });
  if (!doc) throw new HttpError(404, 'Document not found');
  audit(req, 'assistant.knowledge_removed', { targetType: 'school_document', targetId: doc._id, details: { title: doc.title } });
  res.json({ success: true });
});

module.exports = { list, create, update, remove };
