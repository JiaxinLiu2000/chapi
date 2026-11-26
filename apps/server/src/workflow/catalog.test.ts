import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../db/client.js';
import { sopCatalog } from './catalog.js';

const slugs: string[] = [];
afterEach(async () => {
  await prisma.workflow.deleteMany({ where: { slug: { in: slugs.splice(0) } } });
});

describe('sopCatalog', () => {
  it('lists confirmed workflows with aliases and whenToUse, not drafts', async () => {
    const t = `${Date.now()}`;
    slugs.push(`cat-c-${t}`, `cat-d-${t}`);
    await prisma.workflow.create({
      data: { slug: `cat-c-${t}`, name: `目录测试 ${t}`, status: 'confirmed', confirmedVersion: 1, aliases: ['attendee 挖联系方式'], whenToUse: '活动名单补联系方式' },
    });
    await prisma.workflow.create({ data: { slug: `cat-d-${t}`, name: `草稿测试 ${t}`, status: 'draft' } });
    const text = (await sopCatalog()) ?? '';
    expect(text).toContain(`目录测试 ${t}`);
    expect(text).toContain('attendee 挖联系方式');
    expect(text).toContain('活动名单补联系方式');
    expect(text).not.toContain(`草稿测试 ${t}`);
  });
});
