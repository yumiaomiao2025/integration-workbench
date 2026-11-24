import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { readConfig, settingsPath } from './config.ts';
import type { AnalysisMessage, Task } from './contracts.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import { analyzeWithClaude, checkClaude, type EvidenceAnalyzer } from './modules/analysis/index.ts';
import { ChromeCollector } from './modules/chrome/index.ts';
import { checkChromeEndpoint } from './modules/chrome/cdp.ts';
import { GitLab } from './modules/gitlab/index.ts';
import { parseChromePath, SettingsStore } from './modules/settings/index.ts';
import { parseTask, TaskStore } from './modules/tasks/index.ts';

type Config = ReturnType<typeof readConfig>;
const assetTypes = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2'],
]);

export async function createWorkbench(config: Config, analyze?: EvidenceAnalyzer) {
  const workbench = await createWorkbenchHandler(config, analyze);
  const server = createServer(workbench.handle);
  server.on('close', workbench.close);
  return server;
}

export async function createWorkbenchHandler(config: Config, analyze: EvidenceAnalyzer = analyzeWithClaude) {
  const settings = await SettingsStore.open(settingsPath(config.dataFile), config);
  let gitlabConfig = settings.gitlab();
  const store = await TaskStore.open(config.dataFile, gitlabConfig.baseUrl);
  let gitlab = new GitLab(gitlabConfig);
  const defaultChromeDirectory = settings.chromeDataDir();
  const collectors = new Map<string, ChromeCollector>();
  const expectedHost = new URL(config.origin).host;
  let analysisRunning = false;

  function collectorFor(task: Task) {
    let collector = collectors.get(task.id);
    if (!collector) {
      collector = new ChromeCollector(task.chromeDataDir || defaultChromeDirectory, task.url, config.origin);
      collectors.set(task.id, collector);
    }
    return collector;
  }

  function configureCollector(task: Task) {
    collectors.get(task.id)?.configure(task.chromeDataDir || defaultChromeDirectory, task.url);
  }

  function chromeSettings(task: Task) {
    return { dataDir: task.chromeDataDir || '', defaultDataDir: defaultChromeDirectory };
  }

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
    if (method === 'POST' && path === '/api/claude/check') {
      return withResponseSignal(response, checkClaude);
    }
    if (method === 'PUT' && path === '/api/settings/gitlab') {
      await settings.setGitLab(await readJson(request));
      const next = settings.gitlab();
      if (next.baseUrl !== gitlabConfig.baseUrl || next.clientId !== gitlabConfig.clientId || next.clientSecret !== gitlabConfig.clientSecret) {
        gitlabConfig = next;
        gitlab = new GitLab(next);
      }
      return sendJson(response, settings.publicSettings());
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

    if (method === 'GET' && path === '/api/tasks') return sendJson(response, store.list());
    if (method === 'POST' && path === '/api/tasks') {
      const task = await store.create(parseTask(await readJson(request), gitlabConfig.baseUrl));
      return sendJson(response, task, 201);
    }
    const taskPath = /^\/api\/tasks\/([\da-f-]{36})(?:\/(live|tab|evidence|analysis|chrome(?:\/(?:check|connect|disconnect))?))?$/.exec(path);
    if (taskPath) {
      const [, id, action] = taskPath;
      const task = store.get(id);
      if (method === 'GET' && !action) return sendJson(response, task);
      if (method === 'PUT' && !action) {
        const next = await store.update(id, parseTask(await readJson(request), gitlabConfig.baseUrl));
        configureCollector(next);
        return sendJson(response, next);
      }
      if (action === 'chrome') {
        if (method === 'GET') return sendJson(response, chromeSettings(task));
        if (method === 'PUT') {
          const dataDir = parseChromePath(await readJson(request));
          const next = await store.update(id, { chromeDataDir: dataDir || undefined });
          configureCollector(next);
          return sendJson(response, chromeSettings(next));
        }
      }
      if (method === 'POST' && action === 'chrome/check') {
        const dataDir = parseChromePath(await readJson(request));
        return sendJson(response, await checkChromeEndpoint(dataDir || defaultChromeDirectory));
      }
      if (method === 'POST' && action === 'chrome/connect') {
        const chrome = collectorFor(task);
        chrome.connect();
        return sendJson(response, chrome.status(), 202);
      }
      if (method === 'POST' && action === 'chrome/disconnect') {
        const chrome = collectorFor(task);
        chrome.disconnect();
        return sendJson(response, chrome.status());
      }
      if (method === 'GET' && action === 'live') {
        const chrome = collectorFor(task);
        const capture = chrome.live();
        const etag = `"${capture.revision}"`;
        response.setHeader('ETag', etag);
        if (request.headers['if-none-match'] === etag) {
          response.writeHead(304);
          return response.end();
        }
        return sendJson(response, { connection: chrome.status(), capture });
      }
      if ((method === 'POST' || method === 'DELETE') && action === 'tab') {
        const targetId = stringField(await readJson(request), 'tabId');
        const chrome = collectorFor(store.get(id));
        if (method === 'POST') chrome.choose(targetId);
        else chrome.remove(targetId);
        return sendJson(response, chrome.live(), method === 'POST' ? 202 : 200);
      }
      if (method === 'POST' && action === 'evidence') {
        const ids = evidenceIds(await readJson(request));
        const current = store.get(id);
        const selected = collectorFor(current).selected(ids, current.evidence);
        return sendJson(response, await store.saveEvidence(id, selected));
      }
      if (method === 'POST' && action === 'analysis') {
        const input = await readJson(request);
        const ids = evidenceIds(input, true);
        const messages = analysisMessages(input);
        if (!ids.length && !messages.length) throw new HttpError(400, '请先输入问题或引用证据。');
        if (analysisRunning) throw new HttpError(409, '已有一批证据在分析，请等它完成后再试。');
        const current = store.get(id);
        const saved = new Map(current.evidence.map((entry) => [entry.id, entry]));
        const selected = ids.map((entryId) => {
          const entry = saved.get(entryId);
          if (!entry) throw new HttpError(409, '有选中的证据尚未保存，请保存后重试。');
          return entry;
        });
        analysisRunning = true;
        try {
          await withResponseSignal(response, (signal) => analyze(current, selected, signal, messages));
        } finally {
          analysisRunning = false;
        }
        return;
      }
    }
    throw new HttpError(404, '页面或接口不存在。');
  }

  function handle(request: IncomingMessage, response: ServerResponse) {
    void route(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      if (response.headersSent) return response.destroy();
      if (error instanceof HttpError) sendJson(response, { error: error.message }, error.status);
      else {
        console.error(error);
        sendJson(response, { error: '工作台遇到错误，请查看本机服务日志后重试。' }, 500);
      }
    });
  }
  return { handle, close: () => {
    for (const chrome of collectors.values()) chrome.disconnect();
    collectors.clear();
  } };
}

