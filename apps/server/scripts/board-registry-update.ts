/**
 * Bring the /board automation registry in line with the user's 11/25 decisions
 * (docs/superpowers/specs/2026-11-25-board-ai-tools-and-registry-update-design.md §4):
 * frequencies, SOP bindings, parameters, 5 new tasks, and past sessions linked as
 * 「历史会话」 runs (from .superpowers/recurring-tasks.md).
 *
 *   DATABASE_URL=... npx tsx scripts/board-registry-update.ts [--dry] [--live]
 *
 * - Idempotent: tasks are matched by name (RENAMES maps older names); unchanged fields
 *   are not written; duplicate history links are ignored.
 * - Everything goes through board/service.ts (same validation as the routes / AI tools).
 * - Never sets mode: every task stays as it is (new ones are manual).
 * - Degrades gracefully: a missing SOP → prompt fallback; a missing session → skipped.
 * - Refuses the live DB (port 3307) unless --live is passed, and --live only from the
 *   live repo (C:/Users/tygac/Downloads/chapi), so the Onboarding memory path is right.
 * - SOPs are bound only when confirmed (a draft binding blocks even manual runs); a task
 *   bound to its target SOP while that SOP is still a draft is unbound.
 * - Some prompts are forced (EOD day, Sales 周报, QuickBooks, Onboarding path) and
 *   rewritten whenever they differ; the rest are only filled in when missing.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { Automation } from '@prisma/client';
import type { ScheduleSpec } from '@chapi/shared';
import { REPO_ROOT, sessionPaths } from '../src/config.js';
import { prisma } from '../src/db/client.js';
import { createAutomation, findAutomation, linkHistory, updateAutomation, type HistoryLink } from '../src/board/service.js';
import { describeSchedule } from '../src/board/schedule.js';
import { sameSchedule } from '../src/board/validate.js';

const DRY = process.argv.includes('--dry');
const LIVE = process.argv.includes('--live');
const dbUrl = process.env.DATABASE_URL ?? '';
if (/:3307\b/.test(dbUrl) && !LIVE) {
  console.error('Refusing to run against the live DB (port 3307) without --live.');
  process.exit(1);
}
const LIVE_REPO = 'C:/Users/tygac/Downloads/chapi';
const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
if (LIVE && norm(REPO_ROOT) !== norm(LIVE_REPO)) {
  console.error(`--live must run from the live repo ${LIVE_REPO} (this repo: ${REPO_ROOT}).`);
  process.exit(1);
}
console.log(`DB: ${dbUrl.replace(/\/\/[^@]*@/, '//***@')}${DRY ? '  [DRY RUN — nothing is written]' : ''}`);

// ── source data ─────────────────────────────────────────────────────────────

const QB_SESSION = 'cmwvues89000cql2g10jwn3tq';
const ONBOARDING_SESSION = 'cmvslzsbk01hsql50skwbdkk6';
const INVESTOR_TITLE = '投资人双周汇报';

/** Older task names that should be renamed to the current one. */
const RENAMES: Record<string, string[]> = {
  'EOD 每日总结邮件': ['EOD 每日总结', '每日总结邮件'],
  'Sales 周报': ['Sales周报', 'UP BD Weekly Report'],
  'UP BD Project Tracker 周更': ['Project Tracker 周更'],
  'Customer Profiles 画像表': ['画像表'],
};

