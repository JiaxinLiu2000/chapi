import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionProfile } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { sessionUsage, toMessageDTO, toSessionDTO } from '../mappers.js';
import { settings } from '../secrets.js';
import { extractContent } from './content.js';
import { buildHooks } from './hooks.js';
import { InputQueue } from './inputQueue.js';
import { RunMonitor } from './monitoring.js';
import { buildRunOptions } from './options.js';
import { buildCanUseTool } from './permissions.js';
import { CHAPI_TOOL_NAMES, buildChapiToolServer } from './tools/chapiTools.js';
import { buildExternalMcpServers } from './tools/mcpRegistry.js';
import { latestSummary } from '../learning/summarize.js';
import { ensureSandboxHelpers } from '../services/workspaces.js';
import { sessionPaths } from '../config.js';

const log = createLogger('engine:run');

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

/**
 * One long-lived agent run per session. The input queue stays open across turns
 * so the user can steer/interrupt; the SDK message stream is translated into
 * ServerEvents + DB persistence.
 */
export class Run {
  private readonly input = new InputQueue();
  private readonly monitor: RunMonitor;
  private readonly abort = new AbortController();
  private q: Query | null = null;
  private started = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly queryFn: QueryFn = sdkQuery,
  ) {
    this.monitor = new RunMonitor(sessionId);
  }

  async pushUserMessage(text: string): Promise<void> {
    await this.ensureStarted();
    this.input.push(text);
    // New turn starting → reflect "running" immediately (the long-lived query
    // doesn't re-emit this between turns).
    bus.emit({ type: 'run.state', sessionId: this.sessionId, state: 'running' });
    await this.monitor.markRunning();
  }

  async interrupt(): Promise<void> {
    if (!this.q) return;
    await this.q.interrupt().catch((err) => log.warn('interrupt failed', err));
    await this.monitor.finishAll('interrupted');
    bus.emit({ type: 'run.state', sessionId: this.sessionId, state: 'idle' });
  }

  /** Live model switch (streaming-input mode). Effort changes require a fresh run. */
  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model).catch((err) => log.warn('setModel failed', err));
  }

  async stop(): Promise<void> {
    this.input.close();
    if (this.q) await this.q.interrupt().catch(() => undefined);
    this.abort.abort();
  }

  /** Test helper: resolves when the current message loop finishes. */
  async waitIdle(): Promise<void> {
    await this.loop;
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const session = await prisma.session.findUnique({ where: { id: this.sessionId } });
    if (!session) throw new Error(`session ${this.sessionId} not found`);

    // Refresh sandbox script helpers (chapi_browser.py CDP interface) so even
    // sessions created before this feature can `import chapi_browser`.
    await ensureSandboxHelpers(sessionPaths(session.id).sandbox).catch(() => undefined);

    const anthropicKey = await settings.getAnthropicKey();
    const maxSubagents = await settings.getMaxSubagents();
    const canUseTool = buildCanUseTool(
      session.id,
      session.permissionProfile as PermissionProfile,
    );
    const hooks = buildHooks(this.monitor);
    const chapiServer = buildChapiToolServer(session.id);
    const external = await buildExternalMcpServers();
    const summary = await latestSummary(session.id);
    const options = buildRunOptions(session, {
      canUseTool,
      hooks,
      anthropicKey,
      mcpServers: { chapi: chapiServer, ...external },
      // Pre-approve our own tools + safe built-ins so they don't go through the
      // permission path. Writes (Write/Edit/Bash) and any external MCP tools fall
      // through to canUseTool, which enforces the sandbox + Gmail-send restrictions.
      allowedTools: [
        ...CHAPI_TOOL_NAMES,
        'Read',
        'Grep',
        'Glob',
        'LS',
        'TodoWrite',
        'Task',
        'WebSearch',
        'WebFetch',
        'NotebookRead',
      ],
      extraSystemContext: summary,
      maxSubagents,
      abortController: this.abort,
    });

    await this.monitor.ensureMainAgent(session.title);
    this.q = this.queryFn({ prompt: this.input, options });
    this.loop = this.consume();
    void this.loop;
  }

  private async consume(): Promise<void> {
    bus.emit({ type: 'run.state', sessionId: this.sessionId, state: 'running' });
    try {
      for await (const msg of this.q as Query) {
        await this.handle(msg);
      }
    } catch (err) {
      log.error('run loop error', err);
      bus.emit({
        type: 'error',
        sessionId: this.sessionId,
        message: err instanceof Error ? err.message : 'engine error',
      });
    } finally {
      // Tolerate a session deleted mid-run (writes would FK-fail).
      await this.monitor.finishAll('done').catch(() => undefined);
      bus.emit({ type: 'run.state', sessionId: this.sessionId, state: 'idle' });
    }
  }

  private async handle(msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case 'system':
        await this.handleSystem(msg);
        return;
      case 'assistant':
        await this.handleAssistant(msg);
        return;
      case 'stream_event':
        this.handlePartial(msg);
        return;
      case 'result':
        await this.handleResult(msg);
        return;
      default:
        return;
    }
  }

  private async handleSystem(msg: SDKMessage): Promise<void> {
    const m = msg as {
      subtype?: string;
      session_id?: string;
      state?: string;
      mcp_servers?: Array<{ name: string; status: string }>;
    };
    if (m.subtype === 'init') {
      if (m.session_id) {
        await prisma.session.update({
          where: { id: this.sessionId },
          data: { sdkSessionId: m.session_id },
        });
      }
      // Log MCP connection status (helps diagnose e.g. google_workspace not loading).
      // Note: stdio MCPs are usually "pending" in this init snapshot and connect a
      // few seconds later — so we only log, not alarm.
      if (Array.isArray(m.mcp_servers) && m.mcp_servers.length > 0) {
        log.info(`MCP servers: ${m.mcp_servers.map((s) => `${s.name}=${s.status}`).join(', ')}`);
      }
    } else if (m.subtype === 'session_state_changed') {
      const state =
        m.state === 'running' ? 'running' : m.state === 'requires_action' ? 'paused' : 'idle';
      bus.emit({ type: 'run.state', sessionId: this.sessionId, state });
    }
  }

  private async handleAssistant(msg: SDKMessage): Promise<void> {
    const m = msg as {
      message?: unknown;
      parent_tool_use_id?: string | null;
      subagent_type?: string;
    };
    // Subagent text is surfaced via monitoring, not the main chat transcript.
    if (m.parent_tool_use_id || m.subagent_type) return;

    const { blocks, text } = extractContent(m.message);
    if (!text && blocks.length === 0) return;

    const row = await prisma.message.create({
      data: {
        sessionId: this.sessionId,
        role: 'assistant',
        type: 'assistant',
        content: blocks as unknown as object,
        text,
      },
    });
    bus.emit({ type: 'assistant.message', sessionId: this.sessionId, message: toMessageDTO(row) });
  }

  private handlePartial(msg: SDKMessage): void {
    const m = msg as {
      event?: { type?: string; delta?: { type?: string; text?: string } };
      parent_tool_use_id?: string | null;
      uuid?: string;
    };
    if (m.parent_tool_use_id) return;
    const ev = m.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      bus.emit({
        type: 'assistant.delta',
        sessionId: this.sessionId,
        messageId: m.uuid ?? 'stream',
        agentRunId: null,
        text: ev.delta.text ?? '',
      });
    }
  }

  private async handleResult(msg: SDKMessage): Promise<void> {
    const m = msg as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      total_cost_usd?: number;
      duration_ms?: number;
    };
    const u = m.usage ?? {};
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheCreation = u.cache_creation_input_tokens ?? 0;

    const updated = await prisma.session.update({
      where: { id: this.sessionId },
      data: {
        inputTokens: { increment: input },
        outputTokens: { increment: output },
        cacheReadTokens: { increment: cacheRead },
        cacheCreationTokens: { increment: cacheCreation },
        totalTokens: { increment: input + output },
        costUsd: { increment: m.total_cost_usd ?? 0 },
        activeMs: { increment: m.duration_ms ?? 0 },
      },
    });
    bus.emit({ type: 'usage.updated', sessionId: this.sessionId, usage: sessionUsage(updated) });
    bus.emit({ type: 'session.updated', session: toSessionDTO(updated) });

    // Turn complete → the agent is idle (waiting for the next message). Settle
    // agents so the monitor stops showing "运行中" while the page stays open.
    await this.monitor.settleTurn();
    bus.emit({ type: 'run.state', sessionId: this.sessionId, state: 'idle' });
  }
}
