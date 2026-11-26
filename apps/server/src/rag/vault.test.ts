import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter, splitFrontmatter } from './frontmatter.js';
import { buildGraph, extractLinks, parseNote, renderNote, safeFileName, splitSections, withRelatedSection, wikiLink } from './vault.js';

const entry = {
  id: 'e1',
  slug: 'a',
  title: 'Rent comps: base rent vs NER',
  bodyMd: 'See [[Zillow 抓取方法]] and [[x|alias]].',
  tags: ['rent comps', 'NER'] as unknown as object,
  sourceRefs: [{ kind: 'web', ref: 'https://a.com/x?y=1', note: 'he said "hi"', date: '2026-10-01', confidence: 62 }] as unknown as object,
  aliases: ['How to compute NER?'] as unknown as object,
  category: '数据',
  relPath: '',
  fileHash: '',
  kind: 'data',
  topics: ['Tower II 租金竞品', 'apartments.com'] as unknown as object,
  score: 71,
  polarity: '',
  situation: 'DTLA Class A towers, Oct 2026',
  solution: 'NER = base rent × (1 − free weeks × 12/52 / lease months)',
  observedAt: new Date('2026-10-01T00:00:00Z'),
  history: [] as unknown as object,
  createdAt: new Date('2026-01-02T00:00:00Z'),
  updatedAt: new Date('2026-10-20T00:00:00Z'),
};

describe('obsidian vault', () => {
  it('round-trips a typed knowledge point through render/parse', () => {
    const text = renderNote(entry);
    expect(text).toContain('confidence: 71');
    expect(text).toContain('## 数据对象 / 口径');
    const n = parseNote('entries/数据/Rent comps- base rent vs NER.md', text);
    expect(n.id).toBe('e1');
    expect(n.title).toBe('Rent comps: base rent vs NER'); // restored from the title property
    expect(n.kind).toBe('data');
    expect(n.topics).toEqual(['Tower II 租金竞品', 'apartments.com']);
    expect(n.score).toBe(71);
    expect(n.observedAt?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(n.tags).toEqual(['rent-comps', 'NER']);
    expect(n.aliases).toEqual(['How to compute NER?']);
    expect(n.sourceRefs).toEqual([{ kind: 'web', ref: 'https://a.com/x?y=1', note: 'he said "hi"', date: '2026-10-01', confidence: 62 }]);
    expect(n.situation).toBe(entry.situation);
    expect(n.solution).toBe(entry.solution);
    expect(n.body).toBe(entry.bodyMd);
  });

  it('a file renamed in Obsidian takes the new name as title; moving folders changes the kind', () => {
    const n = parseNote('entries/偏好/NER 计算.md', renderNote(entry));
    expect(n.title).toBe('NER 计算');
    expect(n.kind).toBe('preference');
    expect(n.polarity).toBe('positive');
  });

  it('splits sections by heading and keeps the rest as notes', () => {
    const s = splitSections('## 情况 / 前提\nA\n\n## 方案\nB\n\n## 相关\n- [[C]]');
    expect(s).toEqual({ situation: 'A', solution: 'B', notes: '## 相关\n- [[C]]' });
  });

  it('parses Obsidian-style flow and block lists', () => {
    const { fm } = splitFrontmatter('---\ntags: [a, "b c"]\naliases:\n  - x\n  - y\n---\nbody');
    expect(parseFrontmatter(fm!)).toEqual({ tags: ['a', 'b c'], aliases: ['x', 'y'] });
    expect(serializeFrontmatter({ a: [] })).toBe('---\na: []\n---\n');
  });

  it('extracts links and builds the graph by file name / title / alias', () => {
    expect(extractLinks('[[A]] [[B#h|b]] [[A]]')).toEqual(['A', 'B']);
    const g = buildGraph([
      { ...entry, id: '1', title: 'Hub', bodyMd: '[[Leaf one]] [[How to compute NER?]] [[missing]]', aliases: [] as unknown as object },
      { ...entry, id: '2', title: 'Leaf one', bodyMd: 'x', aliases: [] as unknown as object },
      { ...entry, id: '3', title: 'NER', bodyMd: '[[Hub]]' },
    ] as never);
    expect(g.links).toEqual([
      { source: '1', target: '2' },
      { source: '1', target: '3' },
      { source: '3', target: '1' },
    ]);
    expect(g.nodes.find((n) => n.id === '1')!.degree).toBe(3);
    expect(g.nodes[0]!.kind).toBe('data');
    expect(g.nodes[0]!.score).toBe(71);
  });

  it('adds a related section without duplicating existing links', () => {
    expect(safeFileName('a/b: c?')).toBe('a-b- c-');
    expect(wikiLink('a/b')).toBe('[[a-b|a/b]]');
    const b = withRelatedSection('text [[X]]', ['X', 'Y']);
    expect(b).toBe('text [[X]]\n\n## 相关\n- [[Y]]');
    expect(withRelatedSection(b, ['Z'])).toBe('text [[X]]\n\n## 相关\n- [[Y]]\n- [[Z]]');
  });
});