async function firstUserMessage(where: { id?: string; titleContains?: string }): Promise<{ sessionId: string; text: string } | null> {
  const s = where.id
    ? await prisma.session.findUnique({ where: { id: where.id }, select: { id: true } })
    : await prisma.session.findFirst({ where: { title: { contains: where.titleContains! }, status: { not: 'deleted' } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!s) return null;
  const m = await prisma.message.findFirst({ where: { sessionId: s.id, role: 'user', NOT: { text: '' } }, orderBy: { createdAt: 'asc' }, select: { text: true } });
  return m?.text.trim() ? { sessionId: s.id, text: m.text.trim() } : null;
}

const quote = (t: string) => `「${t}」`;

async function investorPrompt(): Promise<{ prompt: string; source: string }> {
  const m = await firstUserMessage({ titleContains: INVESTOR_TITLE });
  const head = '投资人双周汇报邮件（每两周周四）。按本期最新数据准备给投资人的 biweekly 汇报邮件内容；以下是第一次（11/5）的需求原话，照同样的结构更新本期进展：';
  if (m) return { prompt: `${head}\n\n${quote(m.text)}`, source: `session ${m.sessionId} 首条消息` };
  return {
    prompt: `${head}\n\n${quote('准备一个之前给投资人biweekly汇报的邮件的内容，更新进展，比如这两周打了多少电话，邮件发送，约的meeting。还有上次的那些的to do list的progress。')}`,
    source: '找不到会话，用内置摘要',
  };
}

/** From .superpowers/recurring-tasks.md §9 (not the session's first message, which asks to *create* an SOP). */
const QUICKBOOKS_PROMPT =
  'QuickBooks 发票核对（每周一、三、五）：执行一次核对。SOP 还在整理中，不要新建 SOP 或定时任务。\n\n' +
  '1. 只读 QuickBooks Online（在 cloakbrowser 里用已登录的 QBO；没登录就停下用 ask_user 请我登录），不改 QBO 里的任何东西。\n' +
  '2. 找出已经开票、但还不在 Bill & AR Tracker 里的发票，按类型写进 Quickbook Marketing / Quickbook Leasing 页签；其它前缀按 Type 新建页签。\n' +
  '3. 已收款的发票在 "Paid?" 列填 Yes。\n' +
  '4. Executing Contracts 表里对应合同当月的格子：已开票标 light yellow 3，已收款标 light green 3。\n' +
  '改表前先读当前内容，按实际格式写；写完给我审批摘要。';

function onboardingPrompt(): { prompt: string; source: string } {
  const memFile = path.join(sessionPaths(ONBOARDING_SESSION).memory, 'onboarding_ai_review.md');
  const exists = fs.existsSync(memFile);
  return {
    prompt:
      `Onboarding AI review：按 ${memFile} 执行（会话「On Boarding Tracker 每小时同步」的 memory 文件）。` +
      '先看 UP Client Onboarding Tracker 的 Log 页，早上 6 点的同步有没有报错；再按文件里的步骤更新 Tracker 的 AI Progress 和 Checklist 的 AI Review。\n\n' +
      `原来每天的定时指令：${quote('Onboarding AI review: follow memory/onboarding_ai_review.md')}；` +
      `其中一次的完整写法：${quote('Onboarding AI review: follow memory/onboarding_ai_review.md - check the Log for errors, then re-read the refreshed forward stubs (listed in the memory file) and update Tracker AI Progress (col W), Request Sent (col J) where a forward proves the date, and Checklist AI Review (col M)')}`,
    source: `session ${ONBOARDING_SESSION} 的 [定时任务] 消息；memory 文件${exists ? '存在' : '在本机不存在（运行前确认路径）'}`,
  };
}

// ── target registry (§4) ────────────────────────────────────────────────────

interface Target {
  name: string;
  schedule: ScheduleSpec;
  /** SOP slug to bind. */
  sop?: string;
  inputs?: Record<string, string> | null;
  /** Prompt used when the task has none yet (new task, or SOP missing). */
  prompt?: () => Promise<{ prompt: string; source: string }> | { prompt: string; source: string };
  /** Forced prompt, computed from the current one; written whenever it differs. */
  forcePrompt?: (cur: string | null) => { prompt: string; source: string };
  history: HistoryLink[];
}

const d = (session: string, ...dates: string[]): HistoryLink[] => dates.map((date) => ({ session, date: `2026-${date}` }));
const fixed = (prompt: string) => () => ({ prompt, source: '内置' });

/** EOD: keep the user's own prompt (Task List link, formatting asks); only the day changes. */
const EOD_DAY = '{prevWorkday}（上一个工作日，周一则为上周五）';
const EOD_DEFAULT =
  'https://docs.google.com/spreadsheets/d/1QvRdwdjoujYnlpkG_0AizBpi2TEoZe7KaT3qbF1mmaY/edit?usp=sharing 这个表格是我的工作表格，其中Task List这个tab是我每天的任务。' +
  '帮我写今天的总结，整理成邮件，多用bullet point，放上任务描述，next step（如果我有写的话），和项目链接作为hyperlink到文字中';
function eodPrompt(cur: string | null): { prompt: string; source: string } {
  const base = cur?.trim() || EOD_DEFAULT;
  if (base.includes('{prevWorkday}')) return { prompt: base, source: '已是上一个工作日' };
  const i = base.indexOf('今天');
  if (i >= 0) return { prompt: `${base.slice(0, i)}${EOD_DAY}${base.slice(i + 2)}`, source: '原 prompt，只把「今天」换成上一个工作日' };
  return { prompt: `${base}\n\n总结的是 ${EOD_DAY}的工作。`, source: '原 prompt + 上一个工作日' };
}

/** Sales 周报: memory project_weekly_sales_report.md + the user's answers in the sales-weekly SOP draft. */
const SALES_PROMPT = [
  '生成本周（本周一 {weekStart} 至本周五 {weekFri}，PT）的 UP BD Weekly Report（Sales 冷电话 / 邮件周报）。',
  '- 格式：和 10/16 原邮件完全一致（样式模板：会话 cmvvq2fg301axql34qksyx822 沙盘里的 weekly_report_email.py 和上次成品 UP_BD_Weekly_Report_2026-10-30.html），6 个部分不增不减，邮件用英文；和我沟通用中文。',
  '- Contacts Workbook：通过 Drive 重新导出 xlsx，按「Attempt N (YYYY-MM-DD)」统计本周每天的电话和邮件。',
  '- Sales hot leads：Raymond 周五发的笔记；用 chapi_slack.py 只读导出本周 Slack 私信找；都没有就用 ask_user 问我，不要从 Workbook 状态里自己挑人。Key contacts 只用 hot leads，保留原话。',
  '- GoTo 通话记录：不要等我上传，自己在 cloakbrowser 里打开 GoTo 管理后台拉取本周 user activity；登录过期就立刻停下，用 ask_user 请我登录，不要猜数据、不要用旧导出代替。',
  '- 回复率和 email 回复率都写成 分子 ÷ 分母；邮件回复数从 Sales 笔记里数，打开不算回复。',
  '- 永久不放：Data quality 小节；第 5 部分的 "Email Replied" 一行；第 6 部分的「Contacts to follow up next week」标题及表格。第 5、6 部分只写有来源的内容。',
  '- 在 jiaxin.liu@unitpulse.ai 建 Gmail 草稿：主题「UP BD Weekly Report」，收件人 lucas.yin@unitpulse.ai、raymond.fernandez@unitpulse.ai，include_signature=false。只建草稿，绝不发送；被替换的旧草稿移到垃圾箱。',
  '- 最后用 request_approval 提交审批，中文摘要写周期、核心数字（含各回复率的分子分母）、Key contacts、Sales 笔记与 Workbook 的不一致、待确认事项。',
].join('\n');

const TARGETS: Target[] = [
  {
    name: 'EOD 每日总结邮件',
    schedule: { kind: 'weekdays', time: '10:00' },
    sop: 'eod-daily',
    inputs: { date: '{prevWorkday}' },
    forcePrompt: eodPrompt,
    history: d('cmvr464gs05nkql14o4sfwtwn', '10-27', '11-02', '11-04', '11-05', '11-06', '11-18', '11-24'),
  },
  {
    name: 'Sales 周报',
    schedule: { kind: 'weekly', time: '19:30', weekdays: [5] },
    sop: 'sales-weekly',
    inputs: { weekStart: '{weekStart}', weekEnd: '{weekEnd}' },
    forcePrompt: () => ({ prompt: SALES_PROMPT, source: 'memory 周报说明 + sales-weekly SOP 草稿里用户的决定' }),
    history: [...d('cmvbojxs202j8qls4anvnv0c3', '10-16'), ...d('cmvvq2fg301axql34qksyx822', '10-30'), ...d('cmtsyj4m504dwqlgsm1drj672', '11-13')],
  },
  {
    name: 'UP BD Project Tracker 周更',
    schedule: { kind: 'weekly', time: '10:00', weekdays: [1] },
    sop: 'tracker-weekly',
    prompt: fixed('更新 UP BD Project Tracker：空白处填写并标黄，已有值只核对、不一致的列出来。'),
    history: d('cmvigvr8r0000qlssqafchp1j', '10-21', '11-05', '11-13', '11-16', '11-23'),
  },
  {
    name: 'Customer Profiles 画像表',
    schedule: { kind: 'weekly', time: '11:00', weekdays: [1] },
    sop: 'customer-profiles-weekly',
    prompt: fixed('刷新 Customer Profiles 画像表（通话录音 + sales 邮件），改表前先读当前内容。'),
    history: [...d('cmw2hu2r6000pql64wqssct6r', '11-04', '11-05'), ...d('cmvigvr8r0000qlssqafchp1j', '11-18', '11-23')],
  },
  {
    name: '三表同步',
    schedule: { kind: 'weekly', time: '13:00', weekdays: [1] },
    prompt: fixed('按三表同步规则，同步 UP BD Project Tracker、Customer Profiles 画像表、Contacts Workbook 三张表的最新进展，改表前先读当前内容，写入前给我审批。'),
    history: [...d('cmw3zxzor00cvqlvoil4ehibv', '11-05', '11-18'), ...d('cmvigvr8r0000qlssqafchp1j', '11-18', '11-23')],
  },
  {
    name: 'Tracker Updates 列',
    schedule: { kind: 'biweekly', time: '09:00', weekdays: [3], anchorDate: '2026-11-18' },
    sop: 'tracker-updates-column',
    inputs: { column: '{MDYY} Updates' },
    prompt: fixed('在 UP BD Project Tracker 新加「{MDYY} Updates」列，按 Notes 写最新进展。'),
    history: d('cmvigvr8r0000qlssqafchp1j', '11-19'),
  },
  {
    name: '投资人双周汇报邮件',
    schedule: { kind: 'biweekly', time: '10:00', weekdays: [4], anchorDate: '2026-11-19' },
    prompt: investorPrompt,
    history: d('cmw3zxzor00cvqlvoil4ehibv', '11-05', '11-19'),
  },
  {
    name: '房东佣金账单',
    schedule: { kind: 'monthly', time: '09:00', daysOfMonth: [10, 25] },
    sop: 'landlord-commission-billing',
    prompt: fixed('房东佣金账单：为上一个半月周期（1–15 号 / 16 号–月底）入住的租约按天折算佣金，生成分楼 invoice，并在房东佣金收款表新开这一期的 tab。'),
    history: d('cmwb2ii9z01zcqlc8qbalateo', '11-10', '11-24'),
  },
  {
    name: 'TPM Full Service 账单',
    schedule: { kind: 'monthly', time: '09:00', dayOfMonth: 1 },
    sop: 'tpm-full-service-billing',
    prompt: fixed('TPM Full Service 账单：为本月开整月服务费账单，放进「TPM <账期开始日 MM/DD/YYYY>」文件夹。'),
    history: d('cmwb2ii9z01zcqlc8qbalateo', '11-23'),
  },
  {
    name: 'QuickBooks 发票核对',
    schedule: { kind: 'weekly', time: '09:00', weekdays: [1, 3, 5] },
    forcePrompt: () => ({ prompt: QUICKBOOKS_PROMPT, source: 'recurring-tasks.md 的描述' }),
    history: [{ session: QB_SESSION }],
  },
  {
    name: 'Onboarding AI Review',
    schedule: { kind: 'daily', time: '09:00' },
    forcePrompt: () => onboardingPrompt(),
    history: d(ONBOARDING_SESSION, '10-30', '10-31', '11-01', '11-02', '11-03', '11-04', '11-11', '11-12', '11-13', '11-14', '11-15', '11-16', '11-17'),
  },
];

// ── apply ───────────────────────────────────────────────────────────────────

async function sopState(slug: string): Promise<{ slug: string; confirmed: boolean; status: string } | null> {
  const w = await prisma.workflow.findUnique({ where: { slug }, select: { slug: true, status: true, confirmedVersion: true } });
  if (!w || w.status === 'archived') return null;
  return { slug: w.slug, status: w.status, confirmed: w.status === 'confirmed' && !!w.confirmedVersion };
}

async function findTask(t: Target): Promise<Automation | null> {
  const direct = await findAutomation(t.name);
  if (direct) return direct;
  for (const old of RENAMES[t.name] ?? []) {
    const a = await findAutomation(old);
    if (a) return a;
  }
  return null;
}

// key-order-insensitive (MySQL JSON reorders object keys)
const sameJson = (a: unknown, b: unknown) => sameSchedule(a ?? null, b ?? null);

interface Row {
  task: string;
  action: string;
  schedule: string;
  sop: string;
  notes: string[];
  history: string;
}
const rows: Row[] = [];
let failures = 0;

for (const t of TARGETS) {
  const row: Row = { task: t.name, action: '', schedule: describeSchedule(t.schedule), sop: '—', notes: [], history: '' };
  rows.push(row);
  const cur = await findTask(t);
  const body: Record<string, unknown> = {};

  // SOP binding
  let bindSlug: string | null = null;
  if (t.sop) {
    const w = await sopState(t.sop);
    if (w?.confirmed) {
      bindSlug = w.slug;
      row.sop = w.slug;
    } else {
      row.sop = `无（${t.sop} ${w ? '是草稿，确认后再绑' : '不存在'}，用 prompt）`;
    }
  }

  if (!cur) {
    const p = t.forcePrompt?.(null) ?? (await t.prompt?.());
    Object.assign(body, { name: t.name, schedule: t.schedule, mode: 'manual', enabled: true });
    if (bindSlug) body.workflowSlug = bindSlug;
    if (t.inputs) body.inputs = t.inputs;
    if (p) {
      body.prompt = p.prompt;
      row.notes.push(`prompt 来源：${p.source}`);
    }
    row.action = DRY ? '将新建（手动）' : '新建（手动）';
    if (!DRY) {
      const r = await createAutomation(body);
      if (!r.ok) {
        row.action = `新建失败：${r.error}`;
        failures++;
        continue;
      }
    }
  } else {
    const changes: string[] = [];
    if (cur.name !== t.name) {
      body.name = t.name;
      changes.push(`改名 ${cur.name}→${t.name}`);
    }
    if (!sameSchedule(cur.schedule, t.schedule)) {
      body.schedule = t.schedule;
      changes.push(`频率 ${describeSchedule(cur.schedule as unknown as ScheduleSpec)}→${describeSchedule(t.schedule)}`);
    }
    if (bindSlug) {
      const w = await prisma.workflow.findUnique({ where: { slug: bindSlug }, select: { id: true } });
      if (w && cur.workflowId !== w.id) {
        body.workflowSlug = bindSlug;
        changes.push(`绑定 SOP ${bindSlug}`);
      }
    } else if (t.sop && cur.workflowId) {
      // Bound to its target SOP while that SOP is still a draft -> unbind (a draft blocks every run).
      const w = await prisma.workflow.findUnique({ where: { id: cur.workflowId }, select: { slug: true } });
      if (w?.slug === t.sop) {
        body.workflowSlug = null;
        changes.push(`解绑草稿 SOP ${t.sop}`);
      }
    }
    if (t.inputs !== undefined && !sameJson(cur.inputs, t.inputs)) {
      body.inputs = t.inputs;
      changes.push(`参数 ${JSON.stringify(t.inputs)}`);
    }
    // Forced prompts are rewritten whenever they differ; others are kept and only
    // filled in when the task would otherwise have nothing to run.
    const boundAfter = body.workflowSlug === null ? !!bindSlug : !!bindSlug || !!cur.workflowId;
    if (t.forcePrompt) {
      const p = t.forcePrompt(cur.prompt);
      if (p.prompt !== (cur.prompt ?? '').trim()) {
        body.prompt = p.prompt;
        changes.push(`prompt（${p.source}）`);
      }
    } else if (!cur.prompt?.trim() && !boundAfter && t.prompt) {
      const p = await t.prompt();
      body.prompt = p.prompt;
      changes.push(`prompt（${p.source}）`);
    }
    if (cur.mode === 'auto') row.notes.push('当前是自动（保持不变）');
    if (changes.length === 0) row.action = '不变';
    else {
      row.action = `${DRY ? '将修改' : '已修改'}：${changes.join('；')}`;
      if (!DRY) {
        const r = await updateAutomation(cur.id, body);
        if (!r.ok) {
          row.action = `修改失败：${r.error}（${changes.join('；')}）`;
          failures++;
          continue;
        }
      }
    }
  }

  // history links
  const target = await findTask(t);
  if (!target) {
    // dry run of a new task: just check the sessions
    const found = await Promise.all(t.history.map((h) => prisma.session.findFirst({ where: { OR: [{ id: h.session }, { slug: h.session }] }, select: { id: true } })));
    row.history = `将登记（新任务）：会话找到 ${found.filter(Boolean).length}/${t.history.length} 条`;
    continue;
  }
  const r = await linkHistory(target.id, t.history, { dryRun: DRY });
  if (!r.ok) {
    row.history = `失败：${r.error}`;
    failures++;
    continue;
  }
  const n = (k: string) => r.value.filter((o) => o.result === k).length;
  row.history = `${DRY ? '将登记' : '登记'} ${n('linked')} · 已有 ${n('duplicate')} · 跳过 ${n('skipped')}`;
  const skipped = r.value.filter((o) => o.result === 'skipped');
  if (skipped.length) row.notes.push(`跳过：${skipped.map((o) => `${o.session.slice(0, 12)}${o.date ? `@${o.date.slice(5)}` : ''}（${o.reason}）`).join('，')}`);
}

// ── summary ─────────────────────────────────────────────────────────────────

console.log('');
console.log('| 任务 | 操作 | 频率 (PT) | SOP | 历史会话 | 备注 |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.task} | ${r.action} | ${r.schedule} | ${r.sop} | ${r.history} | ${r.notes.join('；') || ''} |`);

const all = await prisma.automation.findMany({ orderBy: { createdAt: 'asc' }, select: { name: true, mode: true, lastRunAt: true } });
const extra = all.filter((a) => !TARGETS.some((t) => t.name === a.name));
console.log('');
console.log(`共 ${all.length} 个任务（手动 ${all.filter((a) => a.mode === 'manual').length} / 自动 ${all.filter((a) => a.mode === 'auto').length}）。`);
if (extra.length) console.log(`不在 §4 表里的任务（未改动）：${extra.map((a) => a.name).join('、')}`);
if (failures) console.log(`失败 ${failures} 项，见上表。`);

await prisma.$disconnect();
process.exit(failures ? 2 : 0);
