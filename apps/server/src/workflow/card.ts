import path from 'node:path';
import type { EvidenceField, WorkflowNodeDef, WorkflowNodeRunDTO, WorkflowRunDTO } from '@chapi/shared';
import { sessionPaths } from '../config.js';

/**
 * Text the engine hands out: the sub-agent's stage card (the SOP's own words,
 * never a paraphrase), the main AI's review sheet, and a one-line progress.
 */

const UPSTREAM_EVIDENCE_MAX = 1500;

export function stageOutputDir(sessionId: string, runId: string, nodeId: string, iterKey: string): string {
  return path.join(sessionPaths(sessionId).sandbox, 'wf', runId, nodeId, iterKey ? iterKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : '_');
}

function steps(run: WorkflowRunDTO): WorkflowNodeDef[] {
  // Phase 1 graphs are linear: follow the edges from start.
  const byId = new Map(run.graph.nodes.map((n) => [n.id, n]));
  const next = new Map(run.graph.edges.map((e) => [e.from, e.to]));
  const out: WorkflowNodeDef[] = [];
  let cur = run.graph.nodes.find((n) => n.type === 'start')?.id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (n?.type === 'step') out.push(n);
    cur = next.get(cur);
  }
  return out;
}

export function stagePosition(run: WorkflowRunDTO, nodeId: string): { index: number; total: number } {
  const s = steps(run);
  return { index: s.findIndex((n) => n.id === nodeId) + 1, total: s.length };
}

const json = (v: unknown, max = UPSTREAM_EVIDENCE_MAX): string => {
  const s = JSON.stringify(v ?? {}, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，完整内容见上游产出目录）` : s;
};

function fieldTable(fields: EvidenceField[]): string {
  return fields
    .map(
      (f) =>
        `- \`${f.key}\`（${f.type}${f.required === false ? '，可选' : '，必填'}）${f.desc ? `：${f.desc}` : ''}` +
        (f.saveAs ? `——直接把全文作为这个字段的值提交，系统会存成产出目录里的 ${f.saveAs}（不要自己写这个文件）` : ''),
    )
    .join('\n');
}

export function renderStageCard(a: {
  run: WorkflowRunDTO;
  node: WorkflowNodeDef;
  nodeRun: WorkflowNodeRunDTO;
  token: string;
  outputDir: string;
  upstream: { node: WorkflowNodeDef; nodeRun: WorkflowNodeRunDTO; outputDir: string }[];
  lastFeedback?: string | null;
  mainNote?: string | null;
  recall?: string | null;
}): string {
  const { index, total } = stagePosition(a.run, a.node.id);
  const later = steps(a.run).slice(index).map((n) => n.title);
  const lines: string[] = [
    `[工作流] ${a.run.workflowName}${a.run.label ? `（${a.run.label}）` : ''} · 阶段 ${index}/${total}「${a.node.title}」· 令牌 ${a.token}`,
    '你是负责**这一个阶段**的副 AI。严格按下面的 SOP 原文执行，做完后必须提交证据。',
    a.node.memory === 'none'
      ? '本阶段不使用记忆：只依据下面的 SOP 原文、输入材料和你这次实际查到的事实判断；不要调用 wiki_search / wiki_read，也不要读会话记忆目录（会被拒绝）。'
      : '本阶段只带工具用法类经验（附在末尾，如果有）：判断一律以 SOP 原文为准；知识库里的偏好或旧数据与 SOP、与本次查到的事实冲突时，以 SOP 和事实为准。',
    '',
    '── SOP 原文 ──',
    a.node.instructions ?? '',
    '',
    '── 输入 ──',
  ];
  if (a.node.inputs?.length) {
    for (const i of a.node.inputs) lines.push(`- ${i.name}${i.from ? `（来自 ${i.from}）` : ''}${i.desc ? `：${i.desc}` : ''}`);
  }
  if (a.upstream.length) {
    for (const u of a.upstream) {
      lines.push(`上游「${u.node.title}」产出目录：${u.outputDir}`);
      if (u.nodeRun.summary) lines.push(`上游总结：${u.nodeRun.summary.slice(0, 600)}`);
      lines.push(`上游证据：\n${json(u.nodeRun.evidence)}`);
    }
  } else if (!a.node.inputs?.length) {
    lines.push('（无上游材料；运行输入见下方）');
  }
  lines.push(
    '',
    '── 产出目录 ──',
    `${a.outputDir}（本阶段的文件都存这里；后续阶段会从这里读）`,
    ...(a.node.outputs?.length ? a.node.outputs.map((o) => `- ${o.name}${o.file ? ` → ${o.file}` : ''}${o.desc ? `：${o.desc}` : ''}`) : []),
    ...(a.node.substeps?.length
      ? [
          '',
          '── 子步骤（每做完一步立刻调用 mcp__chapi__workflow_substep 标记；确实不适用的标 na 并写原因；全部标记后才能提交）──',
          ...a.node.substeps.map((s, i) => `${i + 1}. [${s.id}] ${s.title}`),
        ]
      : []),
    '',
    '── 完成标准 ──',
    ...(a.node.doneCriteria ?? []).map((c, i) => `${i + 1}. ${c}`),
    '',
    '── 完成时调用 mcp__chapi__workflow_submit_stage ──',
    `token: "${a.token}"`,
    'summary: 一段话说明做了什么、结果如何、有什么异常',
    'evidence 字段：',
    fieldTable(a.node.evidence ?? []),
  );
  if (a.lastFeedback?.trim()) lines.push('', '── 上次返工意见（必须逐条处理）──', a.lastFeedback.trim());
  if (a.mainNote?.trim()) lines.push('', '── 主 AI 备注 ──', a.mainNote.trim());
  if (a.recall?.trim()) lines.push('', a.recall.trim());
  lines.push(
    '',
    `之后还有：${later.length ? later.join(' → ') : '（这是最后一个阶段）'}——**不要**做后续阶段的事，也不要写入后续阶段才允许写的地方。`,
    '纪律：只做本阶段；遇到无法完成的情况，如实写进 summary 和证据，不要编造数据；提交被退回时按错误逐条修正后重新提交。',
  );
  return lines.join('\n');
}

