import { afterAll, describe, expect, it } from 'vitest';
import { lanceDeleteEntry, lanceSearch, lanceUpsertEntry } from './lance.js';

const E1 = 'test-entry-aaa';
const E2 = 'test-entry-bbb';

describe('lance vector store (no OpenAI needed)', () => {
  afterAll(async () => {
    await lanceDeleteEntry(E1);
    await lanceDeleteEntry(E2);
  });

  it('stores vectors and returns the nearest entry', async () => {
    await lanceUpsertEntry(E1, [
      { id: 'a1', entryId: E1, chunk: 'apple fruit red', sourceRef: 'null', vector: [1, 0, 0, 0] },
    ]);
    await lanceUpsertEntry(E2, [
      { id: 'b1', entryId: E2, chunk: 'car vehicle road', sourceRef: 'null', vector: [0, 0, 1, 0] },
    ]);

    const hits = await lanceSearch([0.9, 0.1, 0, 0], 1);
    expect(hits.length).toBe(1);
    expect(hits[0]?.entryId).toBe(E1);
  });

  it('re-upsert replaces an entry vectors', async () => {
    await lanceUpsertEntry(E1, [
      { id: 'a2', entryId: E1, chunk: 'updated', sourceRef: 'null', vector: [0, 1, 0, 0] },
    ]);
    const hits = await lanceSearch([0, 1, 0, 0], 1);
    expect(hits[0]?.entryId).toBe(E1);
    expect(hits[0]?.chunk).toBe('updated');
  });
});
