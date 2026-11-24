import type { Protocol } from 'devtools-protocol';
import type { CandidateTab, ConnectionStatus, Evidence, LiveCapture } from '../../contracts.ts';
import { HttpError } from '../../http.ts';
import { CdpConnection, chromeEndpoint, type CdpEvent } from './cdp.ts';
import { cleanUrl, EvidenceCollector, safeText } from './evidence.ts';

type Target = Protocol.Target.TargetInfo;
type Binding = { sessionId: string; origin: string; started: number; collector: EvidenceCollector; ready: boolean };
const maxEntries = 400;
const retentionMs = 20 * 60_000;

export class ChromeCollector {
  private dataDir: string;
  private url: string;
  private ignoredOrigin?: string;
  private client?: CdpConnection;
  private connecting?: AbortController;
  private heartbeat?: NodeJS.Timeout;
  private state: ConnectionStatus['state'] = 'idle';
  private message = '';
  private targets = new Map<string, Target>();
  private entries: Evidence[] = [];
  private bindings = new Map<string, Binding>();
  private attempts = new Map<string, symbol>();
  private failedTargets = new Set<string>();
  private removedTargets = new Set<string>();
  private revision = 0;

  constructor(dataDir: string, url: string, ignoredOrigin?: string) {
    this.dataDir = dataDir;
    this.url = url;
    this.ignoredOrigin = ignoredOrigin;
  }

  status(): ConnectionStatus {
    return { state: this.state, message: this.message };
  }

  configure(dataDir: string, url: string) {
    if (this.dataDir !== dataDir) {
      this.disconnect();
      this.dataDir = dataDir;
    }
    if (this.url === url) return;
    this.url = url;
    this.entries = [];
    for (const targetId of new Set([...this.bindings.keys(), ...this.attempts.keys()])) this.release(targetId);
    this.failedTargets.clear();
    this.removedTargets.clear();
    this.reconcile();
  }

  connect() {
    if (this.connecting || this.state === 'connected') return;
    this.state = 'connecting';
    this.message = '如 Chrome 弹出确认窗口，请点击允许。';
    this.revision++;
    const attempt = new AbortController();
    this.connecting = attempt;
    void this.open(attempt);
  }

  disconnect() {
    this.connecting?.abort();
    this.connecting = undefined;
    const client = this.client;
    this.resetConnection();
    this.state = 'idle';
    this.message = '';
    client?.close();
  }

  choose(targetId: string) {
    const target = this.targets.get(targetId);
    const url = target && this.pageUrl(target);
    if (this.state !== 'connected' || !this.client || !url) {
      throw new HttpError(409, '此页面已无法接入，请从当前列表重新选择。');
    }
    if (this.bindings.has(targetId) || this.attempts.has(targetId)) return;
    this.failedTargets.delete(targetId);
    this.removedTargets.delete(targetId);
    void this.attach(this.client, url.origin, targetId);
  }

  remove(targetId: string) {
    if (!this.bindings.has(targetId) && !this.attempts.has(targetId)) return;
    this.removedTargets.add(targetId);
    this.release(targetId);
    this.reconcile();
  }

  live(): LiveCapture {
    const available = this.state === 'connected' ? this.candidates() : [];
    const tabs = [...this.bindings].flatMap(([id, binding]) => {
      const target = this.targets.get(id);
      return target && binding.ready ? [{ ...toTab(target), startedAt: new Date(binding.started).toISOString() }] : [];
    });
    const choose = !tabs.length && !this.attempts.size && available.length > 0;
    const entries = this.recent();
    return {
      revision: this.revision,
      state: tabs.length ? 'attached' : choose ? 'choose' : 'waiting',
      message: this.attempts.size ? '正在接入页面…'
        : this.failedTargets.size ? '有页面接入失败，可以重新选择。'
        : choose ? '从已打开的页面中选择要接入的页面。'
        : this.state === 'connected' && !tabs.length ? '等待 Chrome 打开页面。' : '',
      tabs,
      candidates: available.map(toTab),
      entries,
    };
  }

  selected(ids: string[], saved: Evidence[]) {
    const available = new Map([...saved, ...this.recent()].map((entry) => [entry.id, entry]));
    return ids.map((id) => {
      const entry = available.get(id);
      if (!entry) throw new HttpError(409, '有选中的记录已超出本机缓存时间，请刷新后重新选择。');
      return entry;
    });
  }

  private async open(attempt: AbortController) {
    let client: CdpConnection | undefined;
    try {
      const endpoint = await chromeEndpoint(this.dataDir);
      client = await CdpConnection.open(endpoint, attempt.signal);
      if (this.connecting !== attempt) {
        client.close();
        return;
      }
      const connection = client;
      this.client = connection;
      connection.onEvent = (event) => this.event(connection, event);
      connection.onClose = () => {
        if (this.client !== connection) return;
        this.resetConnection();
        this.state = 'disconnected';
        this.message = '与 Chrome 的连接已断开。重新连接后会继续接收新事件。';
      };
      await connection.send('Target.setDiscoverTargets', { discover: true });
      if (this.client !== connection) return;
      this.state = 'connected';
      this.message = '';
      this.heartbeat = setInterval(() => {
        void connection.send('Browser.getVersion').catch(() => connection.close());
      }, 20_000).unref();
      this.reconcile();
    } catch (error) {
      if (this.connecting !== attempt) return;
      this.resetConnection();
      this.state = 'error';
      this.message = client ? 'Chrome 未完成调试连接，请确认允许后重试。' : (error as Error).message;
      client?.close();
    } finally {
      if (this.connecting === attempt) this.connecting = undefined;
    }
  }

