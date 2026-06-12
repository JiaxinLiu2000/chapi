/**
 * Human-in-the-loop registry. SDK MCP tools (ask_user / request_approval) await
 * here; the gateway resolves them when the user answers/decides. Ids are unique
 * across sessions, so a single process-wide registry is enough.
 */
export interface ApprovalDecision {
  decision: 'approve' | 'reject' | 'revise';
  feedback?: string;
}

class HitlRegistry {
  private questions = new Map<string, (answer: string) => void>();
  private approvals = new Map<string, (d: ApprovalDecision) => void>();

  waitForQuestion(id: string): Promise<string> {
    return new Promise<string>((resolve) => this.questions.set(id, resolve));
  }

  resolveQuestion(id: string, answer: string): boolean {
    const resolve = this.questions.get(id);
    if (!resolve) return false;
    this.questions.delete(id);
    resolve(answer);
    return true;
  }

  waitForApproval(id: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => this.approvals.set(id, resolve));
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const resolve = this.approvals.get(id);
    if (!resolve) return false;
    this.approvals.delete(id);
    resolve(decision);
    return true;
  }
}

export const hitl = new HitlRegistry();
