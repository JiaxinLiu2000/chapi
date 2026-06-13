import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toAgentRunDTO } from '../mappers.js';
import { getOrchestrator } from '../orchestrator/types.js';

const log = createLogger('scheduler');

/**
 * Observable timed tasks. `schedule_task` creates a "定时检查" AgentRun with a
 * scheduledFor time (so the monitor shows a live countdown); when it fires we
 * inject a turn into the session so the agent runs it — visibly.
 */
class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();

  async schedule(sessionId: string, delaySeconds: number, description: string): Promise<Date> {
    const scheduledFor = new Date(Date.now() + delaySeconds * 1000);
    const run = await prisma.agentRun.create({
      data: {
        sessionId,
        name: '定时检查',
        title: description,
        status: 'scheduled',
        scheduledFor,
        startedAt: new Date(),
      },
    });
    bus.emit({ type: 'agent.status', sessionId, agent: toAgentRunDTO(run) });
    this.arm(run.id, sessionId, description, scheduledFor.getTime() - Date.now());
    log.info(`scheduled task for session ${sessionId} in ${delaySeconds}s: ${description}`);
    return scheduledFor;
  }

  private arm(runId: string, sessionId: string, description: string, ms: number): void {
    const existing = this.timers.get(runId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => void this.fire(runId, sessionId, description), Math.max(0, ms));
    this.timers.set(runId, t);
  }

  private async fire(runId: string, sessionId: string, description: string): Promise<void> {
    this.timers.delete(runId);
    const run = await prisma.agentRun.findUnique({ where: { id: runId } }).catch(() => null);
    if (!run || run.status !== 'scheduled') return; // cancelled / session deleted
    const updated = await prisma.agentRun.update({
      where: { id: runId },
      data: { status: 'done', endedAt: new Date() },
    });
    bus.emit({ type: 'agent.status', sessionId, agent: toAgentRunDTO(updated) });
    bus.emit({
      type: 'notification',
      sessionId,
      level: 'info',
      title: '定时任务触发',
      body: description,
    });
    try {
      await getOrchestrator().handleUserMessage(sessionId, `[定时任务] 现在执行：${description}`);
    } catch (err) {
      log.warn('failed to run scheduled task', err);
    }
  }

  /** Re-arm any scheduled tasks left in the DB after a restart (overdue fire now). */
  async reloadPending(): Promise<void> {
    const pending = await prisma.agentRun
      .findMany({ where: { status: 'scheduled' } })
      .catch(() => []);
    for (const r of pending) {
      if (!r.scheduledFor) continue;
      this.arm(r.id, r.sessionId, r.title ?? '定时任务', r.scheduledFor.getTime() - Date.now());
    }
    if (pending.length) log.info(`re-armed ${pending.length} pending scheduled task(s)`);
  }
}

export const scheduler = new Scheduler();
