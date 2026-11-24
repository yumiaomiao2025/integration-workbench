import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { readConfig } from '../src/config.ts';
import type { AnalysisMessage, ConnectionStatus, EvidenceAnalysis, LiveCapture, Task } from '../src/contracts.ts';
import { createWorkbench } from '../src/server.ts';
import { availablePort, listen, stop, until } from './support.ts';

const sha = '1'.repeat(40);

test('personal GitLab OAuth validates state and PKCE, then lists projects and branches', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'workbench-oauth-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  let challenge = '';
  let refreshes = 0;
  const upstream = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://gitlab.invalid');
      let body: unknown;
      if (url.pathname === '/oauth/token') {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        assert.equal(form.has('client_secret'), false);
        if (form.get('grant_type') === 'authorization_code') {
          assert.equal(form.get('code'), 'personal-code');
          assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), challenge);
          body = { access_token: 'first', refresh_token: 'rotate-me', expires_in: 1 };
        } else {
          assert.equal(form.get('refresh_token'), 'rotate-me');
          ++refreshes;
          body = { access_token: 'renewed', refresh_token: 'another', expires_in: 7200 };
        }
      } else if (url.pathname === '/api/v4/user') {
        assert.equal(request.headers.authorization, 'Bearer first');
        body = { id: 10, name: 'QA', username: 'qa-user', private: 'hidden' };
      } else if (url.pathname === '/api/v4/projects') {
        assert.equal(request.headers.authorization, 'Bearer renewed');
        assert.equal(url.searchParams.get('membership'), 'true');
        assert.equal(url.searchParams.get('search'), 'orders');
        assert.equal(url.searchParams.get('search_namespaces'), 'true');
        assert.equal(url.searchParams.get('per_page'), '50');
        response.setHeader('X-Next-Page', '2');
        body = [{ id: 52, path_with_namespace: 'team/orders', default_branch: 'main' }];
      } else if (url.pathname === '/api/v4/projects/52/repository/branches') {
        assert.equal(request.headers.authorization, 'Bearer renewed');
        assert.equal(url.searchParams.get('search'), 'orders');
        const page = url.searchParams.get('page');
        const next = page === '1' ? `<${url.pathname}?page=2&search=orders>; rel="next"` : '';
        response.setHeader('Link', next);
        body = [{ name: page === '1' ? 'feature/orders' : 'release/orders', default: false, commit: { id: sha } }];
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  const gitlab = await listen(upstream);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    ...readConfig(), port, origin, dataFile: join(data, 'tasks.json'), chromeDataDir: data,
    distDir: join(data, 'dist'),
    gitlab: { baseUrl: 'https://gitlab.com', clientId: '', clientSecret: '', redirectUri: `${origin}/api/gitlab/callback` },
  };
  await mkdir(join(config.distDir, 'assets'), { recursive: true });
  await writeFile(join(config.distDir, 'index.html'), '<script type="module" src="/assets/index.js"></script>');
  await writeFile(join(config.distDir, 'assets', 'index.js'), 'export {};');
  await writeFile(config.dataFile, JSON.stringify({ version: 1, tasks: [{
    id: 'd586d40e-a7bb-4c8d-9e01-6e4e853adba8', title: '既有任务', url: 'https://staging.example.test',
    frontend: { projectId: 52, path: 'team/orders', branch: 'feature/orders', commitSha: sha }, backend: null, evidence: [],
  }] }));
  const app = await createWorkbench(config);
  await listen(app, port);
  t.after(async () => { await stop(app); await stop(upstream); });
  const fetchApi = (path: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    headers.set('Connection', 'close');
    return fetch(`${origin}${path}`, { redirect: 'manual', ...options, headers });
  };
  const first = await fetchApi('/');
  assert.equal(first.status, 200);
  assert.match(await first.text(), /src="\/assets\/index\.js"/);
  const asset = await fetchApi('/assets/index.js');
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(await asset.text(), 'export {};');
  const cookie = first.headers.get('set-cookie')!.split(';')[0];
  const auth = { headers: { Cookie: cookie } };
  const install = (body: unknown) => fetchApi('/api/settings/gitlab', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const settings = { baseUrl: gitlab, clientId: 'local-app', confidential: false };
  assert.equal((await install({ ...settings, baseUrl: 'file:///tmp' })).status, 400);
  const installed = await install({ ...settings, baseUrl: `${gitlab}/oauth/applications/42/edit` });
  assert.equal(installed.status, 200);
  assert.equal((await installed.json()).gitlab.baseUrl, gitlab);
  const start = async () => new URL((await fetchApi('/api/gitlab/login', auth)).headers.get('location')!);
  const bad = await start();
  assert.equal(bad.origin, gitlab);
  assert.equal(bad.searchParams.get('client_id'), 'local-app');
  assert.equal(bad.searchParams.get('scope'), 'read_api');
  const rejected = await fetchApi('/api/gitlab/callback?code=personal-code&state=wrong', auth);
  assert.match(rejected.headers.get('location')!, /gitlab=error/);
  const good = await start();
  challenge = good.searchParams.get('code_challenge')!;
  const callback = await fetchApi(`/api/gitlab/callback?code=personal-code&state=${good.searchParams.get('state')}`, auth);
  assert.equal(callback.headers.get('location'), '/?gitlab=connected');
  const status = await (await fetchApi('/api/gitlab/status', auth)).json();
  assert.deepEqual(status.profile, { id: 10, name: 'QA', username: 'qa-user' });
  const [projects, branches] = await Promise.all([
    fetchApi('/api/gitlab/projects?search=orders', auth).then((response) => response.json()),
    fetchApi('/api/gitlab/projects/52/branches?search=orders', auth).then((response) => response.json()),
  ]);
  assert.deepEqual(projects, { items: [{ id: 52, path: 'team/orders', defaultBranch: 'main' }], nextPage: 2 });
  assert.deepEqual(branches, { items: [{ name: 'feature/orders', isDefault: false, commitSha: sha }], nextPage: 2 });
  const later = await (await fetchApi('/api/gitlab/projects/52/branches?search=orders&page=2', auth)).json();
  assert.deepEqual(later, { items: [{ name: 'release/orders', isDefault: false, commitSha: sha }], nextPage: null });
  assert.equal(refreshes, 1);
  const unauthorized = await fetchApi('/api/gitlab/projects');
  assert.equal(unauthorized.status, 401);
  assert.equal((await install(settings)).status, 200);
  assert.equal((await (await fetchApi('/api/gitlab/status', auth)).json()).profile.username, 'qa-user');
  assert.equal((await install({ ...settings, clientId: 'new-app' })).status, 200);
  assert.equal((await (await fetchApi('/api/gitlab/status', auth)).json()).profile, null);
  const legacy = await (await fetchApi('/api/tasks/d586d40e-a7bb-4c8d-9e01-6e4e853adba8')).json() as Task;
  assert.deepEqual(legacy.frontend, [{
    projectId: 52, instance: 'https://gitlab.com', path: 'team/orders', branches: [{ name: 'feature/orders', commitSha: sha }],
  }]);
  assert.deepEqual(legacy.backend, []);
  assert.equal(JSON.parse(await readFile(config.dataFile, 'utf8')).version, 2);
  assert.equal((await start()).searchParams.get('client_id'), 'new-app');
  await stop(app);
  const restarted = await createWorkbench(config);
  try {
    await listen(restarted, port);
    assert.equal((await start()).searchParams.get('client_id'), 'new-app');
  } finally {
    await stop(restarted);
  }
});

