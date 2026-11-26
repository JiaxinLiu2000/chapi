/**
 * AI tools for the /board automation registry (spec 2026-11-25 §2). Registered on the
 * chapi MCP server next to the workflow tools. Tiers:
 *  - list / upsert / link_history / set_mode→manual: direct
 *  - set_mode→auto, delete, run_now: an in-chat confirmation card (hitl approval)
 * All writes go through board/service.ts (same validation as the REST routes).
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AutomationDTO } from '@chapi/shared';
import { config } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { emitAttention } from '../engine/attention.js';
import { hitl } from '../engine/hitl.js';
import { findWorkflowRef } from '../workflow/drafts.js';
import { describeSchedule } from './schedule.js';
import {
  automationDTOs,
  createAutomation,
  deleteAutomation,
  findAutomation,
  linkHistory,
  runNow,
  setMode,
  updateAutomation,
} from './service.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export const BOARD_TOOL_NAMES = [
  'mcp__chapi__automation_list',
  'mcp__chapi__automation_upsert',
  'mcp__chapi__automation_link_history',
  'mcp__chapi__automation_set_mode',
  'mcp__chapi__automation_delete',
  'mcp__chapi__automation_run_now',
];

const TRIGGER_LABEL: Record<string, string> = { manual: '手动', cron: '定时', catchup: '补跑', history: '历史会话' };
const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  waiting_user: '等你处理',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  stale: '已过期待处理',
};

/** 'M/D HH:mm' in PT. */
function ptShort(iso: string | null): string {
  if (!iso) return '—';
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}

function sopText(a: AutomationDTO): string {
  if (!a.workflowSlug) return '无（固定 prompt）';
  return `${a.workflowSlug}（${a.workflowConfirmed ? '已确认' : '草稿，确认前不能自动/运行'}）`;
}

function describeAutomation(a: AutomationDTO, i?: number): string {
  const last = a.lastRun
    ? `${ptShort(a.lastRun.startedAt)} ${TRIGGER_LABEL[a.lastRun.trigger] ?? a.lastRun.trigger}·${STATUS_LABEL[a.lastRun.status] ?? a.lastRun.status}${a.lastRun.sessionSlug ? `（会话 /s/${a.lastRun.sessionSlug}）` : ''}`
    : '从未运行';
  const lines = [
    `${i !== undefined ? `${i + 1}. ` : ''}「${a.name}」 id=${a.id}`,
    `   频率：${describeSchedule(a.schedule)}（PT） · SOP：${sopText(a)} · ${a.mode === 'auto' ? '自动' : '手动'} · ${a.enabled ? '启用' : '停用'}`,
    `   上次：${last} · 下次：${a.mode === 'auto' && a.enabled ? ptShort(a.nextRunAt) : '（手动，不自动运行）'} · 未完成运行：${a.openRuns.length}`,
  ];
  if (a.inputs && Object.keys(a.inputs).length) lines.push(`   参数：${JSON.stringify(a.inputs)}`);
  if (a.prompt) lines.push(`   prompt：${a.prompt.replace(/\s+/g, ' ').slice(0, 120)}${a.prompt.length > 120 ? '…' : ''}`);
  lines.push(`   模型：${a.model} · 思考强度：${a.effort}${a.projectId ? ` · 项目 ${a.projectId}` : ''}`);
  return lines.join('\n');
}

