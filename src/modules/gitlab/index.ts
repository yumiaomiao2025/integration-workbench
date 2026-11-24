import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../http.ts';

type GitLabConfig = { baseUrl: string; clientId: string; clientSecret: string; redirectUri: string };
type OAuthAttempt = { state: string; verifier: string; expires: number };
type Credentials = { accessToken: string; refreshToken: string; expires: number };
type Profile = { id: number; username: string; name: string };
type Session = { profile: Profile; credentials: Credentials; refreshing?: Promise<void> };
type GitLabProject = { id: number; path_with_namespace: string; default_branch: string | null };
type GitLabBranch = { name: string; default: boolean; commit: { id: string } };

const pageSize = 25;
const requestTimeout = 10_000;

export class GitLab {
  private config: GitLabConfig;
  private attempts = new Map<string, OAuthAttempt>();
  private sessions = new Map<string, Session>();

  constructor(config: GitLabConfig) {
    this.config = config;
  }

  status(sessionId: string) {
    return {
      configured: Boolean(this.config.clientId),
      instance: this.config.baseUrl,
      redirectUri: this.config.redirectUri,
      profile: this.sessions.get(sessionId)?.profile || null,
    };
  }

  login(sessionId: string) {
    if (!this.config.clientId) throw new HttpError(503, '尚未配置 GitLab OAuth 应用。');
    const now = Date.now();
    for (const [id, attempt] of this.attempts) {
      if (attempt.expires < now) this.attempts.delete(id);
    }
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.attempts.set(sessionId, { state, verifier, expires: now + 600_000 });
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'read_api',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${this.config.baseUrl}/oauth/authorize?${query}`;
  }

  async callback(sessionId: string, query: URLSearchParams) {
    const attempt = this.attempts.get(sessionId);
    this.attempts.delete(sessionId);
    const state = query.get('state') || '';
    if (!attempt || attempt.expires < Date.now() || !sameState(state, attempt.state)) {
      throw new HttpError(400, 'GitLab 授权已过期，请从工作台重新连接。');
    }
    const code = query.get('code');
    if (!code) throw new HttpError(400, 'GitLab 授权未完成。');
    const credentials = await this.token({ grant_type: 'authorization_code', code, code_verifier: attempt.verifier });
    const profile = await this.request<Profile>('/user', credentials.accessToken);
    this.sessions.set(sessionId, {
      credentials,
      profile: { id: profile.id, username: profile.username, name: profile.name },
    });
  }

  logout(sessionId: string) {
    this.attempts.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  async projects(sessionId: string, query: URLSearchParams) {
    const params = listQuery(query);
    params.set('membership', 'true');
    params.set('simple', 'true');
    const result = await this.list<GitLabProject>(sessionId, '/projects', params);
    return {
      items: result.items.map((project) => ({
        id: project.id, path: project.path_with_namespace, defaultBranch: project.default_branch,
      })),
      nextPage: result.nextPage,
    };
  }

  async branches(sessionId: string, projectId: string, query: URLSearchParams) {
    const result = await this.list<GitLabBranch>(sessionId, `/projects/${projectId}/repository/branches`, listQuery(query));
    return {
      items: result.items.map((branch) => ({ name: branch.name, isDefault: branch.default, commitSha: branch.commit.id })),
      nextPage: result.nextPage,
    };
  }

  private async token(params: Record<string, string>): Promise<Credentials> {
    const body = new URLSearchParams({ ...params, client_id: this.config.clientId, redirect_uri: this.config.redirectUri });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    const response = await this.fetch(`${this.config.baseUrl}/oauth/token`, { method: 'POST', body });
    if (!response.ok) throw new HttpError(401, 'GitLab 授权失效或应用配置不匹配，请重新连接。');
    const result = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!result.access_token) throw new HttpError(502, 'GitLab 未返回有效的访问凭据。');
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token || '',
      expires: Date.now() + (result.expires_in ?? 7200) * 1000,
    };
  }

  private async accessToken(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(401, '请先连接 GitLab。');
    if (session.credentials.expires <= Date.now() + 15_000) {
      session.refreshing ??= this.token({ grant_type: 'refresh_token', refresh_token: session.credentials.refreshToken })
        .then((credentials) => { session.credentials = credentials; })
        .catch((error: unknown) => {
          if (error instanceof HttpError && error.status === 401 && this.sessions.get(sessionId) === session) {
            this.sessions.delete(sessionId);
          }
          throw error;
        })
        .finally(() => { session.refreshing = undefined; });
      await session.refreshing;
    }
    return session.credentials.accessToken;
  }

  private async list<T>(sessionId: string, path: string, params: URLSearchParams) {
    const token = await this.accessToken(sessionId);
    const response = await this.api(`${path}?${params}`, token);
    const items = await response.json() as T[];
    const reportedPage = response.headers.get('x-next-page');
    const page = Number(params.get('page'));
    const nextPage = reportedPage === null ? (items.length === pageSize ? page + 1 : null) : Number(reportedPage) || null;
    return { items, nextPage };
  }

  private async request<T>(path: string, token: string) {
    const response = await this.api(path, token);
    return await response.json() as T;
  }

  private async api(path: string, token: string) {
    const response = await this.fetch(`${this.config.baseUrl}/api/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return response;
    if (response.status === 401) throw new HttpError(401, 'GitLab 授权已失效，请从工作台重新连接。');
    if (response.status === 403 || response.status === 404) {
      throw new HttpError(response.status, '当前 GitLab 账号无法访问该仓库或分支。');
    }
    if (response.status === 429) throw new HttpError(429, 'GitLab 请求频率过高，请稍后重试。');
    throw new HttpError(502, 'GitLab 暂时无法返回数据。');
  }

  private async fetch(url: string, init: RequestInit) {
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(requestTimeout) });
    } catch {
      throw new HttpError(502, '无法连接到配置的 GitLab 实例。');
    }
  }
}

function sameState(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function listQuery(query: URLSearchParams) {
  const search = query.get('search')?.trim().slice(0, 120);
  const page = Number(query.get('page') || 1);
  if (!Number.isInteger(page) || page < 1 || page > 2000) throw new HttpError(400, '列表页码无效。');
  const params = new URLSearchParams({ page: String(page), per_page: String(pageSize) });
  if (search) params.set('search', search);
  return params;
}
