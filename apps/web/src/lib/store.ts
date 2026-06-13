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
  /** If set, the toast is clickable and navigates to this session (background alert). */
  sessionSlug?: string;
}

export interface BrowserPaneState {
  frame: string | null; // base64 jpeg
  url: string | null;
  status: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable';
  message: string | null;
}

const idlePane = (): BrowserPaneState => ({
  frame: null,
  url: null,
  status: 'idle',
  message: null,
});
const idlePanes = (): BrowserPaneState[] => [idlePane(), idlePane()];

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

  // live cloakbrowser view
  browserPages: BrowserPaneState[]; // up to 2 live panes
  browserPageCount: number; // 1 or 2
  browserViewOn: boolean;

  setSessions: (s: SessionDTO[]) => void;
  loadDetail: (d: SessionDetailResponse) => void;
  resetActive: () => void;
  setBrowserViewOn: (on: boolean) => void;
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
  browserPages: idlePanes(),
  browserPageCount: 1,
  browserViewOn: false,

  setSessions: (s) => set({ sessions: s }),
  setBrowserViewOn: (on) => set({ browserViewOn: on }),

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
      browserPages: idlePanes(),
      browserPageCount: 1,
      browserViewOn: false,
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
      browserPages: idlePanes(),
      browserPageCount: 1,
      browserViewOn: false,
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
      case 'browser.frame':
        if (forActive(e.sessionId))
          set((s) => {
            const pages = s.browserPages.slice();
            const prev = pages[e.page] ?? idlePane();
            pages[e.page] = { ...prev, frame: e.dataBase64, url: e.url ?? prev.url };
            return { browserPages: pages };
          });
        break;
      case 'browser.state':
        if (forActive(e.sessionId))
          set((s) => {
            const pages = s.browserPages.slice();
            const prev = pages[e.page] ?? idlePane();
            pages[e.page] = {
              ...prev,
              status: e.status,
              url: e.url ?? prev.url,
              message: e.message ?? null,
            };
            return { browserPages: pages, browserPageCount: e.pageCount };
          });
        break;
      case 'error':
        if (forActive(e.sessionId))
          set({ toast: { level: 'error', title: '错误', body: e.message, ts: Date.now() } });
        break;
    }
  },
}));
