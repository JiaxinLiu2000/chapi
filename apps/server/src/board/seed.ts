import type { ScheduleSpec } from '@chapi/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';

const log = createLogger('board-seed');

/** Earliest user message of the newest non-deleted session whose title contains `needle`. */
async function promptFromHistory(db: Prisma.TransactionClient, needle: string): Promise<string | null> {
  const s = await db.session.findFirst({
    where: { title: { contains: needle }, status: { not: 'deleted' } },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  if (!s) return null;
  const m = await db.message.findFirst({
    where: { sessionId: s.id, role: 'user', NOT: { text: '' } },
    orderBy: { createdAt: 'asc' },
    select: { text: true },
  });
  return m?.text.trim() || null;
}

/** Bind an SOP only when it exists and is confirmed; otherwise fall back to a runnable prompt. */
async function bindSop(db: Prisma.TransactionClient, slug: string): Promise<{ workflowId: string | null; prompt: string | null }> {
  const w = await db.workflow.findUnique({ where: { slug }, select: { id: true, status: true, confirmedVersion: true } });
  if (w && w.status === 'confirmed' && w.confirmedVersion) return { workflowId: w.id, prompt: null };
  return { workflowId: null, prompt: `按 SOP ${slug} 执行` };
}

/** One-time marker (Setting row): once written, the starter tasks are never inserted again. */
export const SEEDED_KEY = 'board.seeded';

/**
 * Insert the 6 starter tasks once per install: only when the marker is absent AND the
 * Automation table is empty (a populated table just gets the marker). The marker is
 * written in the same transaction, so deleting every task later never brings them back.
 * All start manual.
 */
export async function seedAutomations(client?: Prisma.TransactionClient): Promise<number> {
  if (client) return seedWith(client);
  return prisma.$transaction((tx) => seedWith(tx), { timeout: 30_000 });
}

async function seedWith(db: Prisma.TransactionClient): Promise<number> {
  if (await db.setting.findUnique({ where: { key: SEEDED_KEY }, select: { key: true } })) return 0;
  const mark = () =>
    db.setting.upsert({
      where: { key: SEEDED_KEY },
      update: {},
      create: { key: SEEDED_KEY, value: new Date().toISOString(), encrypted: false },
    });
  if ((await db.automation.count()) > 0) {
    await mark();
    return 0;
  }
  const model = (await settings.getModels()).main;
  const eod = (await promptFromHistory(db, '每日总结')) ?? '总结我今天的工作，生成每日总结邮件和中文简版 update。';
  const sales = (await promptFromHistory(db, 'Sales周报')) ?? '生成本周 Sales 周报，包含回复率，并建好邮件草稿。';
  const tracker = await bindSop(db, 'tracker-weekly');
  const profiles = await bindSop(db, 'customer-profiles-weekly');
  const updates = await bindSop(db, 'tracker-updates-column');

  const rows: Array<{ name: string; schedule: ScheduleSpec; workflowId?: string | null; prompt?: string | null; inputs?: Record<string, string> }> = [
    { name: 'EOD 每日总结邮件', schedule: { kind: 'weekdays', time: '18:00' }, prompt: eod },
    { name: 'Sales 周报', schedule: { kind: 'weekly', time: '16:00', weekdays: [5] }, prompt: sales },
    { name: 'UP BD Project Tracker 周更', schedule: { kind: 'weekly', time: '10:00', weekdays: [3] }, ...tracker },
    { name: 'Customer Profiles 画像表', schedule: { kind: 'weekly', time: '10:00', weekdays: [1] }, ...profiles },
    {
      name: 'Tracker Updates 列',
      schedule: { kind: 'biweekly', time: '09:00', weekdays: [3], anchorDate: '2026-11-18' },
      ...updates,
      inputs: { column: '{MDYY} Updates' },
    },
    {
      name: '三表同步',
      schedule: { kind: 'weekly', time: '11:00', weekdays: [3] },
      prompt: '按三表同步规则，同步 UP BD Project Tracker、Customer Profiles 画像表、Contacts Workbook 三张表的最新进展，改表前先读当前内容，写入前给我审批。',
    },
  ];
  for (const r of rows) {
    await db.automation.create({
      data: {
        name: r.name,
        schedule: r.schedule as unknown as object,
        workflowId: r.workflowId ?? null,
        prompt: r.prompt ?? null,
        inputs: r.inputs ?? undefined,
        mode: 'manual',
        enabled: true,
        model,
        effort: 'high',
      },
    });
  }
  await mark();
  log.info(`seeded ${rows.length} automations`);
  return rows.length;
}
