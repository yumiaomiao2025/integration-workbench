import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { readConfig } from '../src/config.ts';
import type { ConnectionStatus, LiveCapture, Task } from '../src/contracts.ts';
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
        response.setHeader('X-Next-Page', '2');
        body = [{ id: 52, path_with_namespace: 'team/orders', default_branch: 'main' }];
      } else if (url.pathname === '/api/v4/projects/52/repository/branches') {
        assert.equal(request.headers.authorization, 'Bearer renewed');
        body = [{ name: 'feature/orders', default: false, commit: { id: sha } }];
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
    gitlab: { baseUrl: 'https://gitlab.com', clientId: '', clientSecret: '', redirectUri: `${origin}/api/gitlab/callback` },
  };
  await writeFile(config.dataFile, JSON.stringify({ version: 1, tasks: [{
    id: 'd586d40e-a7bb-4c8d-9e01-6e4e853adba8', title: '既有任务', url: 'https://staging.example.test',
    frontend: { projectId: 52, path: 'team/orders', branch: 'feature/orders', commitSha: sha }, backend: null, evidence: [],
  }] }));
  const app = await createWorkbench(config);
  await listen(app, port);
  t.after(async () => { await stop(app); await stop(upstream); });
  const fetchApi = (path: string, options?: RequestInit) => fetch(`${origin}${path}`, { redirect: 'manual', ...options });
  const first = await fetchApi('/');
  assert.equal(first.status, 200);
  const cookie = first.headers.get('set-cookie')!.split(';')[0];
  const auth = { headers: { Cookie: cookie } };
  const install = (body: unknown) => fetchApi('/api/settings/gitlab', {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const settings = { baseUrl: gitlab, clientId: 'local-app', confidential: false };
  assert.equal((await install({ ...settings, baseUrl: 'file:///tmp' })).status, 400);
  assert.equal((await install(settings)).status, 200);
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
    fetchApi('/api/gitlab/projects/52/branches', auth).then((response) => response.json()),
  ]);
  assert.deepEqual(projects, { items: [{ id: 52, path: 'team/orders', defaultBranch: 'main' }], nextPage: 2 });
  assert.deepEqual(branches.items, [{ name: 'feature/orders', isDefault: false, commitSha: sha }]);
  assert.equal(refreshes, 1);
  const unauthorized = await fetchApi('/api/gitlab/projects');
  assert.equal(unauthorized.status, 401);
  assert.equal((await install(settings)).status, 200);
  assert.equal((await (await fetchApi('/api/gitlab/status', auth)).json()).profile.username, 'qa-user');
  assert.equal((await install({ ...settings, clientId: 'new-app' })).status, 200);
  assert.equal((await (await fetchApi('/api/gitlab/status', auth)).json()).profile, null);
  const legacy = await (await fetchApi('/api/tasks/d586d40e-a7bb-4c8d-9e01-6e4e853adba8')).json();
  assert.equal(legacy.frontend.instance, 'https://gitlab.com');
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

