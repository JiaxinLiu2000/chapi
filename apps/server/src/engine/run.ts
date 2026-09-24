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
import { chooseActiveAccount, clearAccountLimit, recordAccountLimited, type AccountName } from './accounts.js';
import { getOrchestrator } from '../orchestrator/types.js';

const log = createLogger('engine:run');

/** True for the abort that an intentional stop/interrupt raises (not a real failure). */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || /\baborted\b/i.test(e.message ?? '');
}

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
  private account: AccountName = 'machine'; // Claude seat this run is using
  private accountMode: 'auto' | 'primary' | 'fallback' = 'auto'; // session's seat selection
  private currentModel = ''; // model this run started with, for the usage ledger
  private lastUserText = ''; // last user turn, replayed on account failover
  private failingOver = false; // guard: fail over at most once per run

  constructor(
    private readonly sessionId: string,
    private readonly queryFn: QueryFn = sdkQuery,
  ) {
    this.monitor = new RunMonitor(sessionId);
  }

  async pushUserMessage(text: string): Promise<void> {
    this.lastUserText = text;
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
    this.currentModel = model;
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
    // Pick the active Claude subscription seat, honoring the session's account mode.
    this.accountMode = (session.accountMode as 'auto' | 'primary' | 'fallback') ?? 'auto';
    const acct = await chooseActiveAccount(this.accountMode);
    this.account = acct.name;
    this.currentModel = session.model;
    log.info(
      `session ${this.sessionId}: run starting with account=${acct.name}${
        acct.email ? ` (${acct.email})` : ''
      } mode=${this.accountMode} model=${session.model}`,
    );
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
      oauthToken: acct.token,
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
      // An intentional stop (archive / delete / shutdown) aborts the SDK child
      // process, which surfaces here as "Operation aborted" — that's not an error,
      // so don't alarm the user with an error toast.
      if (this.abort.signal.aborted || isAbortError(err)) {
        log.debug('run loop stopped (aborted)');
      } else {
        log.error('run loop error', err);
        bus.emit({
          type: 'error',
          sessionId: this.sessionId,
          message: err instanceof Error ? err.message : 'engine error',
        });
      }
    } finally {
      // Tolerate a session deleted mid-run (writes would FK-fail).
      await this.monitor.finishAll('done').catch(() => undefined);
      bus.emit({ type: 'run.state', sessionId: this.sessionId, state: 'idle' });

      // The query loop is meant to stay open across turns for the life of the Run.
      // If it ended on its own here (not via our own stop()/abort — e.g. the active
      // Claude seat hit a fatal rate limit and its subprocess exited), this Run
      // object otherwise stays registered as "started" forever, so any later
      // pushUserMessage() (like the user replying "继续") would just buffer into a
      // now-dead input queue with no visible effect. Reset so the next message
      // starts a fresh query (still `resume`-ing the same SDK session).
      if (!this.abort.signal.aborted) {
        this.started = false;
        this.q = null;
      }
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
      case 'rate_limit_event':
        await this.handleRateLimitEvent(msg);
        return;
      default:
        return;
    }
  }

  /**
   * The SDK's authoritative rate-limit status for the seat this run is using
   * (real `resetsAt` from Anthropic, not a guess). Bookkeeping only — the actual
   * failover trigger is still the terminal `assistant.error === 'rate_limit'`
   * handled in `handleAssistant`; this just makes sure whichever seat we record
   * as limited gets the real reset time instead of a blind cooldown guess, and
   * lets us proactively clear a seat the moment Anthropic reports it's usable
   * again (instead of waiting out our own estimate).
   */
  private async handleRateLimitEvent(msg: SDKMessage): Promise<void> {
    const account = this.account;
    if (account === 'machine') return;
    const m = msg as { rate_limit_info?: { status?: string; resetsAt?: number } };
    const info = m.rate_limit_info;
    if (!info?.status) return;
    if (info.status === 'rejected') {
      await recordAccountLimited(account, { status: 'rejected', resetsAt: info.resetsAt });
    } else {
      await clearAccountLimit(account);
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
      error?: string;
    };

    // Usage-limit on the active Claude seat → hand off to the orchestrator to fail
    // over to the fallback seat and replay this turn. Skip persisting the (empty) errored turn.
    if (m.error === 'rate_limit') {
      await this.onRateLimit();
      return;
    }

    // Each assistant message = one Claude Code model response (main agent OR a
    // background sub-agent). Count it live so "Claude 调用" grows as work happens
    // (instead of only at turn end, which reads 0 during/after interrupted turns).
    const sess = await prisma.session.update({
      where: { id: this.sessionId },
      data: { claudeCalls: { increment: 1 } },
    });
    bus.emit({ type: 'usage.updated', sessionId: this.sessionId, usage: sessionUsage(sess) });

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

  /** The active Claude seat hit its usage limit. Fail over (whichever seat, in auto mode) or report. */
  private async onRateLimit(): Promise<void> {
    if (this.failingOver) return;
    this.failingOver = true;
    const account = this.account;
    // Auto mode: escalate regardless of which seat this was — the orchestrator
    // records this seat's own limit and picks the next usable one (soonest to
    // recover if both are limited). A manually-pinned seat is not auto-switched.
    if (this.accountMode === 'auto' && account !== 'machine') {
      log.warn(`session ${this.sessionId}: ${account} Claude account rate-limited`);
      void getOrchestrator().onRateLimit(this.sessionId, this.lastUserText, account);
    } else {
      const body =
        this.accountMode !== 'auto'
          ? '当前手动锁定的账号已达使用限额(未自动切换)。可在顶栏改为「自动」或切到另一个账号。'
          : '当前 Claude 账号已达使用限额。';
      bus.emit({ type: 'notification', sessionId: this.sessionId, level: 'error', title: '已达使用限额', body });
      bus.emit({ type: 'error', sessionId: this.sessionId, message: body });
      await this.monitor.finishAll('interrupted').catch(() => undefined);
      bus.emit({ type: 'run.state', sessionId: this.sessionId, state: 'idle' });
    }
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

    // Per-call usage ledger — records which seat actually served this turn, so
    // "which account is draining tokens" is a query instead of log archaeology.
    if (this.account !== 'machine') {
      await prisma.usageEvent
        .create({
          data: {
            sessionId: this.sessionId,
            account: this.account,
            trigger: 'user_turn',
            model: this.currentModel,
            inputTokens: input,
            outputTokens: output,
            costUsd: m.total_cost_usd ?? 0,
          },
        })
        .catch((err) => log.warn('usage event create failed', err));
    }

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
        // (claudeCalls is incremented live per assistant message in handleAssistant.)
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
