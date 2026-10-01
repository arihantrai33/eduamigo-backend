const NoteEmbedding = require('../src/models/NoteEmbedding');
const { searchChunks, resetIndexState } = require('../src/services/retrieval');

const args = { school: 'S1', cls: '10', section: 'A', vector: [0.1], limit: 2 };

afterEach(() => { jest.restoreAllMocks(); resetIndexState(); });

test('uses the section filter in the vector search when the index supports it', async () => {
  const spy = jest.spyOn(NoteEmbedding, 'aggregate').mockResolvedValue([{ chunkText: 'x', section: 'A' }]);
  await searchChunks(args);
  expect(spy.mock.calls[0][0][0].$vectorSearch.filter.section).toEqual({ $in: ['A', ''] });
});

test('keeps working with an index that lacks the section filter, and never leaks other sections', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const spy = jest.spyOn(NoteEmbedding, 'aggregate')
    .mockRejectedValueOnce(new Error("PlanExecutor error during aggregation :: caused by :: Path 'section' needs to be indexed as filter"))
    .mockResolvedValue([
      { chunkText: 'B only', section: 'B' }, { chunkText: 'A notes', section: 'A' },
      { chunkText: 'whole class', section: '' }, { chunkText: 'more A', section: 'A' },
    ]);
  const rows = await searchChunks(args);
  expect(rows.map((r) => r.chunkText)).toEqual(['A notes', 'whole class']);
  const fallback = spy.mock.calls[1][0][0].$vectorSearch.filter;
  expect(fallback.section).toBeUndefined();
  expect(fallback.school).toEqual({ $eq: 'S1' });
  expect(fallback.class).toEqual({ $eq: '10' });

  await searchChunks(args); // later calls go straight to the fallback
  expect(spy).toHaveBeenCalledTimes(3);
  expect(console.warn).toHaveBeenCalledTimes(1);
});

test('other search errors are not hidden', async () => {
  jest.spyOn(NoteEmbedding, 'aggregate').mockRejectedValue(new Error('index not found'));
  await expect(searchChunks(args)).rejects.toThrow('index not found');
});
