import type { ConnectionStatus, EvidenceAnalysis, LiveCapture, Task, TaskInput } from '../../src/contracts.ts';

export type TaskSummary = Omit<Task, 'evidence'> & { evidenceCount: number };
export type GitLabStatus = {
  configured: boolean;
  instance: string;
  redirectUri: string;
  profile: { id: number; name: string; username: string } | null;
};
export type GitLabSettings = {
  baseUrl: string;
  clientId: string;
  confidential: boolean;
  hasSecret: boolean;
  secretProtection: 'windows' | 'session';
  redirectUri: string;
};
export type GitLabSettingsInput = Pick<GitLabSettings, 'baseUrl' | 'clientId' | 'confidential'> & { clientSecret: string };
export type ChromeSettings = { dataDir: string; defaultDataDir: string };
type ConnectionSettings = { gitlab: GitLabSettings; chrome: ChromeSettings };
export type ChromeDetection = { ready: boolean; message: string };
export type Project = { id: number; path: string; defaultBranch?: string | null };
export type Branch = { name: string; isDefault?: boolean; commitSha: string };
type Page<T> = { items: T[]; nextPage: number | null };
type LiveStatus = { connection: ConnectionStatus; capture: LiveCapture };

export const gitLabLogin = '/api/gitlab/login';

type Options = { method?: string; body?: unknown; signal?: AbortSignal; etag?: string };

async function request(path: string, options: Options) {
  const { method = 'GET', body, signal, etag } = options;
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (etag) headers.set('If-None-Match', etag);
  const response = await fetch(`/api${path}`, { method, headers, body: JSON.stringify(body), cache: 'no-store', signal });
  if (!response.ok && response.status !== 304) {
    const info = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(info?.error || `请求失败 (${response.status})`);
  }
  return response;
}

async function json<T>(path: string, options: Options = {}): Promise<T> {
  return (await request(path, options)).json();
}

function list<T>(path: string, search: string, page: number, signal: AbortSignal) {
  const params = new URLSearchParams({ search: search.trim(), page: String(page) });
  return json<Page<T>>(`${path}?${params}`, { signal });
}

export const api = {
  tasks: (signal: AbortSignal) => json<TaskSummary[]>('/tasks', { signal }),
  task: (id: string, signal?: AbortSignal) => json<Task>(`/tasks/${id}`, { signal }),
  activate: (id: string, signal?: AbortSignal) => json<ConnectionStatus>(`/tasks/${id}/activate`, { method: 'POST', signal }),
  saveTask: (id: string | undefined, body: TaskInput) => json<Task>(id ? `/tasks/${id}` : '/tasks', { method: id ? 'PUT' : 'POST', body }),
  saveEvidence: (id: string, ids: string[]) => json<Task>(`/tasks/${id}/evidence`, { method: 'POST', body: { ids } }),
  analyzeEvidence: (id: string, ids: string[]) => json<EvidenceAnalysis>(`/tasks/${id}/analysis`, { method: 'POST', body: { ids } }),
  chooseTab: (id: string, tabId: string) => json<LiveCapture>(`/tasks/${id}/tab`, { method: 'POST', body: { tabId } }),
  async live(id: string, etag: string, signal: AbortSignal) {
    const response = await request(`/tasks/${id}/live`, { etag, signal });
    if (response.status === 304) return null;
    return { status: await response.json() as LiveStatus, etag: response.headers.get('ETag') || '' };
  },
  chromeStatus: (signal?: AbortSignal) => json<ConnectionStatus>('/chrome/status', { signal }),
  chromeConnect: (action: 'connect' | 'disconnect') => json<ConnectionStatus>(`/chrome/${action}`, { method: 'POST' }),
  chromeCheck: (dataDir: string, signal: AbortSignal) => json<ChromeDetection>('/settings/chrome/check', { method: 'POST', body: { dataDir }, signal }),
  settings: (signal: AbortSignal) => json<ConnectionSettings>('/settings', { signal }),
  saveChrome: (dataDir: string) => json<ConnectionSettings>('/settings/chrome', { method: 'PUT', body: { dataDir } }),
  saveGitLab: (body: GitLabSettingsInput) => json<ConnectionSettings>('/settings/gitlab', { method: 'PUT', body }),
  gitLabStatus: (signal?: AbortSignal) => json<GitLabStatus>('/gitlab/status', { signal }),
  gitLabLogout: () => json<GitLabStatus>('/gitlab/logout', { method: 'POST' }),
  projects: (search: string, page: number, signal: AbortSignal) => list<Project>('/gitlab/projects', search, page, signal),
  branches: (projectId: number, search: string, page: number, signal: AbortSignal) => list<Branch>(`/gitlab/projects/${projectId}/branches`, search, page, signal),
};

export function explain(error: unknown) {
  if (error instanceof TypeError) return '无法访问本机工作台，请确认服务正在运行。';
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
