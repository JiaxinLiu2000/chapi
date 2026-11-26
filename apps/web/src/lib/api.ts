import type {
  CreateSessionResponse,
  EarlierMessagesResponse,
  ListSessionsResponse,
  SessionDetailResponse,
  SessionDTO,
  SessionSearchResponse,
  BrowserLoginResponse,
  BrowserStatusResponse,
  EmailVerifyResponse,
  EmailVerifyStatusResponse,
  GoogleConnectResponse,
  SettingsResponse,
  UpdateSettingsInput,
  UploadResponse,
  WikiListResponse,
  WikiSearchResponse,
  WikiEntryDTO,
  WikiGraphResponse,
  WikiSyncResponse,
  WikiTagsResponse,
  WikiUpsertInput,
  WechatLoginDTO,
  WechatStatusDTO,
  WechatSessionStateDTO,
  DiscordStatusDTO,
  DiscordSessionStateDTO,
} from '@chapi/shared';
import type { WorkflowDetailDTO, WorkflowSummaryDTO } from '@chapi/shared';
import type { AutomationDTO, AutomationRunDTO, BoardProjectsDTO, BoardTodayDTO, ProjectDTO, ScheduleSpec } from '@chapi/shared';
import { API_BASE, SERVER_URL } from './config';

const OFFLINE_MSG = `无法连接后端 ${SERVER_URL} — 请确认后端已启动（在项目根目录运行 pnpm start）。`;

/** A non-2xx reply: `message` is the server's `error`, `body` the whole JSON reply. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Fields the automation editor sends (create / patch). */
export interface AutomationInput {
  name?: string;
  schedule?: ScheduleSpec;
  workflowSlug?: string | null;
  prompt?: string | null;
  inputs?: Record<string, string> | null;
  mode?: 'manual' | 'auto';
  enabled?: boolean;
  model?: string;
  effort?: string;
  projectId?: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // fetch throws a TypeError ("Failed to fetch") when the server is unreachable
    throw new Error(OFFLINE_MSG);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`, res.status, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listSessions: () => req<ListSessionsResponse>('/sessions'),

  createSession: (firstMessage?: string, config?: Record<string, unknown>) =>
    req<CreateSessionResponse>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ firstMessage, ...(config ?? {}) }),
    }),

  sessionDetail: (id: string) => req<SessionDetailResponse>(`/sessions/${id}`),

  sessionBySlug: (slug: string) =>
    req<SessionDetailResponse>(`/sessions/by-slug/${slug}`),

  earlierMessages: (sessionId: string, beforeMessageId: string) =>
    req<EarlierMessagesResponse>(
      `/sessions/${sessionId}/messages?before=${encodeURIComponent(beforeMessageId)}`,
    ),

  /** Empty title → hand it back to the AI (regenerated from the conversation). */
  renameSession: (id: string, title: string) =>
    req<{ session: SessionDTO }>(`/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  searchSessions: (q: string) =>
    req<SessionSearchResponse>(`/sessions/search?q=${encodeURIComponent(q)}`),
  deleteSession: (id: string) =>
    req<{ ok: true }>(`/sessions/${id}`, { method: 'DELETE' }),

  getSettings: () => req<SettingsResponse>('/settings'),

  updateSettings: (input: UpdateSettingsInput) =>
    req<SettingsResponse>('/settings', { method: 'PUT', body: JSON.stringify(input) }),

  connectGoogle: () => req<GoogleConnectResponse>('/google/connect', { method: 'POST' }),

  useClaudePrimary: () => req<SettingsResponse>('/settings/claude/use-primary', { method: 'POST' }),