test('confidential app secrets stay out of the settings API and plaintext files', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'workbench-secret-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    ...readConfig(), port, origin, dataFile: join(data, 'tasks.json'), chromeDataDir: data,
    gitlab: { baseUrl: 'https://gitlab.com', clientId: '', clientSecret: '', redirectUri: `${origin}/api/gitlab/callback` },
  };
  const app = await createWorkbench(config);
  await listen(app, port);
  t.after(() => stop(app));
  const install = async (body: unknown) => await fetch(`${origin}/api/settings/gitlab`, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const secret = 'fixture-only-credentials';
  const settings = { baseUrl: 'https://gitlab.example.test', clientId: 'local-app', confidential: true };
  const saved = await install({ ...settings, clientSecret: secret });
  assert.equal(saved.status, 200);
  const settingsPayload = await saved.text();
  assert.doesNotMatch(settingsPayload, new RegExp(secret));
  assert.equal(JSON.parse(settingsPayload).gitlab.hasSecret, true);
  const disk = await readFile(join(data, 'settings.json'), 'utf8');
  assert.doesNotMatch(disk, new RegExp(secret));
  assert.equal(Boolean(JSON.parse(disk).gitlab.encryptedSecret), process.platform === 'win32');
  assert.equal((await install(settings)).status, 200);
  assert.equal((await install({ ...settings, clientId: 'other-app' })).status, 400);

  await stop(app);
  const restarted = await createWorkbench(config);
  try {
    await listen(restarted, port);
    const hydrated = await (await fetch(`${origin}/api/settings`)).json();
    assert.equal(hydrated.gitlab.hasSecret, process.platform === 'win32');
    assert.equal(hydrated.gitlab.clientId, 'local-app');
  } finally {
    await stop(restarted);
  }
});

