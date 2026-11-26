import { describe, expect, it } from 'vitest';
import type { WorkflowNodeDef, WorkflowNodeRunDTO, WorkflowRunDTO } from '@chapi/shared';
import { renderProgress, renderReviewSheet, renderStageCard, stageOutputDir } from './card.js';

const nodeA: WorkflowNodeDef = {
  id: 'stage5',
  type: 'step',
  title: '阶段 5 验证',
  instructions: 'x',
  doneCriteria: ['邮箱都过了 ZeroBounce'],
  evidence: [{ key: 'needs_refind', type: 'int', desc: '需要重找的人数' }],
};
const longText = Array.from({ length: 80 }, (_, i) => `第 ${i} 行：**biscred** 同名+同公司命中则更新 | 表格 | \`code\``).join('\n');
const nodeB: WorkflowNodeDef = {
  id: 'stage6',
  type: 'step',
  title: '阶段 6 多源兜底',
  instructions: longText,
  inputs: [{ name: 'refind_list', from: 'stage5', desc: '本批没通过的人' }],
  doneCriteria: ['每个缺口都查过 biscred', '仍缺的写明原因'],
  evidence: [
    { key: 'biscred_checked', type: 'int' },
    { key: 'still_missing', type: 'list', required: false, desc: '仍缺的人及原因' },
  ],
};
const nr = (nodeId: string, extra: Partial<WorkflowNodeRunDTO> = {}): WorkflowNodeRunDTO => ({
  id: `nr-${nodeId}`,
  nodeId,
  iterKey: '',
  status: 'pending',
  agentId: null,
  agentRunId: null,
  summary: null,
  evidence: null,
  review: null,
  attempts: 0,
  substeps: [],
  progress: 0,
  startedAt: null,
  endedAt: null,
  ...extra,
});
const run: WorkflowRunDTO = {
  id: 'run1',
  workflowId: 'w',
  workflowName: 'BI SOP',
  version: 1,
  sessionId: 's1',
  label: 'MF Summit',
  status: 'running',
  graph: {
    nodes: [{ id: 'start', type: 'start', title: '开始' }, nodeA, nodeB, { id: 'end', type: 'end', title: '结束' }],
    edges: [
      { from: 'start', to: 'stage5' },
      { from: 'stage5', to: 'stage6' },
      { from: 'stage6', to: 'end' },
    ],
  },
  cursor: { nodeId: 'stage6', iterKey: '' },
  pendingToken: 'WF-abc123',
  nodeRuns: [nr('stage5', { status: 'done', evidence: { needs_refind: 4 } }), nr('stage6', { status: 'dispatched' })],
  createdAt: new Date().toISOString(),
  endedAt: null,
};

const card = (extra: { lastFeedback?: string | null; mainNote?: string | null } = {}) =>
  renderStageCard({
    run,
    node: nodeB,
    nodeRun: run.nodeRuns[1]!,
    token: 'WF-abc123',
    outputDir: '/sb/wf/run1/stage6/_',
    upstream: [{ node: nodeA, nodeRun: run.nodeRuns[0]!, outputDir: '/sb/wf/run1/stage5/_' }],
    ...extra,
  });

describe('renderStageCard', () => {
  it('contains instructions verbatim', () => {
    expect(card()).toContain(longText);
  });

  it('tells the sub-agent the system saves saveAs fields as files', () => {
    const c = renderStageCard({
      run,
      node: { ...nodeB, evidence: [{ key: 'text', type: 'string', saveAs: 'summary.md', desc: '摘要全文' }] },
      nodeRun: run.nodeRuns[1]!,
      token: 'WF-abc123',
      outputDir: '/sb/wf/run1/stage6/_',
      upstream: [],
    });
    expect(c).toContain('summary.md');
    expect(c).toContain('系统会存成');
  });

  it('tells a memory-free stage to rely only on the SOP and its inputs', () => {
    const c = renderStageCard({ run, node: { ...nodeB, memory: 'none' }, nodeRun: run.nodeRuns[1]!, token: 'WF-abc123', outputDir: '/o', upstream: [] });
    expect(c).toContain('不使用记忆');
    expect(c).toContain('wiki_search');
  });

  it('tells a skills-only stage that the SOP wins over recalled preferences or data', () => {
    const c = renderStageCard({ run, node: { ...nodeB, memory: 'skills' }, nodeRun: run.nodeRuns[1]!, token: 'WF-abc123', outputDir: '/o', upstream: [] });
    expect(c).toContain('只带工具用法');
    expect(c).not.toContain('不使用记忆');
  });

  it('names the token, stage position and evidence fields', () => {
    const c = card();
    expect(c).toContain('WF-abc123');
    expect(c).toContain('阶段 2/2');
    expect(c).toContain('biscred_checked');
    expect(c).toContain('仍缺的人及原因');
    expect(c).toContain('workflow_submit_stage');
  });

  it('lists upstream output dirs and evidence', () => {
    const c = card();
    expect(c).toContain('/sb/wf/run1/stage5/_');
    expect(c).toContain('"needs_refind": 4');
    expect(c).toContain('/sb/wf/run1/stage6/_');
  });

  it('includes feedback section only when given', () => {
    expect(card()).not.toContain('上次返工意见');
    expect(card({ lastFeedback: 'WebSearch 只查了 1 人' })).toContain('WebSearch 只查了 1 人');
  });
});

describe('renderReviewSheet', () => {
  it('numbers every criterion and shows evidence', () => {
    const s = renderReviewSheet(nodeB, nr('stage6', { status: 'submitted', summary: '查完了', evidence: { biscred_checked: 4 } }));
    expect(s).toContain('1. 每个缺口都查过 biscred');
    expect(s).toContain('2. 仍缺的写明原因');
    expect(s).toContain('"biscred_checked": 4');
    expect(s).toContain('workflow_review_stage');
  });
});

describe('renderProgress / stageOutputDir', () => {
  it('summarises the run in one line', () => {
    const p = renderProgress(run);
    expect(p).toContain('BI SOP');
    expect(p).toContain('阶段 2/2');
    expect(p).toContain('阶段 6 多源兜底');
  });

  it('builds the stage dir under the session sandbox', () => {
    const d = stageOutputDir('s1', 'run1', 'stage6', '');
    expect(d.replace(/\\/g, '/')).toMatch(/wf\/run1\/stage6\/_$/);
  });
});