async function withResponseSignal(response: ServerResponse, run: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once('close', cancel);
  try {
    if (response.destroyed) return;
    const result = await run(controller.signal);
    if (!controller.signal.aborted) sendJson(response, result);
  } finally {
    response.off('close', cancel);
  }
}

function evidenceIds(value: unknown, allowEmpty = false) {
  const ids = (value as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || (!allowEmpty && !ids.length) || ids.length > 400
    || !ids.every((entry) => typeof entry === 'string' && /^[\da-f-]{36}$/.test(entry))) {
    throw new HttpError(400, '请选择 1 至 400 条请求或日志。');
  }
  return [...new Set<string>(ids)];
}

function analysisMessages(value: unknown): AnalysisMessage[] {
  const messages = (value as { messages?: unknown } | null)?.messages;
  if (messages === undefined) return [];
  if (!Array.isArray(messages) || messages.length > 11) throw new HttpError(400, '对话消息格式有误。');
  const parsed = messages.map((entry: Partial<AnalysisMessage> | null) => {
    if (!entry || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.text !== 'string'
      || !entry.text.trim() || entry.text.length > 2000) throw new HttpError(400, '每条对话消息需包含 1–2000 个字符。');
    return { role: entry.role, text: entry.text.trim() };
  });
  if (parsed.length && parsed.at(-1)?.role !== 'user') throw new HttpError(400, '请添加一条用户问题。');
  return parsed;
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
