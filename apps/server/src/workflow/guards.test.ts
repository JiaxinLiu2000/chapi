import { describe, expect, it } from 'vitest';
import type { WorkflowRunDTO } from '@chapi/shared';
import { decideBoardTool, decideMemoryAccess, decideSubmit, decideTask, extractToken, takeTaskPrompt } from './guards.js';

const run = (pendingToken: string | null): WorkflowRunDTO => ({
  id: 'r',
  workflowId: 'w',
  workflowName: 'BI SOP',
  version: 1,
  sessionId: 's',
  label: null,
  status: 'running',
  graph: { nodes: [], edges: [] },
  cursor: { nodeId: 'a', iterKey: '' },
  pendingToken,
  nodeRuns: [],
  createdAt: '',
  endedAt: null,
});

describe('extractToken', () => {
  it('finds a bracketed token', () => {
    expect(extractToken('[WF-ab12cd] 阶段 A\n备注')).toBe('WF-ab12cd');
    expect(extractToken('没有令牌')).toBeNull();
  });
});

describe('decideTask', () => {
  it('denies a Task without token when a run is active', () => {
    const r = decideTask({ run: run('WF-ab12cd'), prompt: '帮我把阶段 A 做了' });
    expect(r).toContain('[WF-ab12cd]');
  });

  it('denies when no stage has been claimed', () => {
    expect(decideTask({ run: run(null), prompt: '做点事' })).toContain('workflow_next_stage');
  });

  it('allows the current token', () => {
    expect(decideTask({ run: run('WF-ab12cd'), prompt: '[WF-ab12cd] 阶段 A' })).toBeNull();
  });

  it('denies a stale token', () => {
    expect(decideTask({ run: run('WF-ab12cd'), prompt: '[WF-zzzzzz] 阶段 A' })).toBeTruthy();
  });

  it('allows Explore', () => {
    expect(decideTask({ run: run('WF-ab12cd'), prompt: '查一下文件', subagentType: 'Explore' })).toBeNull();
  });

  it('allows anything when no run', () => {
    expect(decideTask({ run: null, prompt: '随便' })).toBeNull();
  });
});

describe('decideTask — stage state', () => {
  const cur = (status: string, agentId: string | null) => ({ status, agentId });

  it('denies reusing a token whose stage is already bound to a sub-agent', () => {
    const r = decideTask({ run: run('WF-ab12cd'), prompt: '[WF-ab12cd] 阶段 A', current: cur('dispatched', 'sub-1') });
    expect(r).toContain('force');
  });

  it('denies a token Task once the stage was submitted', () => {
    expect(decideTask({ run: run('WF-ab12cd'), prompt: '[WF-ab12cd] 阶段 A', current: cur('submitted', 'sub-1') })).toBeTruthy();
  });

  it('denies running a stage sub-agent in the background', () => {
    const r = decideTask({ run: run('WF-ab12cd'), prompt: '[WF-ab12cd] 阶段 A', current: cur('dispatched', null), background: true });
    expect(r).toContain('run_in_background');
  });

  it('allows the first dispatch of a claimed stage', () => {
    expect(decideTask({ run: run('WF-ab12cd'), prompt: '[WF-ab12cd] 阶段 A', current: cur('dispatched', null) })).toBeNull();
  });
});

describe('takeTaskPrompt', () => {
  it('takes the entry carrying the pending token, wherever it is in the queue', () => {
    const q = ['查一下文件', '[WF-ab12cd] 阶段 A'];
    expect(takeTaskPrompt(q, 'WF-ab12cd', 'general-purpose')).toBe('[WF-ab12cd] 阶段 A');
    expect(q).toEqual(['查一下文件']);
  });

  it('never hands the stage prompt to an Explore agent', () => {
    const q = ['[WF-ab12cd] 阶段 A', '查一下文件'];
    expect(takeTaskPrompt(q, 'WF-ab12cd', 'Explore')).toBe('查一下文件');
    expect(q).toEqual(['[WF-ab12cd] 阶段 A']);
  });

  it('drops stale token entries left by Tasks that never started', () => {
    const q = ['[WF-old111] 阶段 A', '[WF-ab12cd] 阶段 B'];
    expect(takeTaskPrompt(q, 'WF-ab12cd', 'general-purpose')).toBe('[WF-ab12cd] 阶段 B');
    expect(q).toEqual([]);
  });

  it('falls back to FIFO when no run is active', () => {
    const q = ['a', 'b'];
    expect(takeTaskPrompt(q, null, 'general-purpose')).toBe('a');
  });
});