export function renderReviewSheet(node: WorkflowNodeDef, nodeRun: WorkflowNodeRunDTO): string {
  return [
    `[工作流·待审核] 阶段「${node.title}」的副 AI 已提交（第 ${nodeRun.attempts} 次执行）。`,
    `副 AI 总结：${nodeRun.summary ?? '（无）'}`,
    `证据：\n${JSON.stringify(nodeRun.evidence ?? {}, null, 2)}`,
    ...(node.evidence ?? [])
      .filter((f) => f.saveAs && typeof nodeRun.evidence?.[f.key] === 'string')
      .map((f) => `系统已把 ${f.key} 存为文件：${String(nodeRun.evidence![f.key])}`),
    ...(node.substeps?.length
      ? [
          '子步骤：',
          ...node.substeps.map((s) => {
            const st = nodeRun.substeps.find((x) => x.id === s.id);
            return `- ${s.title}：${st?.status === 'done' ? '已完成' : st?.status === 'na' ? `不适用（${st.note ?? ''}）` : '未标记'}`;
          }),
        ]
      : []),
    '完成标准（逐条判断，必要时打开产出目录抽查文件）：',
    ...(node.doneCriteria ?? []).map((c, i) => `${i + 1}. ${c}`),
    '审核后调用 mcp__chapi__workflow_review_stage：',
    '- 通过：decision="accept"，perCriterion 每条一项 {criterion:"第N条", verdict:"met"|"na", reason:"依据"}',
    '- 返工：decision="redo"，feedback 写清楚哪里不达标、要怎么补',
  ].join('\n');
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待领取',
  dispatched: '副 AI 执行中',
  submitted: '待主 AI 审核',
  redo: '待返工',
  done: '已完成',
  failed: '失败',
  blocked: '受阻',
  waiting_user: '等用户',
};

export function renderProgress(run: WorkflowRunDTO): string {
  const head = `${run.workflowName}${run.label ? `（${run.label}）` : ''}`;
  if (run.status === 'done') return `${head} · 已完成`;
  const cur = run.cursor ? run.graph.nodes.find((n) => n.id === run.cursor!.nodeId) : null;
  if (!cur) return `${head} · ${run.status}`;
  const { index, total } = stagePosition(run, cur.id);
  const nr = run.nodeRuns.find((x) => x.nodeId === cur.id && x.iterKey === run.cursor!.iterKey);
  return `${head} · 阶段 ${index}/${total}「${cur.title}」· ${STATUS_LABEL[nr?.status ?? 'pending'] ?? nr?.status}`;
}
