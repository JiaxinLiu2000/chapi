/**
 * The /board page (today columns, projects, automations) rendered for a Discord
 * channel / thread. Pure: the bridge fetches data and handles the clicks.
 */
import type { AutomationDTO, AutomationRunDTO, BoardSessionCard, BoardTodayDTO, ProjectDTO, SessionDTO } from '@chapi/shared';
import { describeSchedule } from '../board/schedule.js';
import { toPlainText } from '../remote/format.js';
import type { Btn, OutPayload, SelectMenu } from './bridge.js';

const MAX_MSG = 1900;

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 'M/D HH:mm' Pacific time (the board's clock). */
export function ptShort(iso: string | Date | null): string {
  if (!iso) return '—';
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}

export const RUN_STATUS_LABEL: Record<AutomationRunDTO['status'], string> = {
  queued: '排队中',
  running: '运行中',
  waiting_user: '等你处理',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  stale: '已过期待处理',
};
const RUN_ICON: Record<AutomationRunDTO['status'], string> = {
  queued: '⏳',
  running: '🔵',
  waiting_user: '🟠',
  done: '✅',
  failed: '❌',
  skipped: '⏭️',
  stale: '⚠️',
};
const TRIGGER_LABEL: Record<AutomationRunDTO['trigger'], string> = { manual: '手动', cron: '定时', catchup: '补跑', history: '历史会话' };

/** A "jump to this conversation" dropdown (reuses the bridge's `resume` handler). */
function resumeSelect(cards: Array<{ id: string; title: string; note: string }>, placeholder: string): SelectMenu[] | undefined {
  if (!cards.length) return undefined;
  return [{ id: 'resume', placeholder, options: cards.slice(0, 25).map((c) => ({ value: c.id, label: clip(c.title || '(无标题)', 95), description: clip(c.note, 95) })) }];
}

function cardLine(c: BoardSessionCard, connected: Set<string>): string {
  const wait = c.waitingKind === 'question' ? '等你回答' : c.waitingKind === 'approval' ? '等你审批' : c.stale ? '自动化已过期' : c.automationRunId ? '自动化等你处理' : '';
  const bits = [c.projectName ? `〔${clip(c.projectName, 14)}〕` : '', wait ? `· ${wait}` : '', c.progress ? `· ${clip(toPlainText(c.progress), 40)}` : ''];
  return `- ${connected.has(c.id) ? '🧵 ' : ''}${clip(c.title, 40)} ${bits.filter(Boolean).join(' ')}`.trimEnd();
}

/** Today: waiting on you / running / done — same three columns as the board page. */
export function renderToday(today: BoardTodayDTO, connected: Set<string>): OutPayload {
  const lines = ['📋 **今天的看板**'];
  const section = (icon: string, name: string, cards: BoardSessionCard[], max: number) => {
    lines.push('', `${icon} **${name}**（${cards.length}）`);
    if (!cards.length) lines.push('_无_');
    for (const c of cards.slice(0, max)) lines.push(cardLine(c, connected));
    if (cards.length > max) lines.push(`_…还有 ${cards.length - max} 个_`);
  };
  section('🟠', '等你', today.waiting, 10);
  section('🔵', '运行中', today.running, 10);
  section('✅', '今天完成', today.done, 8);
  const pick = [...today.waiting, ...today.running, ...today.done].map((c) => ({
    id: c.id,
    title: c.title,
    note: `${today.waiting.includes(c) ? '等你' : today.running.includes(c) ? '运行中' : '已完成'}${c.projectName ? ` · ${c.projectName}` : ''}${connected.has(c.id) ? ' · 已连接' : ''}`,
  }));
  return { content: clip(lines.join('\n'), MAX_MSG), selects: resumeSelect(pick, '打开某个任务（在这里开子话题）…') };
}

export function renderProjects(projects: ProjectDTO[], unassigned: number): OutPayload {
  if (!projects.length) return { content: '还没有项目。对话会由 AI 自动归类到项目里（电脑上的「看板」页可以手动整理）。' };
  const lines = ['🗂 **项目**'];
  for (const p of projects) {
    lines.push(`- **${clip(p.name, 30)}** · ${p.sessionCount} 个对话${p.lastActivityAt ? ` · 最近 ${ptShort(p.lastActivityAt)}` : ''}`);
    if (p.summary) lines.push(`  ${clip(toPlainText(p.summary), 90)}`);
  }
  if (unassigned) lines.push(`- _未归类_ · ${unassigned} 个对话`);
  const options = [
    ...projects.slice(0, 24).map((p) => ({ value: p.id, label: clip(p.name, 95), description: `${p.sessionCount} 个对话` })),
    ...(unassigned ? [{ value: 'unassigned', label: '未归类', description: `${unassigned} 个对话` }] : []),
  ].slice(0, 25);
  return { content: clip(lines.join('\n'), MAX_MSG), selects: [{ id: 'proj', placeholder: '看某个项目里的对话…', options }] };
}

export function renderProjectSessions(name: string, summary: string | null, sessions: SessionDTO[], connected: Set<string>): OutPayload {
  const lines = [`🗂 **${clip(name, 50)}** · ${sessions.length} 个对话`];
  if (summary) lines.push(`_${clip(toPlainText(summary), 300)}_`);
  for (const s of sessions.slice(0, 15)) lines.push(`- ${connected.has(s.id) ? '🧵 ' : ''}${clip(s.title, 50)}${s.status === 'completed' ? ' · 已归档' : ''}`);
  if (sessions.length > 15) lines.push(`_…还有 ${sessions.length - 15} 个_`);
  return {
    content: clip(lines.join('\n'), MAX_MSG),
    selects: resumeSelect(
      sessions.map((s) => ({ id: s.id, title: s.title, note: `${s.status === 'completed' ? '已归档（只读）· ' : ''}${ptShort(s.updatedAt)}${connected.has(s.id) ? ' · 已连接' : ''}` })),
      '接着做其中一个对话…',
    ),
  };
}

/** "Move this task to project …" for a thread. */
export function renderProjectPicker(sessionId: string, current: string | null, projects: ProjectDTO[]): OutPayload {
  return {
    content: `🗂 这个任务现在在：**${current ?? '未归类'}**。选一个项目改过去（你手动选的，AI 之后不会再改）。`,
    selects: [
      {
        id: `projset:${sessionId}`,
        placeholder: '移到项目…',
        options: [
          ...projects.slice(0, 24).map((p) => ({ value: p.id, label: clip(p.name, 95), default: p.name === current })),
          { value: 'none', label: '（不归类）' },
        ].slice(0, 25),
      },
    ],
  };
}

function modeText(a: AutomationDTO): string {
  return a.mode === 'auto' ? '自动' : '手动';
}

export function renderAutomations(list: AutomationDTO[]): OutPayload {
  if (!list.length) return { content: '还没有自动化任务。在任何子话题里跟 chapi 说「把 XX 设成每周三 10 点的定时任务」就能建。' };
  const lines = ['⏰ **自动化任务**'];
  for (const a of list) {
    const last = a.lastRun ? `${RUN_ICON[a.lastRun.status]}${RUN_STATUS_LABEL[a.lastRun.status]}` : '还没跑过';
    const open = a.openRuns.filter((r) => r.status === 'waiting_user' || r.status === 'stale').length;
    lines.push(
      `- ${a.enabled ? '' : '⏸ '}**${clip(a.name, 30)}** · ${describeSchedule(a.schedule)} · ${modeText(a)}${a.enabled && a.nextRunAt && a.mode === 'auto' ? ` · 下次 ${ptShort(a.nextRunAt)}` : ''} · 上次 ${last}${open ? ` · 🟠 ${open} 次待处理` : ''}`,
    );
  }
  lines.push('', '_手动 = 到点提醒你点「运行」；自动 = 到点自己跑（需要已确认的 SOP）。改时间/新建：在子话题里直接跟 chapi 说。_');
  return {
    content: clip(lines.join('\n'), MAX_MSG),
    selects: [
      {
        id: 'auto',
        placeholder: '打开某个自动化（运行 / 改模式 / 停用）…',
        options: list.slice(0, 25).map((a) => ({ value: a.id, label: clip(a.name, 95), description: clip(`${describeSchedule(a.schedule)} · ${modeText(a)}${a.enabled ? '' : ' · 已停用'}`, 95) })),
      },
    ],
  };
}

/** One automation with its controls (the web's automation row + editor toggles). */
export function renderAutomation(a: AutomationDTO, note?: string): OutPayload {
  const lines = [`⏰ **${clip(a.name, 60)}**${note ? `　${note}` : ''}`];
  lines.push(`${describeSchedule(a.schedule)} · ${modeText(a)} · ${a.enabled ? '启用中' : '⏸ 已停用'}${a.mode === 'auto' && a.enabled && a.nextRunAt ? ` · 下次 ${ptShort(a.nextRunAt)}` : ''}`);
  lines.push(a.workflowSlug ? `SOP：${a.workflowName ?? a.workflowSlug}${a.workflowConfirmed ? '' : '（还没确认，不能设成自动）'}` : `固定指令：${clip(toPlainText(a.prompt ?? ''), 120) || '（空）'}`);
  if (a.lastRun) {
    lines.push(`上次：${RUN_ICON[a.lastRun.status]} ${RUN_STATUS_LABEL[a.lastRun.status]} · ${TRIGGER_LABEL[a.lastRun.trigger]} · ${ptShort(a.lastRun.startedAt)}${a.lastRun.note ? ` · ${clip(a.lastRun.note, 60)}` : ''}`);
  }
  const open = a.openRuns.filter((r) => r.status === 'waiting_user' || r.status === 'stale');
  for (const r of open.slice(0, 3)) lines.push(`🟠 ${ptShort(r.startedAt)} 那次${RUN_STATUS_LABEL[r.status]}${r.note ? `：${clip(r.note, 60)}` : ''}`);

  const row1: Btn[] = [
    { id: `autorun:${a.id}`, label: '▶ 立即运行', style: 'primary', disabled: !a.enabled },
    { id: `automode:${a.id}`, label: a.mode === 'auto' ? '改成手动' : '改成自动', style: 'secondary', disabled: a.mode === 'manual' && !(a.workflowSlug && a.workflowConfirmed) },
    { id: `autoen:${a.id}`, label: a.enabled ? '⏸ 停用' : '启用', style: a.enabled ? 'secondary' : 'success' },
  ];
  const row2: Btn[] = [];
  if (a.lastRun?.sessionId) row2.push({ id: `autoopen:${a.lastRun.sessionId}`, label: '🧵 打开最近一次', style: 'secondary' });
  for (const r of open.slice(0, 3)) row2.push({ id: `autodis:${r.id}`, label: `关闭 ${ptShort(r.startedAt)} 那次`, style: 'danger' });
  return { content: clip(lines.join('\n'), MAX_MSG), buttons: row2.length ? [row1, row2] : [row1] };
}

/** The channel ping when a manual automation's slot comes. */
export function renderReminder(a: AutomationDTO, slot: Date): OutPayload {
  return {
    content: `⏰ **到点了：${clip(a.name, 60)}**（${describeSchedule(a.schedule)}，${ptShort(slot)}）\n手动模式的任务，点「▶ 现在运行」就会新开一个任务开始跑，结果发在它的子话题里。`,
    buttons: [[
      { id: `autorun:${a.id}`, label: '▶ 现在运行', style: 'primary' },
      { id: 'cancel', label: '这次不跑', style: 'secondary' },
    ]],
  };
}
