import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const completeMock = vi.fn<(opts: { prompt: string; trigger?: string }) => Promise<string>>();
vi.mock('../engine/llm.js', () => ({ complete: (o: { prompt: string; trigger?: string }) => completeMock(o) }));

const { prisma } = await import('../db/client.js');
const { classifyAll, classifySession, summarizeProject, refreshSummariesDaily } = await import('./classify.js');

const tag = `cls-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const sessionIds: string[] = [];
const projectNames: string[] = [];

async function mk(title: string, extra: Record<string, unknown> = {}) {
  const s = await prisma.session.create({
    data: { slug: `${tag}-${sessionIds.length}`, title, titleSource: 'user', model: 'm', effort: 'high', language: 'zh', ...extra },
  });
  sessionIds.push(s.id);
  await prisma.message.create({ data: { sessionId: s.id, role: 'user', type: 'user', content: {}, text: `hello ${title}` } });
  return s;
}

beforeEach(() => completeMock.mockReset());
afterEach(async () => {
  await prisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.project.deleteMany({ where: { name: { in: projectNames } } });
  sessionIds.length = 0;
  projectNames.length = 0;
});

describe('classifyAll', () => {
  it('creates projects from the model and keeps projectSource ai', async () => {
    const a = await mk('A');
    const b = await mk('B');
    const [p1, p2] = [`${tag}-P1`, `${tag}-P2`];
    projectNames.push(p1, p2);
    completeMock.mockResolvedValue('```json\n' + JSON.stringify({ projects: [p1, p2], assign: { [a.id]: p1, [b.id]: p2.toUpperCase() } }) + '\n```');
    const r = await classifyAll({ sessionIds: [a.id, b.id] });
    expect(r.projects).toBe(2);
    expect(r.assigned).toBe(2);
    const rows = await prisma.session.findMany({ where: { id: { in: [a.id, b.id] } }, include: { project: true } });
    expect(rows.every((s) => s.projectSource === 'ai')).toBe(true);
    expect(rows.find((s) => s.id === a.id)?.project?.name).toBe(p1);
    expect(rows.find((s) => s.id === b.id)?.project?.name).toBe(p2);
    // idempotent: re-run reuses rows
    await classifyAll({ sessionIds: [a.id, b.id] });
    expect(await prisma.project.count({ where: { name: { in: [p1, p2] } } })).toBe(2);
  });

  it('does not touch user-sourced sessions', async () => {
    const u = await mk('U', { projectSource: 'user' });
    const a = await mk('A');
    const p1 = `${tag}-P1`;
    projectNames.push(p1);
    completeMock.mockResolvedValue(JSON.stringify({ projects: [p1], assign: { [u.id]: p1, [a.id]: p1 } }));
    await classifyAll({ sessionIds: [u.id, a.id] });
    expect((await prisma.session.findUnique({ where: { id: u.id } }))?.projectId).toBeNull();
    expect((await prisma.session.findUnique({ where: { id: a.id } }))?.projectId).not.toBeNull();
  });

  it('archived (merged) project names are not recreated; sessions under them stay unassigned', async () => {
    const a = await mk('A');
    const old = `${tag}-Merged`;
    projectNames.push(old);
    const archived = await prisma.project.create({ data: { name: old, archived: true } });
    completeMock.mockResolvedValue(JSON.stringify({ projects: [old.toUpperCase()], assign: { [a.id]: old } }));
    await classifyAll({ sessionIds: [a.id] });
    const rows = await prisma.project.findMany({ where: { name: old } });
    expect(rows.map((r) => r.id)).toEqual([archived.id]);
    expect((await prisma.session.findUnique({ where: { id: a.id } }))?.projectId).toBeNull();
  });

  it('non-JSON twice → no throw, batch skipped', async () => {
    const a = await mk('A');
    completeMock.mockResolvedValue('sorry no');
    const r = await classifyAll({ sessionIds: [a.id] });
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(r.assigned).toBe(0);
    expect((await prisma.session.findUnique({ where: { id: a.id } }))?.projectId).toBeNull();
  });
});

describe('classifyAll batches', () => {
  it('first parsed batch without projects → later batch uses choose-only prompt, no new projects', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 41; i++) ids.push((await mk(`B${i}`)).id);
    const before = await prisma.project.count();
    completeMock.mockResolvedValue(JSON.stringify({ assign: {} }));
    await classifyAll({ sessionIds: ids });
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(completeMock.mock.calls[1]![0].prompt).toContain('不要新建');
    expect(completeMock.mock.calls[1]![0].prompt).not.toContain('"projects"');
    expect(await prisma.project.count()).toBe(before);
  });
});

describe('classifySession', () => {
  it('unknown project name → null; known → set; user source untouched', async () => {
    const p = await prisma.project.create({ data: { name: `${tag}-Known` } });
    projectNames.push(p.name);
    const a = await mk('A');
    completeMock.mockResolvedValueOnce(JSON.stringify({ project: 'nope-nonexistent' }));
    await classifySession(a.id);
    expect((await prisma.session.findUnique({ where: { id: a.id } }))?.projectId).toBeNull();
    completeMock.mockResolvedValueOnce(JSON.stringify({ project: ` ${p.name.toUpperCase()} ` }));
    await classifySession(a.id);
    expect((await prisma.session.findUnique({ where: { id: a.id } }))?.projectId).toBe(p.id);
    const u = await mk('U', { projectSource: 'user' });
    completeMock.mockClear();
    await classifySession(u.id);
    expect(completeMock).not.toHaveBeenCalled();
  });
});

describe('summarizeProject', () => {
  it('writes summary + summaryAt; refresh only stale projects', async () => {
    const p = await prisma.project.create({ data: { name: `${tag}-S` } });
    projectNames.push(p.name);
    await mk('A', { projectId: p.id });
    completeMock.mockResolvedValue('当前在推进。下一步收尾。');
    await summarizeProject(p.id);
    const after = await prisma.project.findUnique({ where: { id: p.id } });
    expect(after?.summary).toBe('当前在推进。下一步收尾。');
    expect(after?.summaryAt).not.toBeNull();
    completeMock.mockClear();
    await refreshSummariesDaily({ projectIds: [p.id] });
    expect(completeMock).not.toHaveBeenCalled(); // fresh → not re-summarized
  });
});