  browserStatus: () => req<BrowserStatusResponse>('/browser/status'),
  browserStart: () => req<BrowserStatusResponse>('/browser/start', { method: 'POST' }),
  listWorkflows: () => req<WorkflowSummaryDTO[]>('/workflows'),
  getWorkflow: (ref: string) => req<WorkflowDetailDTO>(`/workflows/${encodeURIComponent(ref)}`),
  confirmWorkflow: (ref: string) => req<WorkflowDetailDTO>(`/workflows/${encodeURIComponent(ref)}/confirm`, { method: 'POST' }),
  /**
   * `keepalive`: survives the page closing (used when an undo window is cut short by unload).
   * Sent as text/plain so the cross-origin request is "simple" (no CORS preflight, which a
   * keepalive request during unload can't reliably complete); the server parses it as JSON.
   */
  cancelWorkflowRun: (sessionId: string, runId: string, reason?: string, keepalive = false) =>
    req<{ ok: true }>(`/sessions/${sessionId}/workflow-runs/${runId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
      ...(keepalive ? { keepalive: true, headers: { 'content-type': 'text/plain;charset=UTF-8' } } : {}),
    }),
  browserLogin: () => req<BrowserLoginResponse>('/browser/login', { method: 'POST' }),

  emailVerifyStatus: () => req<EmailVerifyStatusResponse>('/email-verify/status'),
  verifyEmails: (emails: string[]) =>
    req<EmailVerifyResponse>('/email-verify', { method: 'POST', body: JSON.stringify({ emails }) }),

  listWiki: () => req<WikiListResponse>('/wiki'),

  clearWiki: () => req<{ ok: true; removed: number }>('/wiki', { method: 'DELETE' }),

  wikiEntry: (slug: string) => req<{ entry: WikiEntryDTO }>(`/wiki/${slug}`),

  wikiGraph: () => req<WikiGraphResponse>('/wiki/graph'),

  wikiSync: () => req<WikiSyncResponse>('/wiki/sync', { method: 'POST' }),

  wikiTags: () => req<WikiTagsResponse>('/wiki/tags'),

  createWikiEntry: (body: WikiUpsertInput) =>
    req<{ entry: WikiEntryDTO }>('/wiki/entries', { method: 'POST', body: JSON.stringify(body) }),

  updateWikiEntry: (id: string, body: WikiUpsertInput) =>
    req<{ entry: WikiEntryDTO }>(`/wiki/entries/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  deleteWikiEntry: (id: string) => req<{ ok: true }>(`/wiki/entries/${id}`, { method: 'DELETE' }),

  searchWiki: (query: string, k?: number) =>
    req<WikiSearchResponse>('/wiki/search', {
      method: 'POST',
      body: JSON.stringify({ query, k }),
    }),

  // ── board ──
  boardToday: () => req<BoardTodayDTO>('/board/today'),
  boardProjects: () => req<BoardProjectsDTO>('/board/projects'),
  /** `id` may be "unassigned". */
  projectSessions: (id: string) => req<{ sessions: SessionDTO[] }>(`/board/projects/${encodeURIComponent(id)}/sessions`),
  classifySessions: () => req<{ started: true }>('/board/classify', { method: 'POST' }),
  refreshProjectSummary: (id: string) => req<{ project: ProjectDTO }>(`/board/projects/${encodeURIComponent(id)}/summary`, { method: 'POST' }),
  setSessionProject: (sessionId: string, projectId: string | null) =>
    req<{ ok: true }>(`/sessions/${sessionId}/project`, { method: 'PATCH', body: JSON.stringify({ projectId }) }),
  listAutomations: () => req<{ automations: AutomationDTO[] }>('/board/automations'),
  createAutomation: (body: AutomationInput) =>
    req<{ automation: AutomationDTO }>('/board/automations', { method: 'POST', body: JSON.stringify(body) }),
  updateAutomation: (id: string, body: AutomationInput) =>
    req<{ automation: AutomationDTO }>(`/board/automations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAutomation: (id: string) => req<{ ok: true }>(`/board/automations/${id}`, { method: 'DELETE' }),
  /** 409 → ApiError whose body carries `{ runId, sessionSlug }` of the run still open. */
  runAutomation: (id: string) => req<{ run: AutomationRunDTO }>(`/board/automations/${id}/run`, { method: 'POST' }),
  dismissAutomationRun: (runId: string) => req<{ ok: true }>(`/board/automation-runs/${runId}/dismiss`, { method: 'POST' }),

  async upload(sessionId: string, files: File[]): Promise<UploadResponse> {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/sessions/${sessionId}/upload`, {
        method: 'POST',
        body: form,
      });
    } catch {
      throw new Error(OFFLINE_MSG);
    }
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
    return res.json() as Promise<UploadResponse>;
  },

  // ── WeChat remote ──
  wechatStatus: () => req<{ status: WechatStatusDTO }>('/wechat/status'),
  wechatStartLogin: () => req<{ login: WechatLoginDTO }>('/wechat/login', { method: 'POST' }),
  wechatLoginState: () => req<{ login: WechatLoginDTO }>('/wechat/login'),
  wechatVerify: (code: string) =>
    req<{ login: WechatLoginDTO }>('/wechat/login/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  wechatLogout: () => req<{ status: WechatStatusDTO }>('/wechat/logout', { method: 'POST' }),
  wechatSession: (sessionId: string) => req<{ state: WechatSessionStateDTO }>(`/sessions/${sessionId}/wechat`),
  wechatConnect: (sessionId: string, on: boolean) =>
    req<{ state: WechatSessionStateDTO }>(`/sessions/${sessionId}/wechat`, { method: 'POST', body: JSON.stringify({ on }) }),

  // ── Discord remote ──
  discordStatus: () => req<{ status: DiscordStatusDTO }>('/discord/status'),
  discordConfigure: (input: { token?: string | null; channelId?: string | null }) =>
    req<{ status: DiscordStatusDTO }>('/discord/config', { method: 'PUT', body: JSON.stringify(input) }),
  discordPrefs: (input: { autoAutomations?: boolean; remindManual?: boolean }) =>
    req<{ status: DiscordStatusDTO }>('/discord/prefs', { method: 'PUT', body: JSON.stringify(input) }),
  discordSession: (sessionId: string) => req<{ state: DiscordSessionStateDTO }>(`/sessions/${sessionId}/discord`),
  discordConnect: (sessionId: string, on: boolean) =>
    req<{ state: DiscordSessionStateDTO }>(`/sessions/${sessionId}/discord`, { method: 'POST', body: JSON.stringify({ on }) }),
};
