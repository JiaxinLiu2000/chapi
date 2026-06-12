import type {
  PostToolUseHookInput,
  PreToolUseHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toAgentRunDTO, toPlanTaskDTO, toToolCallDTO } from '../mappers.js';
import { preview } from './content.js';
import { describeActivity } from './activity.js';

const log = createLogger('monitoring');

interface IncomingTodo {
  content?: string;
  status?: string;
  activeForm?: string;
}

/**
 * Tracks agent runs, tool calls and the plan (TodoWrite) for one session,
 * persisting to the DB and emitting live events for the monitoring card.
 * Driven by the SDK hooks (which carry agent_id/agent_type for attribution).
 */
export class RunMonitor {
  /** agent key ("main" or subagent agent_id) -> AgentRun.id */
  private agents = new Map<string, string>();
  /** tool_use_id -> ToolCall.id */
  private tools = new Map<string, string>();
  /** AgentRun.id -> start epoch ms */
  private agentStart = new Map<string, number>();
  /** subagent_type -> queued short task descriptions captured from Task calls */
  private pendingSubagentDesc = new Map<string, string[]>();

  constructor(private readonly sessionId: string) {}

  async ensureMainAgent(title?: string): Promise<string> {
    return this.ensureAgent('main', 'main', title);
  }

  private async ensureAgent(key: string, name: string, title?: string): Promise<string> {
    const cached = this.agents.get(key);
    if (cached) return cached;
    const run = await prisma.agentRun.create({
      data: {
        sessionId: this.sessionId,
        name,
        title: title ?? null,
        status: 'running',
        startedAt: new Date(),
      },
    });
    this.agents.set(key, run.id);
    this.agentStart.set(run.id, Date.now());
    bus.emit({ type: 'agent.status', sessionId: this.sessionId, agent: toAgentRunDTO(run) });
    return run.id;
  }

  private async emitAgent(agentRunId: string): Promise<void> {
    const run = await prisma.agentRun.findUnique({ where: { id: agentRunId } });
    if (run) bus.emit({ type: 'agent.status', sessionId: this.sessionId, agent: toAgentRunDTO(run) });
  }

  async onSubagentStart(input: SubagentStartHookInput): Promise<void> {
    const queue = this.pendingSubagentDesc.get(input.agent_type);
    const title = queue && queue.length ? queue.shift() : undefined;
    await this.ensureAgent(input.agent_id, input.agent_type || input.agent_id, title);
  }

  async onSubagentStop(input: SubagentStopHookInput): Promise<void> {
    const id = this.agents.get(input.agent_id);
    if (!id) return;
    const start = this.agentStart.get(id) ?? Date.now();
    await prisma.agentRun.update({
      where: { id },
      data: {
        status: 'done',
        currentTool: null,
        currentActivity: null,
        endedAt: new Date(),
        elapsedMs: Date.now() - start,
      },
    });
    await this.emitAgent(id);
  }

  async onPreTool(input: PreToolUseHookInput): Promise<void> {
    const key = input.agent_id ?? 'main';
    const name = input.agent_id ? input.agent_type || input.agent_id : 'main';
    const agentRunId = await this.ensureAgent(key, name);
    const inputPreview = preview(input.tool_input);
    const { tag, label } = describeActivity(input.tool_name, input.tool_input);

    // When the main thread dispatches a sub-agent, stash its short description so
    // the sub-agent shows a task title the moment it starts.
    if (input.tool_name === 'Task' && !input.agent_id) {
      const ti = input.tool_input as { description?: string; subagent_type?: string } | null;
      const desc = ti?.description?.trim();
      const type = ti?.subagent_type?.trim() || 'general-purpose';
      if (desc) {
        const q = this.pendingSubagentDesc.get(type) ?? [];
        q.push(desc);
        this.pendingSubagentDesc.set(type, q);
      }
    }

    const call = await prisma.toolCall.create({
      data: {
        sessionId: this.sessionId,
        agentRunId,
        toolName: input.tool_name,
        inputPreview,
        status: 'running',
      },
    });
    this.tools.set(input.tool_use_id, call.id);

    await prisma.agentRun.update({
      where: { id: agentRunId },
      data: { currentTool: tag, currentActivity: label, status: 'running' },
    });

    bus.emit({ type: 'tool.started', sessionId: this.sessionId, toolCall: toToolCallDTO(call) });
    await this.emitAgent(agentRunId);
  }