describe('decideMemoryAccess', () => {
  const memDir = 'C:\\chapi\\sessions\\s1\\memory';

  it('denies wiki reads for a memory-free stage', () => {
    expect(decideMemoryAccess({ mode: 'none', toolName: 'mcp__chapi__wiki_search', input: { query: 'x' }, memoryDir: memDir })).toContain('不使用记忆');
    expect(decideMemoryAccess({ mode: 'none', toolName: 'mcp__chapi__wiki_read', input: {}, memoryDir: memDir })).toBeTruthy();
  });

  it('denies reading the session memory dir for a memory-free stage', () => {
    expect(decideMemoryAccess({ mode: 'none', toolName: 'Read', input: { file_path: `${memDir}\\notes.md` }, memoryDir: memDir })).toBeTruthy();
    expect(decideMemoryAccess({ mode: 'none', toolName: 'Grep', input: { pattern: 'x', path: memDir.replace(/\\/g, '/') }, memoryDir: memDir })).toBeTruthy();
    expect(decideMemoryAccess({ mode: 'none', toolName: 'Bash', input: { command: `type ${memDir}\\notes.md` }, memoryDir: memDir })).toBeTruthy();
  });

  it('allows ordinary tools, and everything for skills / non-stage agents', () => {
    expect(decideMemoryAccess({ mode: 'none', toolName: 'Read', input: { file_path: 'C:\\chapi\\sessions\\s1\\sandbox\\a.csv' }, memoryDir: memDir })).toBeNull();
    expect(decideMemoryAccess({ mode: 'skills', toolName: 'mcp__chapi__wiki_search', input: {}, memoryDir: memDir })).toBeNull();
    expect(decideMemoryAccess({ mode: null, toolName: 'mcp__chapi__wiki_search', input: {}, memoryDir: memDir })).toBeNull();
  });
});

describe('decideSubmit', () => {
  it('denies main agent', () => {
    expect(decideSubmit({ agentId: undefined, token: 'WF-ab12cd', owner: { agentId: 'sub-1', status: 'dispatched' } })).toContain('副 AI');
  });

  it('denies token owned by another agent', () => {
    expect(decideSubmit({ agentId: 'sub-2', token: 'WF-ab12cd', owner: { agentId: 'sub-1', status: 'dispatched' } })).toBeTruthy();
  });

  it('denies an unknown / expired token', () => {
    expect(decideSubmit({ agentId: 'sub-1', token: 'WF-ab12cd', owner: null })).toBeTruthy();
  });

  it('allows the owning sub-agent', () => {
    expect(decideSubmit({ agentId: 'sub-1', token: 'WF-ab12cd', owner: { agentId: 'sub-1', status: 'dispatched' } })).toBeNull();
  });
});

describe('decideBoardTool', () => {
  it('sub-agents (SOP stage agents included) may not use the automation tools; the main agent may', () => {
    expect(decideBoardTool({ toolName: 'mcp__chapi__automation_run_now', agentId: 'agent-1' })).toContain('主 AI');
    expect(decideBoardTool({ toolName: 'mcp__chapi__automation_list', agentId: 'agent-1' })).not.toBeNull();
    expect(decideBoardTool({ toolName: 'mcp__chapi__automation_run_now', agentId: undefined })).toBeNull();
    expect(decideBoardTool({ toolName: 'mcp__chapi__workflow_substep', agentId: 'agent-1' })).toBeNull();
  });
});