  private resetConnection() {
    clearInterval(this.heartbeat);
    this.client = undefined;
    this.bindings.clear();
    this.attempts.clear();
    this.failedTargets.clear();
    this.removedTargets.clear();
    this.targets.clear();
    this.revision++;
  }

  private release(targetId: string) {
    const binding = this.bindings.get(targetId);
    this.bindings.delete(targetId);
    this.attempts.delete(targetId);
    if (binding) void this.client?.send('Target.detachFromTarget', { sessionId: binding.sessionId }).catch(() => {});
    this.revision++;
  }

  private event(client: CdpConnection, event: CdpEvent) {
    if (client !== this.client) return;
    if (event.method === 'Target.detachedFromTarget') {
      for (const [id, binding] of this.bindings) {
        if (binding.sessionId !== event.params.sessionId) continue;
        this.failedTargets.add(id);
        this.release(id);
        this.reconcile();
        break;
      }
      return;
    }
    if (event.sessionId) {
      for (const binding of this.bindings.values()) {
        if (binding.sessionId === event.sessionId) { binding.collector.handle(event); break; }
      }
      return;
    }
    switch (event.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const target = event.params.targetInfo;
        if (target.type !== 'page') return;
        const previous = this.targets.get(target.targetId);
        this.targets.set(target.targetId, target);
        if (previous?.url !== target.url || previous?.title !== target.title) this.reconcile();
        break;
      }
      case 'Target.targetDestroyed':
        if (this.targets.delete(event.params.targetId)) {
          this.release(event.params.targetId);
          this.failedTargets.delete(event.params.targetId);
          this.removedTargets.delete(event.params.targetId);
          this.reconcile();
        }
        break;
    }
  }

  private candidates() {
    return [...this.targets.values()].filter((target) =>
      !this.bindings.has(target.targetId) && !this.attempts.has(target.targetId) && this.pageUrl(target));
  }

  private pageUrl(target: Target) {
    const url = URL.parse(target.url);
    return url && ['http:', 'https:'].includes(url.protocol) && url.origin !== this.ignoredOrigin ? url : null;
  }

  private reconcile() {
    this.revision++;
    const client = this.client;
    if (!client || this.state !== 'connected') return;
    for (const [id, binding] of this.bindings) {
      const target = this.targets.get(id);
      if (!target || this.pageUrl(target)?.origin !== binding.origin) this.release(id);
    }
    if (this.bindings.size || this.attempts.size) return;
    const candidates = this.candidates().filter((target) => matches(target.url, this.url) && !this.removedTargets.has(target.targetId));
    const target = candidates.length === 1 ? candidates[0] : undefined;
    if (target && !this.failedTargets.has(target.targetId)) void this.attach(client, new URL(this.url).origin, target.targetId);
  }

  private async attach(client: CdpConnection, origin: string, targetId: string) {
    const attempt = Symbol();
    this.attempts.set(targetId, attempt);
    this.revision++;
    try {
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
      const target = this.targets.get(targetId);
      if (this.attempts.get(targetId) !== attempt || !target || this.pageUrl(target)?.origin !== origin) {
        void client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        return;
      }
      const started = Date.now();
      const collector = new EvidenceCollector(origin, started, (entry) => {
        const current = this.targets.get(targetId);
        if (current) this.record({ ...entry, page: { title: safeText(current.title, 200), url: cleanUrl(current.url) } });
      });
      const binding = { sessionId, origin, started, collector, ready: false };
      this.bindings.set(targetId, binding);
      await Promise.all([
        client.send('Network.enable', { maxPostDataSize: 0 }, sessionId),
        client.send('Runtime.enable', undefined, sessionId),
        client.send('Log.enable', undefined, sessionId).catch(() => {}),
      ]);
      binding.ready = true;
    } catch {
      if (this.attempts.get(targetId) !== attempt) return;
      this.failedTargets.add(targetId);
      this.release(targetId);
    } finally {
      if (this.attempts.get(targetId) === attempt) {
        this.attempts.delete(targetId);
        this.reconcile();
      }
    }
  }

  private recent() {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const entries = this.entries.filter((entry) => entry.at >= cutoff);
    if (entries.length !== this.entries.length) {
      this.entries = entries;
      this.revision++;
    }
    return this.entries;
  }

  private record(entry: Evidence) {
    this.entries = [entry, ...this.recent().slice(0, maxEntries - 1)];
    this.revision++;
  }
}

function matches(raw: string, expected: string) {
  const url = URL.parse(raw);
  const task = new URL(expected);
  const path = (value: string) => value.replace(/\/+$/, '');
  return url?.origin === task.origin && path(url.pathname) === path(task.pathname)
    && (!task.search || url.search === task.search) && (!task.hash || url.hash === task.hash);
}

function toTab(target: Target): CandidateTab {
  return { id: target.targetId, title: target.title.slice(0, 200), url: cleanUrl(target.url) };
}
