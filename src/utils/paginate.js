// Optional paging for list endpoints. Lists stay complete unless the client asks for a page
// (?page= and/or ?limit=), so existing screens keep working while large schools can page.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// { page, limit, skip } when the request asks for paging, otherwise null.
function pageParams(query = {}) {
  if (query.page === undefined && query.limit === undefined) return null;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  return { page, limit, skip: (page - 1) * limit };
}

// Applies paging to a mongoose query (no-op without paging).
const applyPage = (query, paging) => (paging ? query.skip(paging.skip).limit(paging.limit) : query);

const pageInfo = (paging, total) => ({
  page: paging.page, limit: paging.limit, total, pages: Math.max(1, Math.ceil(total / paging.limit)),
});

// Runs a find (built by makeQuery) and, when paging, the matching count. Returns the response fields.
async function paged(Model, filter, paging, makeQuery) {
  const [rows, total] = await Promise.all([
    applyPage(makeQuery(Model.find(filter)), paging),
    paging ? Model.countDocuments(filter) : null,
  ]);
  return { count: rows.length, data: rows, ...(paging ? { pagination: pageInfo(paging, total) } : {}) };
}

module.exports = { pageParams, applyPage, pageInfo, paged, DEFAULT_LIMIT, MAX_LIMIT };