  async onPostTool(input: PostToolUseHookInput): Promise<void> {
    const callId = this.tools.get(input.tool_use_id);
    const outputPreview = preview(input.tool_response);
    const isError =
      typeof input.tool_response === 'object' &&
      input.tool_response !== null &&
      (input.tool_response as { is_error?: boolean }).is_error === true;

    if (callId) {
      await prisma.toolCall.update({
        where: { id: callId },
        data: {
          status: isError ? 'error' : 'done',
          durationMs: input.duration_ms ?? null,
          outputPreview,
        },
      });
      bus.emit({
        type: 'tool.finished',
        sessionId: this.sessionId,
        toolCallId: callId,
        status: isError ? 'error' : 'done',
        durationMs: input.duration_ms ?? 0,
        outputPreview,
      });
      this.tools.delete(input.tool_use_id);
    }

    const key = input.agent_id ?? 'main';
    const agentRunId = this.agents.get(key);
    if (agentRunId) {
      await prisma.agentRun.update({
        where: { id: agentRunId },
        data: { currentTool: null, currentActivity: null },
      });
      await this.emitAgent(agentRunId);
    }

    if (input.tool_name === 'TodoWrite') {
      const todos = (input.tool_input as { todos?: IncomingTodo[] } | null)?.todos;
      if (Array.isArray(todos)) await this.syncPlan(todos);
    }
  }

  /** Reconcile the plan with a TodoWrite call. Missing tasks are struck (error), not deleted. */
  async syncPlan(todos: IncomingTodo[]): Promise<void> {
    const existing = await prisma.planTask.findMany({
      where: { sessionId: this.sessionId },
      orderBy: { ordinal: 'asc' },
    });
    const byText = new Map(existing.map((t) => [t.text, t]));
    let maxOrdinal = existing.reduce((m, t) => Math.max(m, t.ordinal), -1);
    const incoming = new Set<string>();

    for (const todo of todos) {
      const text = (todo.content ?? '').trim();
      if (!text) continue;
      incoming.add(text);
      const status =
        todo.status === 'completed'
          ? 'done'
          : todo.status === 'in_progress'
            ? 'in_progress'
            : 'pending';
      const ex = byText.get(text);
      if (ex) {
        if (ex.status !== status && ex.status !== 'error') {
          await prisma.planTask.update({ where: { id: ex.id }, data: { status } });
        }
      } else {
        maxOrdinal += 1;
        await prisma.planTask.create({
          data: { sessionId: this.sessionId, ordinal: maxOrdinal, text, status },
        });
      }
    }

    for (const t of existing) {
      if (!incoming.has(t.text) && t.status !== 'done' && t.status !== 'error') {
        await prisma.planTask.update({ where: { id: t.id }, data: { status: 'error' } });
      }
    }

    const all = await prisma.planTask.findMany({
      where: { sessionId: this.sessionId },
      orderBy: { ordinal: 'asc' },
    });
    bus.emit({ type: 'plan.updated', sessionId: this.sessionId, tasks: all.map(toPlanTaskDTO) });
  }

  /** On run end / interrupt, close out any still-running agents. */
  async finishAll(status: 'done' | 'interrupted' = 'done'): Promise<void> {
    for (const [, id] of this.agents) {
      const run = await prisma.agentRun.findUnique({ where: { id } });
      if (run && run.status === 'running') {
        const start = this.agentStart.get(id) ?? Date.now();
        await prisma.agentRun.update({
          where: { id },
          data: {
            status,
            currentTool: null,
            currentActivity: null,
            endedAt: new Date(),
            elapsedMs: Date.now() - start,
          },
        });
        await this.emitAgent(id);
      }
    }
    log.debug(`finished agents for session ${this.sessionId} as ${status}`);
  }
}
