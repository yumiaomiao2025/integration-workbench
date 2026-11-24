import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { readConfig, settingsPath } from './config.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import { ChromeCollector } from './modules/chrome/index.ts';
import { checkChromeEndpoint } from './modules/chrome/cdp.ts';
import { GitLab } from './modules/gitlab/index.ts';
import { SettingsStore } from './modules/settings/index.ts';
import { parseTask, TaskStore } from './modules/tasks/index.ts';

type Config = ReturnType<typeof readConfig>;
const assetTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
]);

export async function createWorkbench(config: Config) {
  const workbench = await createWorkbenchHandler(config);
  const server = createServer(workbench.handle);
  server.on('close', workbench.close);
  return server;
}

export async function createWorkbenchHandler(config: Config) {
  const store = await TaskStore.open(config.dataFile);
  const settings = await SettingsStore.open(settingsPath(config.dataFile), config);
  let gitlabConfig = settings.gitlab();
  await store.setLegacyInstance(gitlabConfig.baseUrl);
  let gitlab = new GitLab(gitlabConfig);
  const chrome = new ChromeCollector(settings.chromeDataDir());
  const expectedHost = new URL(config.origin).host;

  async function route(request: IncomingMessage, response: ServerResponse) {
    setHeaders(response);
    if (request.headers.host !== expectedHost) throw new HttpError(403, '请通过工作台的本机地址访问。');
    const url = new URL(request.url || '/', config.origin);
    if (url.origin !== config.origin) throw new HttpError(403, '请求地址不属于当前工作台。');
    const method = request.method || 'GET';
    if (!['GET', 'HEAD'].includes(method) && request.headers.origin !== config.origin) {
      throw new HttpError(403, '请从工作台页面提交操作。');
    }
    const { pathname: path, searchParams: query } = url;
    const assetType = /^\/assets\/[\w.-]+$/.test(path) ? assetTypes.get(extname(path)) : undefined;
    if ((path === '/' || assetType) && (method === 'GET' || method === 'HEAD')) {
      const file = path === '/' ? 'index.html' : path.slice(1);
      const contents = await readFile(join(config.distDir, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        if (path === '/') throw new HttpError(503, '请运行 pnpm build 构建工作台前端。');
        throw new HttpError(404, '找不到工作台前端资源。');
      });
      if (path === '/') browserSession(request, response);
      response.writeHead(200, { 'Content-Type': assetType || 'text/html; charset=utf-8' });
      response.end(method === 'HEAD' ? undefined : contents);
      return;
    }

    if (method === 'GET' && path === '/api/settings') return sendJson(response, settings.publicSettings());
    if (method === 'PUT' && path === '/api/settings/gitlab') {
      await settings.setGitLab(await readJson(request));
      const next = settings.gitlab();
      if (next.baseUrl !== gitlabConfig.baseUrl || next.clientId !== gitlabConfig.clientId || next.clientSecret !== gitlabConfig.clientSecret) {
        gitlabConfig = next;
        gitlab = new GitLab(next);
      }
      return sendJson(response, settings.publicSettings());
    }
    if (method === 'PUT' && path === '/api/settings/chrome') {
      await settings.setChrome(await readJson(request));
      chrome.setDataDirectory(settings.chromeDataDir());
      return sendJson(response, settings.publicSettings());
    }
    if (method === 'POST' && path === '/api/settings/chrome/check') {
      const dataDir = settings.chromePathToCheck(await readJson(request));
      return sendJson(response, await checkChromeEndpoint(dataDir));
    }

    if (path.startsWith('/api/gitlab/')) {
      const connection = gitlab;
      const sessionId = browserSession(request, response);
      if (method === 'GET' && path === '/api/gitlab/status') return sendJson(response, connection.status(sessionId));
      if (method === 'GET' && path === '/api/gitlab/login') return redirect(response, connection.login(sessionId));
      if (method === 'GET' && path === '/api/gitlab/callback') {
        try {
          await connection.callback(sessionId, query);
          if (connection !== gitlab) throw new HttpError(409, 'GitLab 配置已变更，请重新授权。');
          return redirect(response, '/?gitlab=connected');
        } catch (error) {
          const message = error instanceof HttpError ? error.message : 'GitLab 授权失败，请检查应用配置。';
          return redirect(response, `/?${new URLSearchParams({ gitlab: 'error', message })}`);
        }
      }
      if (method === 'POST' && path === '/api/gitlab/logout') {
        connection.logout(sessionId);
        return sendJson(response, connection.status(sessionId));
      }
      if (method === 'GET' && path === '/api/gitlab/projects') return sendJson(response, await connection.projects(sessionId, query));
      const branches = /^\/api\/gitlab\/projects\/(\d+)\/branches$/.exec(path);
      if (method === 'GET' && branches) return sendJson(response, await connection.branches(sessionId, branches[1], query));
    }

    if (method === 'GET' && path === '/api/chrome/status') return sendJson(response, chrome.status());
    if (method === 'POST' && path === '/api/chrome/connect') {
      chrome.connect();
      return sendJson(response, chrome.status(), 202);
    }
    if (method === 'POST' && path === '/api/chrome/disconnect') {
      chrome.disconnect();
      return sendJson(response, chrome.status());
    }

    if (method === 'GET' && path === '/api/tasks') return sendJson(response, store.list());
    if (method === 'POST' && path === '/api/tasks') {
      const task = await store.create(parseTask(await readJson(request), gitlabConfig.baseUrl));
      chrome.activate(task);
      return sendJson(response, task, 201);
    }
    const taskPath = /^\/api\/tasks\/([\da-f-]{36})(?:\/(activate|live|tab|evidence))?$/.exec(path);
    if (taskPath) {
      const [, id, action] = taskPath;
      const task = store.get(id);
      if (method === 'GET' && !action) return sendJson(response, task);
      if (method === 'PUT' && !action) {
        const next = await store.update(id, parseTask(await readJson(request), gitlabConfig.baseUrl));
        if (chrome.status().activeTaskId === id) chrome.activate(next);
        return sendJson(response, next);
      }
      if (method === 'POST' && action === 'activate') {
        chrome.activate(task);
        return sendJson(response, chrome.status());
      }
      if (method === 'GET' && action === 'live') {
        const capture = chrome.live(id);
        const etag = `"${capture.revision}"`;
        response.setHeader('ETag', etag);
        if (request.headers['if-none-match'] === etag) {
          response.writeHead(304);
          return response.end();
        }
        return sendJson(response, { connection: chrome.status(), capture });
      }
      if (method === 'POST' && action === 'tab') {
        chrome.choose(id, stringField(await readJson(request), 'tabId'));
        return sendJson(response, chrome.live(id), 202);
      }
      if (method === 'POST' && action === 'evidence') {
        const value = await readJson(request) as { ids?: unknown } | null;
        if (!Array.isArray(value?.ids) || value.ids.length < 1 || value.ids.length > 400
          || !value.ids.every((entry) => typeof entry === 'string' && /^[\da-f-]{36}$/.test(entry))) {
          throw new HttpError(400, '请选择要保存的请求或日志。');
        }
        const selected = chrome.selected(id, [...new Set<string>(value.ids)], task.evidence);
        return sendJson(response, await store.saveEvidence(id, selected));
      }
    }
    throw new HttpError(404, '页面或接口不存在。');
  }

  function handle(request: IncomingMessage, response: ServerResponse) {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) sendJson(response, { error: error.message }, error.status);
      else {
        console.error(error);
        sendJson(response, { error: '工作台遇到错误，请查看本机服务日志后重试。' }, 500);
      }
    });
  }
  return { handle, close: () => chrome.disconnect() };
}

function setHeaders(response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function browserSession(request: IncomingMessage, response: ServerResponse) {
  const match = /(?:^|;\s*)workbench_session=([\w-]{43})(?:;|$)/.exec(request.headers.cookie || '');
  if (match) return match[1];
  const id = randomBytes(32).toString('base64url');
  response.setHeader('Set-Cookie', `workbench_session=${id}; HttpOnly; SameSite=Lax; Path=/`);
  return id;
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(302, { Location: location });
  response.end();
}

function stringField(value: unknown, field: string) {
  if (value && typeof value === 'object') {
    const fieldValue = (value as Record<string, unknown>)[field];
    if (typeof fieldValue === 'string' && fieldValue.length > 0 && fieldValue.length <= 200) return fieldValue;
  }
  throw new HttpError(400, '请从当前列表选择一个标签页。');
}

if (import.meta.main) {
  try {
    const config = readConfig();
    const server = await createWorkbench(config);
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    server.listen(config.port, '127.0.0.1', () => console.log(`联调工作台  ${config.origin}`));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