test('keeps Chrome bindings and evidence isolated across concurrent workspaces', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'workbench-cdp-'));
  const chrome = createServer();
  const chromeOrigin = await listen(chrome);
  const socketServer = new WebSocketServer({ server: chrome, path: '/devtools/browser/test' });
  const upstreamSends: string[] = [];
  const targetUrl = 'https://test.example.test/orders';
  const otherUrl = 'https://unrelated.example.test/';
  const peers: WebSocket[] = [];
  const target = (targetId: string, url: string) => ({
    targetId, type: 'page', title: targetId === 'second' ? 'second password=secret' : targetId, url, attached: false, canAccessOpener: false,
  });
  const send = (method: string, params: unknown, sessionId?: string, socket = peers[0]) => socket.send(JSON.stringify({ method, params, sessionId }));
  socketServer.on('connection', (socket) => {
    peers.push(socket);
    socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString());
      upstreamSends.push(command.method);
      if (command.method === 'Target.setDiscoverTargets') {
        for (const info of [target('first', targetUrl), target('second', targetUrl), target('other', otherUrl)]) {
          send('Target.targetCreated', { targetInfo: info }, undefined, socket);
        }
      }
      if (command.method === 'Runtime.enable') {
        const pageOrigin = new URL(command.sessionId === 'session-other' ? otherUrl : targetUrl).origin;
        send('Runtime.executionContextCreated', { context: { id: 1, origin: pageOrigin, auxData: { isDefault: true } } }, command.sessionId, socket);
        send('Runtime.consoleAPICalled', { executionContextId: 1, type: 'log', args: [{ type: 'string', value: 'before attachment' }], timestamp: Date.now() - 60_000 }, command.sessionId, socket);
      }
      const result = command.method === 'Target.attachToTarget' ? { sessionId: `session-${command.params.targetId}` } : {};
      socket.send(JSON.stringify({ id: command.id, result, sessionId: command.sessionId }));
    });
  });
  const chromePort = new URL(chromeOrigin).port;
  await writeFile(join(data, 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/test\n`);
  const otherDirectory = join(data, 'other-profile');
  await mkdir(otherDirectory);
  await writeFile(join(otherDirectory, 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/test\n`);
  const legacyDirectory = join(data, 'legacy-profile');
  await writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, chromeDataDir: legacyDirectory }));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataFile = join(data, 'tasks.json');
  const config = { ...readConfig(), port, origin, dataFile, chromeDataDir: join(data, 'default') };
  const triage: EvidenceAnalysis = {
    target: 'insufficient', summary: '需要更多证据',
    findings: [{ index: 1, reason: '请求状态不能单独确定根因。' }],
    nextSteps: ['核对后端的参数校验日志。'],
  };
  const analyses: string[][] = [];
  const turns: AnalysisMessage[][] = [];
  const app = await createWorkbench(config, async (task, evidence, _signal, messages) => {
    assert.deepEqual(task.frontend[0].branches.map((branch) => branch.name), ['feature/orders', 'release/orders']);
    analyses.push(evidence.map((entry) => entry.id));
    turns.push(messages);
    return triage;
  });
  await listen(app, port);
  t.after(async () => {
    await stop(app);
    for (const socket of socketServer.clients) socket.terminate();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    await stop(chrome);
    await rm(data, { recursive: true, force: true });
  });

  const request = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(body),
    });
    assert.ok(response.ok, `${response.status} ${path}`);
    return await response.json() as T;
  };
  const taskFields = { title: '联调订单', url: targetUrl };
  const emptyTask = await request<Task>('/tasks', 'POST', taskFields);
  const chromePath = `/tasks/${emptyTask.id}/chrome`;
  const blocked = await fetch(`${origin}/api${chromePath}/connect`, { method: 'POST', headers: { Origin: otherUrl } });
  assert.equal(blocked.status, 403);
  assert.deepEqual(await request(chromePath), { dataDir: '', defaultDataDir: legacyDirectory });
  const before = await request<{ ready: boolean }>(`${chromePath}/check`, 'POST', { dataDir: '' });
  assert.equal(before.ready, false);
  const found = await request<{ ready: boolean }>(`${chromePath}/check`, 'POST', { dataDir: data });
  assert.equal(found.ready, true);
  await request(chromePath, 'PUT', { dataDir: data });
  assert.deepEqual(emptyTask.frontend, []);
  assert.deepEqual(emptyTask.backend, []);
  const repository = (projectId: number, path: string, ...branches: string[]) => ({
    projectId, path, instance: config.gitlab.baseUrl, branches: branches.map((name) => ({ name, commitSha: sha })),
  });
  const frontend = [repository(52, 'team/orders', 'feature/orders', 'release/orders'), repository(53, 'team/ui')];
  const backend = [repository(54, 'team/api', 'main'), repository(55, 'team/inventory', 'develop', 'main')];
  const task = await request<Task>(`/tasks/${emptyTask.id}`, 'PUT', { ...taskFields, frontend, backend });
  assert.deepEqual(task.frontend, frontend);
  assert.deepEqual(task.backend, backend);
  assert.equal(task.chromeDataDir, data);
  await request(`${chromePath}/connect`, 'POST');
  const live = () => request<{ connection: ConnectionStatus; capture: LiveCapture }>(`/tasks/${task.id}/live`);
  const candidates = await until(async () => {
    const result = await live();
    return result.capture.state === 'choose' ? result.capture.candidates : undefined;
  });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['first', 'second', 'other']);
  assert.ok(!upstreamSends.includes('Target.attachToTarget'));
  await request(`/tasks/${task.id}/tab`, 'POST', { tabId: 'second' });
  await until(async () => (await live()).capture.state === 'attached' ? true : undefined);
  await request(chromePath, 'PUT', { dataDir: data });
  assert.equal((await live()).capture.state, 'attached');

  const session = 'session-second';
  send('Network.requestWillBeSent', {
    requestId: 'request-one', documentURL: targetUrl, type: 'Fetch', timestamp: 10, wallTime: Date.now() / 1000,
    request: { url: 'https://api.example.test/orders?access_token=secret', method: 'POST', headers: { Authorization: 'secret' } },
  }, session);
  send('Network.responseReceived', { requestId: 'request-one', response: { status: 422 } }, session);
  send('Network.loadingFinished', { requestId: 'request-one', timestamp: 10.15 }, session);
  send('Runtime.consoleAPICalled', { executionContextId: 1, type: 'warning', args: [{ type: 'string', value: '订单失败 password=secret' }], timestamp: Date.now() }, session);
  send('Runtime.consoleAPICalled', { executionContextId: 1, type: 'log', args: [{ type: 'string', value: 'unbound session' }], timestamp: Date.now() }, 'session-other');

  const entries = await until(async () => {
    const result = (await live()).capture.entries;
    return result.length >= 2 ? result : undefined;
  });
  assert.equal(entries.length, 2);
  assert.doesNotMatch(JSON.stringify(entries), /secret|before attachment|unbound session/);
  const network = entries.find((entry) => entry.kind === 'network');
  assert.deepEqual(network && [network.url, network.status, network.duration], ['https://api.example.test/orders', 422, 150]);
  assert.equal(network?.page?.url, targetUrl);
  const selected = [network!.id];
  const other = await request<Task>('/tasks', 'POST', { title: '另一个工作区', url: otherUrl });
  const otherPath = `/tasks/${other.id}`;
  const otherLive = () => request<{ connection: ConnectionStatus; capture: LiveCapture }>(`${otherPath}/live`);
  assert.deepEqual(await request(`${otherPath}/chrome`), { dataDir: '', defaultDataDir: legacyDirectory });
  await request(`${otherPath}/chrome`, 'PUT', { dataDir: otherDirectory });
  await request(`${otherPath}/chrome/connect`, 'POST');
  await until(async () => (await otherLive()).capture.tabs[0]?.id === 'other' ? true : undefined);
  assert.equal((await live()).capture.tabs[0]?.id, 'second');
  send('Runtime.consoleAPICalled', { executionContextId: 1, type: 'log', args: [{ type: 'string', value: 'other workspace' }], timestamp: Date.now() }, 'session-other', peers[1]);
  await until(async () => (await otherLive()).capture.entries.length === 1 ? true : undefined);
  assert.doesNotMatch(JSON.stringify((await live()).capture.entries), /other workspace/);
  const crossWorkspace = await fetch(`${origin}/api${otherPath}/evidence`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ ids: selected }),
  });
  assert.equal(crossWorkspace.status, 409);
  await request(`${otherPath}/chrome/disconnect`, 'POST');
  assert.equal((await otherLive()).connection.state, 'idle');
  assert.equal((await live()).capture.tabs[0]?.id, 'second');
  const analysisPath = `/tasks/${task.id}/analysis`;
  const analyze = (ids: string[], from = origin) => fetch(`${origin}/api${analysisPath}`, {
    method: 'POST', headers: { Origin: from, 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ ids }),
  });
  assert.equal((await analyze(selected, otherUrl)).status, 403);
  assert.equal((await analyze(selected)).status, 409);
  assert.equal(analyses.length, 0);
  const saved = await request<Task>(`/tasks/${task.id}/evidence`, 'POST', { ids: selected });
  assert.deepEqual(saved.evidence.map((entry) => entry.id), selected);
  const retried = await request<Task>(`/tasks/${task.id}/evidence`, 'POST', { ids: selected });
  assert.equal(retried.evidence.length, 1);
  assert.deepEqual(await request<EvidenceAnalysis>(analysisPath, 'POST', { ids: [...selected, ...selected] }), triage);
  assert.deepEqual(analyses, [selected]);
  const messages: AnalysisMessage[] = [
    { role: 'user', text: '接口报错该找谁？' },
    { role: 'assistant', text: triage.summary },
    { role: 'user', text: '接下来该查哪些日志？' },
  ];
  assert.deepEqual(await request<EvidenceAnalysis>(analysisPath, 'POST', { ids: [], messages }), triage);
  assert.deepEqual(turns, [[], messages]);

  send('Target.targetInfoChanged', { targetInfo: target('second', `${new URL(targetUrl).origin}/orders/view/42`) });
  await until(async () => (await live()).capture.tabs[0]?.url.endsWith('/42') ? true : undefined);
  assert.equal(upstreamSends.filter((method) => method === 'Target.attachToTarget').length, 2);
  await request(`/tasks/${task.id}/tab`, 'POST', { tabId: 'first' });
  await until(async () => (await live()).capture.tabs.length === 2 ? true : undefined);
  await request(`/tasks/${task.id}/tab`, 'DELETE', { tabId: 'first' });
  assert.deepEqual((await live()).capture.tabs.map(({ id }) => id), ['second']);
  send('Runtime.consoleAPICalled', { executionContextId: 1, type: 'info', args: [{ type: 'string', value: 'still listening' }], timestamp: Date.now() }, session);
  await until(async () => (await live()).capture.entries.some((entry) => entry.kind === 'console' && entry.message === 'still listening') ? true : undefined);
  assert.ok(!upstreamSends.some((method) => ['Target.createTarget', 'Page.navigate', 'Runtime.evaluate'].includes(method)));

  const reload = await createWorkbench(config);
  await stop(app);
  await listen(reload, port);
  try {
    const after = await request<Task>(`/tasks/${task.id}`);
    assert.deepEqual(after.frontend, frontend);
    assert.deepEqual(after.backend, backend);
    assert.equal(after.evidence.length, 1);
    assert.equal((await live()).capture.entries.length, 0);
    assert.deepEqual(await request(chromePath), { dataDir: data, defaultDataDir: legacyDirectory });
    assert.deepEqual(await request(`${otherPath}/chrome`), { dataDir: otherDirectory, defaultDataDir: legacyDirectory });
    assert.equal((await live()).connection.state, 'idle');
  } finally {
    await stop(reload);
  }
});