test('chooses among existing tabs and continuously collects and saves only selected evidence', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'workbench-cdp-'));
  const chrome = createServer();
  const chromeOrigin = await listen(chrome);
  const socketServer = new WebSocketServer({ server: chrome, path: '/devtools/browser/test' });
  const upstreamSends: string[] = [];
  const targetUrl = 'https://test.example.test/orders';
  const otherUrl = 'https://unrelated.example.test/';
  let peer: WebSocket;
  const target = (targetId: string, url: string) => ({ targetId, type: 'page', title: targetId, url, attached: false, canAccessOpener: false });
  const send = (method: string, params: unknown, sessionId?: string) => peer.send(JSON.stringify({ method, params, sessionId }));
  socketServer.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString());
      upstreamSends.push(command.method);
      if (command.method === 'Target.setDiscoverTargets') {
        for (const info of [target('first', targetUrl), target('second', targetUrl), target('other', otherUrl)]) {
          send('Target.targetCreated', { targetInfo: info });
        }
      }
      if (command.method === 'Runtime.enable') {
        send('Runtime.executionContextCreated', { context: { id: 1, origin: new URL(targetUrl).origin, auxData: { isDefault: true } } }, command.sessionId);
        send('Runtime.consoleAPICalled', { executionContextId: 1, type: 'log', args: [{ type: 'string', value: 'before attachment' }], timestamp: Date.now() - 60_000 }, command.sessionId);
      }
      const result = command.method === 'Target.attachToTarget' ? { sessionId: `session-${command.params.targetId}` } : {};
      socket.send(JSON.stringify({ id: command.id, result, sessionId: command.sessionId }));
    });
  });
  const chromePort = new URL(chromeOrigin).port;
  await writeFile(join(data, 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/test\n`);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const dataFile = join(data, 'tasks.json');
  const config = { ...readConfig(), port, origin, dataFile, chromeDataDir: join(data, 'default') };
  const app = await createWorkbench(config);
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
      method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.ok(response.ok, `${response.status} ${path}`);
    return await response.json() as T;
  };
  const blocked = await fetch(`${origin}/api/chrome/connect`, { method: 'POST', headers: { Origin: otherUrl } });
  assert.equal(blocked.status, 403);
  const before = await request<{ ready: boolean }>('/settings/chrome/check', 'POST', { dataDir: '' });
  assert.equal(before.ready, false);
  const found = await request<{ ready: boolean }>('/settings/chrome/check', 'POST', { dataDir: data });
  assert.equal(found.ready, true);
  await request('/settings/chrome', 'PUT', { dataDir: data });
  const task = await request<Task>('/tasks', 'POST', { title: '联调订单', url: targetUrl, frontend: { projectId: 52, path: 'team/orders', branch: 'feature/orders', commitSha: sha } });
  assert.equal(task.frontend?.branch, 'feature/orders');
  await request('/chrome/connect', 'POST');
  const live = () => request<{ connection: ConnectionStatus; capture: LiveCapture }>(`/tasks/${task.id}/live`);
  const candidates = await until(async () => {
    const result = await live();
    return result.capture.state === 'choose' ? result.capture.candidates : undefined;
  });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['first', 'second']);
  assert.ok(!upstreamSends.includes('Target.attachToTarget'));
  await request(`/tasks/${task.id}/tab`, 'POST', { tabId: 'second' });
  await until(async () => (await live()).capture.state === 'attached' ? true : undefined);
  await request('/settings/chrome', 'PUT', { dataDir: data });
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
  const selected = [network!.id];
  const saved = await request<Task>(`/tasks/${task.id}/evidence`, 'POST', { ids: selected });
  assert.deepEqual(saved.evidence.map((entry) => entry.id), selected);
  const retried = await request<Task>(`/tasks/${task.id}/evidence`, 'POST', { ids: selected });
  assert.equal(retried.evidence.length, 1);

  send('Target.targetInfoChanged', { targetInfo: target('second', `${new URL(targetUrl).origin}/orders/view/42`) });
  await until(async () => (await live()).capture.tab?.url.endsWith('/42') ? true : undefined);
  assert.equal(upstreamSends.filter((method) => method === 'Target.attachToTarget').length, 1);
  send('Runtime.consoleAPICalled', { executionContextId: 1, type: 'info', args: [{ type: 'string', value: 'still listening' }], timestamp: Date.now() }, session);
  await until(async () => (await live()).capture.entries.some((entry) => entry.kind === 'console' && entry.message === 'still listening') ? true : undefined);
  assert.ok(!upstreamSends.some((method) => ['Target.createTarget', 'Page.navigate', 'Runtime.evaluate'].includes(method)));

  const reload = await createWorkbench(config);
  await stop(app);
  await listen(reload, port);
  try {
    const after = await request<Task>(`/tasks/${task.id}`);
    assert.equal(after.evidence.length, 1);
    assert.equal((await live()).capture.entries.length, 0);
    assert.equal((await request<{ chrome: { dataDir: string } }>('/settings')).chrome.dataDir, data);
  } finally {
    await stop(reload);
  }
});
