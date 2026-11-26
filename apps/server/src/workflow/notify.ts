import { getOrchestrator } from '../orchestrator/types.js';

/** Push a system-injected turn to the session's main AI; never fail the caller over it. */
export function notifyMainAI(sessionId: string, text: string): void {
  try {
    void getOrchestrator().handleUserMessage(sessionId, text).catch(() => undefined);
  } catch {
    /* orchestrator not ready */
  }
}
