import { create } from 'zustand';
import type {
  AgentRunDTO,
  ApprovalRequestDTO,
  ArtifactDTO,
  MessageDTO,
  NotificationLevel,
  PendingQuestionDTO,
  PlanTaskDTO,
  RunState,
  ServerEvent,
  SessionDetailResponse,
  SessionDTO,
  ToolCallDTO,
  UsageDTO,
} from '@chapi/shared';

export interface ToastNotification {
  level: NotificationLevel;
  title: string;
  body: string;
  ts: number;
}

interface ChapiState {
  // session list (history)
  sessions: SessionDTO[];

  // active session runtime
  sessionId: string | null;
  session: SessionDTO | null;
  messages: MessageDTO[];
  streaming: string;
  plan: PlanTaskDTO[];
  agents: AgentRunDTO[];
  toolCalls: ToolCallDTO[];
  artifacts: ArtifactDTO[];
  usage: UsageDTO | null;
  runState: RunState;
  questions: PendingQuestionDTO[];
  approvals: ApprovalRequestDTO[];
  toast: ToastNotification | null;

  setSessions: (s: SessionDTO[]) => void;
  loadDetail: (d: SessionDetailResponse) => void;
  resetActive: () => void;
  clearToast: () => void;
  addOptimisticUser: (text: string) => void;
  applyEvent: (e: ServerEvent) => void;
}

const upsertById = <T extends { id: string }>(list: T[], item: T): T[] => {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
};

export const useStore = create<ChapiState>((set, get) => ({
  sessions: [],
  sessionId: null,
  session: null,
  messages: [],
  streaming: '',
  plan: [],
  agents: [],
  toolCalls: [],
  artifacts: [],
  usage: null,
  runState: 'idle',
  questions: [],
  approvals: [],
  toast: null,

  setSessions: (s) => set({ sessions: s }),

  loadDetail: (d) =>
    set({
      sessionId: d.session.id,
      session: d.session,
      messages: d.messages,
      streaming: '',
      plan: d.plan,
      agents: d.agents,
      artifacts: d.artifacts,
      usage: d.session.usage,
      questions: d.openQuestions,
      approvals: [],
      runState: 'idle',
      toolCalls: [],
    }),

  resetActive: () =>
    set({
      sessionId: null,
      session: null,
      messages: [],
      streaming: '',
      plan: [],
      agents: [],
      toolCalls: [],
      artifacts: [],
      usage: null,
      runState: 'idle',
      questions: [],
      approvals: [],
    }),

  clearToast: () => set({ toast: null }),

  addOptimisticUser: (text) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: `optimistic-${Date.now()}`,
          sessionId: s.sessionId ?? '',
          role: 'user',
          type: 'user',
          content: [{ type: 'text', text }],
          text,
          tokens: 0,
          agentRunId: null,
          createdAt: new Date().toISOString(),
        },
      ],
    })),

  applyEvent: (e) => {
    const active = get().sessionId;
    const forActive = (sid: string | null) => sid === null || sid === active;

    switch (e.type) {
      case 'session.created':
        set((s) => ({ sessions: upsertById(s.sessions, e.session) }));
        break;
      case 'session.updated':
        set((s) => ({
          sessions: upsertById(s.sessions, e.session),
          session: e.session.id === active ? e.session : s.session,
          usage: e.session.id === active ? e.session.usage : s.usage,
        }));
        break;
      case 'run.state':
        if (forActive(e.sessionId)) set({ runState: e.state });
        break;
      case 'assistant.delta':
        if (forActive(e.sessionId)) set((s) => ({ streaming: s.streaming + e.text }));
        break;
      case 'assistant.message':
        if (forActive(e.sessionId))
          set((s) => ({ messages: [...s.messages, e.message], streaming: '' }));
        break;
      case 'plan.updated':
        if (forActive(e.sessionId)) set({ plan: e.tasks });
        break;
      case 'agent.status':
        if (forActive(e.sessionId)) set((s) => ({ agents: upsertById(s.agents, e.agent) }));
        break;
      case 'tool.started':
        if (forActive(e.sessionId))
          set((s) => ({ toolCalls: upsertById(s.toolCalls, e.toolCall).slice(-100) }));
        break;
      case 'tool.updated':
        if (forActive(e.sessionId))
          set((s) => ({
            toolCalls: s.toolCalls.map((t) =>
              t.id === e.toolCallId
                ? { ...t, status: e.status ?? t.status }
                : t,
            ),
          }));
        break;
      case 'tool.finished':
        if (forActive(e.sessionId))
          set((s) => ({
            toolCalls: s.toolCalls.map((t) =>
              t.id === e.toolCallId
                ? { ...t, status: e.status, durationMs: e.durationMs, outputPreview: e.outputPreview ?? t.outputPreview }
                : t,
            ),
          }));
        break;
      case 'usage.updated':
        if (forActive(e.sessionId)) set({ usage: e.usage });
        break;
      case 'question.open':
        if (forActive(e.sessionId))
          set((s) => ({
            questions: upsertById(s.questions, e.question),
            toast: { level: 'question', title: '需要你的输入', body: e.question.question, ts: Date.now() },
          }));
        break;
      case 'question.closed':
        if (forActive(e.sessionId))
          set((s) => ({ questions: s.questions.filter((q) => q.id !== e.questionId) }));
        break;
      case 'approval.request':
        if (forActive(e.sessionId))
          set((s) => ({
            approvals: upsertById(s.approvals, e.approval),
            toast: { level: 'success', title: '待审批', body: e.approval.summary, ts: Date.now() },
          }));
        break;
      case 'approval.closed':
        if (forActive(e.sessionId))
          set((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.approvalId) }));
        break;
      case 'artifact.ready':
        if (forActive(e.sessionId)) set((s) => ({ artifacts: upsertById(s.artifacts, e.artifact) }));
        break;
      case 'notification':
        if (forActive(e.sessionId))
          set({ toast: { level: e.level, title: e.title, body: e.body, ts: Date.now() } });
        break;
      case 'error':
        if (forActive(e.sessionId))
          set({ toast: { level: 'error', title: '错误', body: e.message, ts: Date.now() } });
        break;
    }
  },
}));