const scheduleSchema = z
  .object({
    kind: z.enum(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly']),
    time: z.string().describe('PT 时间 HH:mm'),
    weekdays: z.array(z.number().int()).optional().describe('weekly/biweekly：0=周日 … 6=周六'),
    anchorDate: z.string().optional().describe('biweekly：某一次运行所在周的日期 YYYY-MM-DD'),
    dayOfMonth: z.number().int().optional().describe('monthly 单日（旧写法）'),
    daysOfMonth: z.array(z.number().int()).optional().describe('monthly 多日，如 [10,25]；超过月底按月底'),
  })
  .describe('频率（PT）');

/** Workflow ref (slug / name / alias) → slug for the service; unknown refs pass through so the service rejects them. */
async function workflowSlugOf(ref: string): Promise<string> {
  const w = await findWorkflowRef(ref);
  return w?.slug ?? ref;
}

/** Board tools for one session (closure-bound like the rest of chapiTools). */
export function buildBoardTools(sessionId: string) {
  /** Pop a confirmation card in this chat and wait for the user's decision. */
  async function confirmCard(title: string, a: AutomationDTO, action: string): Promise<{ ok: true } | { ok: false; msg: string }> {
    const summary = [title, `任务：「${a.name}」`, `频率：${describeSchedule(a.schedule)}（PT）`, `SOP：${sopText(a)}`, `将会：${action}`].join('\n');
    const artifacts = [
      { id: `board-${a.id}`, sessionId, kind: 'doc' as const, title: '在自动化面板查看', pathOrUrl: `http://127.0.0.1:${config.webPort}/board`, createdAt: new Date().toISOString() },
    ];
    const approval = await prisma.approval.create({ data: { sessionId, summary, artifacts: artifacts as unknown as object, status: 'open' } });
    bus.emit({
      type: 'approval.request',
      sessionId,
      approval: { id: approval.id, sessionId, summary, artifacts, status: 'open', feedback: null, createdAt: approval.createdAt.toISOString() },
    });
    void emitAttention(sessionId, 'approval', `${title}「${a.name}」`);
    const d = await hitl.waitForApproval(approval.id, sessionId);
    if (d.decision === 'approve') return { ok: true };
    return { ok: false, msg: `用户没有同意（${d.decision}）：${d.feedback?.trim() || '没有留言'}。没有做任何改动。` };
  }

  async function load(ref: string): Promise<AutomationDTO | string> {
    const row = await findAutomation(ref);
    if (!row) return `找不到自动化任务「${ref}」。先用 automation_list 查看任务名和 id。`;
    const [dto] = await automationDTOs({ id: row.id });
    return dto ?? `找不到自动化任务「${ref}」。`;
  }

  const list = tool(
    'automation_list',
    '列出自动化面板（/board）里登记的所有定时任务：频率（PT）、绑定的 SOP、手动/自动、是否启用、上次运行（会话）、下次运行、未完成的运行。用户问"有哪些自动化/定时任务""某任务多久跑一次"时用。',
    {},
    async () => {
      const all = await automationDTOs();
      if (all.length === 0) return text('自动化面板里还没有任务。');
      return text(`共 ${all.length} 个任务：\n${all.map((a, i) => describeAutomation(a, i)).join('\n')}`);
    },
  );

  const upsert = tool(
    'automation_upsert',
    '新建或修改自动化面板里的一个任务（名称/频率/SOP 绑定/固定 prompt/参数/模型/思考强度/项目/启用）。传 automation（任务名或 id）= 修改，不传 = 新建。' +
      '**不能改手动/自动**：新建的任务一律是手动；已是自动的任务改完仍是自动。要切换请用 automation_set_mode；自动任务的重新启用、改绑 SOP 也必须先改回手动。' +
      '参数值和固定 prompt 里都可用占位符 {today} {yesterday} {prevWorkday} {MD} {MDYY} {weekStart} {weekEnd} {weekFri}（本周五）（PT）。',
    {
      automation: z.string().optional().describe('要修改的任务名或 id；新建时不传'),
      name: z.string().optional().describe('任务名（新建必填，1–60 字）'),
      schedule: scheduleSchema.optional(),
      workflow: z.string().nullable().optional().describe('绑定的 SOP（slug/名称/别名）；null = 解绑'),
      prompt: z.string().nullable().optional().describe('没绑 SOP 时运行用的固定 prompt'),
      inputs: z.record(z.string()).nullable().optional().describe('SOP 输入参数 名称→文字（可含占位符）'),
      model: z.string().optional(),
      effort: z.string().optional().describe('low / medium / high / xhigh / max'),
      projectId: z.string().nullable().optional().describe('固定归到的项目 id；null = 不固定'),
      enabled: z.boolean().optional(),
      mode: z.unknown().optional().describe('不要传：手动/自动只能用 automation_set_mode 改'),
    },
    async (args) => {
      if (args.mode !== undefined) return text('automation_upsert 不能改手动/自动。请用 automation_set_mode（切到自动需要用户在对话里确认）。');
      const body: Record<string, unknown> = {};
      for (const k of ['name', 'schedule', 'prompt', 'inputs', 'model', 'effort', 'projectId', 'enabled'] as const) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      if (args.workflow !== undefined) body.workflowSlug = args.workflow === null ? null : await workflowSlugOf(args.workflow);
      if (args.automation) {
        const row = await findAutomation(args.automation);
        if (!row) return text(`找不到自动化任务「${args.automation}」。先用 automation_list 查看任务名和 id。`);
        if (row.mode === 'auto') {
          // On a live auto task these change what runs unattended: only via the set_mode card.
          const reEnable = body.enabled === true && !row.enabled;
          let rebind = false;
          if (body.workflowSlug === null) rebind = row.workflowId !== null;
          else if (typeof body.workflowSlug === 'string') {
            const w = await prisma.workflow.findUnique({ where: { slug: body.workflowSlug }, select: { id: true } });
            rebind = !!w && w.id !== row.workflowId;
          }
          if (reEnable || rebind) {
            return text(
              `「${row.name}」是自动任务，${reEnable ? '重新启用' : '改绑 SOP'}会直接改变无人值守的运行，不能用 automation_upsert 做。` +
                '请先用 automation_set_mode 改成手动，改好后再用 automation_set_mode 切回自动（会在对话里请用户确认）。',
            );
          }
        }
        const r = await updateAutomation(row.id, body);
        return text(r.ok ? `已修改：\n${describeAutomation(r.value)}` : `没有保存：${r.error}`);
      }
      const r = await createAutomation({ ...body, mode: 'manual' });
      return text(r.ok ? `已新建（手动）：\n${describeAutomation(r.value)}\n要自动运行请用 automation_set_mode，用户确认后生效。` : `没有保存：${r.error}`);
    },
  );

  const link = tool(
    'automation_link_history',
    '把过去做过这项任务的会话登记为它的历史运行（面板上显示为「历史会话」，并更新"上次运行"）。同一会话被反复用于不同日期时，每个日期传一条并写 date。重复登记会被忽略。',
    {
      automation: z.string().describe('任务名或 id'),
      sessions: z
        .array(z.object({ session: z.string().describe('会话 id 或 slug'), date: z.string().optional().describe('那次运行的 PT 日期 YYYY-MM-DD') }))
        .min(1),
    },
    async (args) => {
      const row = await findAutomation(args.automation);
      if (!row) return text(`找不到自动化任务「${args.automation}」。`);
      const r = await linkHistory(row.id, args.sessions);
      if (!r.ok) return text(r.error);
      const label = { linked: '已登记', duplicate: '已存在，忽略', skipped: '跳过' } as const;
      return text(
        `「${row.name}」历史会话：\n${r.value
          .map((o) => `- ${o.sessionSlug ?? o.session}${o.date ? ` @${o.date}` : ''}：${label[o.result]}${o.reason ? `（${o.reason}）` : ''}`)
          .join('\n')}`,
      );
    },
  );

  const mode = tool(
    'automation_set_mode',
    '切换任务的手动/自动。切到手动立即生效；切到自动要求已绑定**已确认**的 SOP，并会在对话里弹出确认卡片，用户同意后才生效（从此按频率自动运行，不补跑以前的时刻）。',
    {
      automation: z.string().describe('任务名或 id'),
      mode: z.enum(['manual', 'auto']),
    },
    async (args) => {
      const a = await load(args.automation);
      if (typeof a === 'string') return text(a);
      if (a.mode === args.mode) return text(`「${a.name}」已经是${args.mode === 'auto' ? '自动' : '手动'}。`);
      if (args.mode === 'manual') {
        const r = await setMode(a.id, 'manual');
        return text(r.ok ? `「${a.name}」已改为手动，不再自动运行。` : r.error);
      }
      if (!a.workflowSlug || !a.workflowConfirmed) return text(`不能设成自动：先整理成 SOP，并在 /workflows 确认后，才能设成自动。（当前 SOP：${sopText(a)}）`);
      if (!a.enabled) return text(`「${a.name}」处于停用状态，先用 automation_upsert 启用再设成自动。`);
      const c = await confirmCard('把定时任务设成自动运行', a, `从现在起按「${describeSchedule(a.schedule)}」（PT）自动按 SOP 运行；不会补跑之前已过的时刻。`);
      if (!c.ok) return text(c.msg);
      const r = await setMode(a.id, 'auto');
      return text(r.ok ? `用户已同意，「${a.name}」已设成自动，下次运行：${ptShort(r.value.nextRunAt)}（PT）。` : `设置失败：${r.error}`);
    },
  );

  const del = tool(
    'automation_delete',
    '删除自动化面板里的一个任务（连同它的运行记录；会话本身保留）。会在对话里弹出确认卡片，用户同意后才删除。',
    { automation: z.string().describe('任务名或 id') },
    async (args) => {
      const a = await load(args.automation);
      if (typeof a === 'string') return text(a);
      const c = await confirmCard('删除定时任务', a, '从自动化面板删除这个任务和它的运行记录（相关会话保留），之后不会再运行。');
      if (!c.ok) return text(c.msg);
      const r = await deleteAutomation(a.id);
      return text(r.ok ? `用户已同意，「${a.name}」已删除。` : `删除失败：${r.error}`);
    },
  );

  const run = tool(
    'automation_run_now',
    '立即手动运行一个任务（在新会话里按 SOP 或固定 prompt 开始）。会在对话里弹出确认卡片，用户同意后才启动。不能在该任务自己的运行会话里调用。',
    { automation: z.string().describe('任务名或 id') },
    async (args) => {
      const a = await load(args.automation);
      if (typeof a === 'string') return text(a);
      const self = await prisma.automationRun.findFirst({ where: { automationId: a.id, sessionId, trigger: { not: 'history' } }, select: { id: true } });
      if (self) return text(`拒绝：当前会话就是「${a.name}」的一次运行，不能在这里再启动它（会形成循环）。`);
      const c = await confirmCard('立即运行定时任务', a, `新开一个会话，马上${a.workflowSlug ? `按 SOP ${a.workflowSlug}` : '按固定 prompt'}运行一次。`);
      if (!c.ok) return text(c.msg);
      const r = await runNow(a.id);
      if (r.ok) return text(`用户已同意，「${a.name}」已启动${r.run.sessionSlug ? `：会话 /s/${r.run.sessionSlug}` : '（排队中）'}。`);
      return text(`没有启动：${r.error}${r.sessionSlug ? `（上一次运行：/s/${r.sessionSlug}）` : ''}`);
    },
  );

  return [list, upsert, link, mode, del, run];
}
