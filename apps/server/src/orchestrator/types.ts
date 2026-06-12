/**
 * The Orchestrator drives a session's agent run. The WebSocket gateway calls it
 * in response to client commands; it emits ServerEvents back through the bus.
 *
 * M1 ships a stub; M2 replaces it with the Claude Agent SDK engine.
 */
export interface Orchestrator {
  /** A user sent a message (the first message starts the run). */
  handleUserMessage(
    sessionId: string,
    text: string,
    attachmentIds?: string[],
  ): Promise<void>;

  /** Interrupt the currently running agent for this session. */
  interrupt(sessionId: string): Promise<void>;

  /** The user answered an open HITL question. */
  answerQuestion(sessionId: string, questionId: string, answer: string): Promise<void>;

  /** The user made a decision on an approval request. */
  decideApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject' | 'revise',
    feedback?: string,
  ): Promise<void>;

  /** The user clicked the green "brilliantly done" button. */
  markCompleted(sessionId: string): Promise<void>;

  /** Stop and drop a session's run (called before deleting the session). */
  abandon(sessionId: string): Promise<void>;

  /** Switch the session's model (live) and/or effort (next turn). */
  setConfig(sessionId: string, model?: string, effort?: string): Promise<void>;

  /** True if a run is currently active for this session. */
  isActive(sessionId: string): boolean;
}

let active: Orchestrator | null = null;

export function setOrchestrator(orchestrator: Orchestrator): void {
  active = orchestrator;
}

export function getOrchestrator(): Orchestrator {
  if (!active) throw new Error('Orchestrator not initialized');
  return active;
}
