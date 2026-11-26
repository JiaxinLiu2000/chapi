import { bus } from '../gateway/bus.js';

/**
 * Human-in-the-loop registry. SDK MCP tools (ask_user / request_approval) await
 * here; the gateway resolves them when the user answers/decides. Ids are unique
 * across sessions, so a single process-wide registry is enough.
 *
 * It also knows which sessions are currently blocked on the user (an open
 * ask_user / request_approval call), so side agents such as the 质检 advisor can
 * stand still while the main agent waits for feedback.
 */
export interface ApprovalDecision {
  decision: 'approve' | 'reject' | 'revise';
  feedback?: string;
}

type WaitListener = (sessionId: string, waiting: boolean) => void;

class HitlRegistry {
  private questions = new Map<string, (answer: string) => void>();
  private approvals = new Map<string, (d: ApprovalDecision) => void>();
  /** sessionId → ids of HITL calls that session's main agent is blocked on. */
  private waits = new Map<string, Set<string>>();
  private listeners = new Set<WaitListener>();

  constructor() {
    // A turn that ended (or was interrupted) can't still be blocked on a tool call:
    // forget its waits so they never pin the session as "waiting" forever.
    bus.on((e) => {
      if (e.type === 'run.state' && e.state !== 'running' && e.state !== 'paused') this.clearSession(e.sessionId);
    });
  }

  waitForQuestion(id: string, sessionId?: string): Promise<string> {
    const p = new Promise<string>((resolve) => this.questions.set(id, resolve));
    if (sessionId) this.addWait(sessionId, id);
    return p;
  }

  resolveQuestion(id: string, answer: string): boolean {
    const resolve = this.questions.get(id);
    if (!resolve) return false;
    this.questions.delete(id);
    this.removeWait(id);
    resolve(answer);
    return true;
  }

  waitForApproval(id: string, sessionId?: string): Promise<ApprovalDecision> {
    const p = new Promise<ApprovalDecision>((resolve) => this.approvals.set(id, resolve));
    if (sessionId) this.addWait(sessionId, id);
    return p;
  }

  /** True while a live request_approval call is blocked on this approval. */
  hasApproval(id: string): boolean {
    return this.approvals.has(id);
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const resolve = this.approvals.get(id);
    if (!resolve) return false;
    this.approvals.delete(id);
    this.removeWait(id);
    resolve(decision);
    return true;
  }

  /** True while this session's main agent is blocked on the user (question or approval). */
  isWaiting(sessionId: string): boolean {
    return (this.waits.get(sessionId)?.size ?? 0) > 0;
  }

  /** Sessions whose main agent is blocked on the user right now (read-only snapshot). */
  waitingSessionIds(): string[] {
    return [...this.waits].filter(([, set]) => set.size > 0).map(([id]) => id);
  }

  /** What this session is blocked on right now: an approval wins over a question; null if not waiting. */
  waitKind(sessionId: string): 'question' | 'approval' | null {
    const set = this.waits.get(sessionId);
    if (!set?.size) return null;
    for (const id of set) if (this.approvals.has(id)) return 'approval';
    return 'question';
  }

  onWaitChange(listener: WaitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private addWait(sessionId: string, id: string): void {
    const set = this.waits.get(sessionId) ?? new Set<string>();
    const was = set.size > 0;
    set.add(id);
    this.waits.set(sessionId, set);
    if (!was) this.notify(sessionId, true);
  }

  private removeWait(id: string): void {
    for (const [sessionId, set] of this.waits) {
      if (!set.delete(id)) continue;
      if (set.size === 0) {
        this.waits.delete(sessionId);
        this.notify(sessionId, false);
      }
      return;
    }
  }

  private clearSession(sessionId: string): void {
    if (!this.waits.has(sessionId)) return;
    this.waits.delete(sessionId);
    this.notify(sessionId, false);
  }

  private notify(sessionId: string, waiting: boolean): void {
    for (const l of this.listeners) {
      try {
        l(sessionId, waiting);
      } catch {
        /* a listener must never break HITL */
      }
    }
  }
}

export const hitl = new HitlRegistry();
