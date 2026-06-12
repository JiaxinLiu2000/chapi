import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../db/client.js';
import { searchWiki, writeWikiEntry } from './wiki.js';

describe('wiki write/search (DB path, graceful without OpenAI key)', () => {
  let slug: string;

  afterAll(async () => {
    if (slug) await prisma.wikiEntry.deleteMany({ where: { slug } });
    await prisma.$disconnect();
  });

  it('upserts a wiki entry by title slug', async () => {
    const entry = await writeWikiEntry({
      title: 'Chapi Test Entry 2026',
      body: 'A reusable note about formatting tables.',
      sourceRefs: [{ kind: 'session-message', ref: 'msg-123' }],
      tags: ['test'],
    });
    slug = entry.slug;
    expect(entry.title).toBe('Chapi Test Entry 2026');

    const row = await prisma.wikiEntry.findUnique({ where: { slug } });
    expect(row?.bodyMd).toContain('formatting tables');

    // idempotent update
    const updated = await writeWikiEntry({
      title: 'Chapi Test Entry 2026',
      body: 'Updated body.',
    });
    expect(updated.slug).toBe(slug);
    const count = await prisma.wikiEntry.count({ where: { slug } });
    expect(count).toBe(1);
  });

  it('search degrades to empty without an OpenAI key', async () => {
    const hits = await searchWiki('how to format tables');
    expect(Array.isArray(hits)).toBe(true);
  });
});
