import type {
  CreateSessionResponse,
  ListSessionsResponse,
  SessionDetailResponse,
  GoogleConnectResponse,
  SettingsResponse,
  UpdateSettingsInput,
  UploadResponse,
  WikiListResponse,
  WikiSearchResponse,
  WikiEntryDTO,
} from '@chapi/shared';
import { API_BASE, SERVER_URL } from './config';

const OFFLINE_MSG = `无法连接后端 ${SERVER_URL} — 请确认后端已启动（在项目根目录运行 pnpm start）。`;

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
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listSessions: () => req<ListSessionsResponse>('/sessions'),

  createSession: (firstMessage?: string) =>
    req<CreateSessionResponse>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ firstMessage }),
    }),

  sessionDetail: (id: string) => req<SessionDetailResponse>(`/sessions/${id}`),

  sessionBySlug: (slug: string) =>
    req<SessionDetailResponse>(`/sessions/by-slug/${slug}`),

  deleteSession: (id: string) =>
    req<{ ok: true }>(`/sessions/${id}`, { method: 'DELETE' }),

  getSettings: () => req<SettingsResponse>('/settings'),

  updateSettings: (input: UpdateSettingsInput) =>
    req<SettingsResponse>('/settings', { method: 'PUT', body: JSON.stringify(input) }),

  connectGoogle: () => req<GoogleConnectResponse>('/google/connect', { method: 'POST' }),

  listWiki: () => req<WikiListResponse>('/wiki'),

  wikiEntry: (slug: string) => req<{ entry: WikiEntryDTO }>(`/wiki/${slug}`),

  searchWiki: (query: string, k?: number) =>
    req<WikiSearchResponse>('/wiki/search', {
      method: 'POST',
      body: JSON.stringify({ query, k }),
    }),

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
};
