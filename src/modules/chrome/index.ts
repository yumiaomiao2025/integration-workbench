import type { Protocol } from 'devtools-protocol';
import type { CandidateTab, ConnectionStatus, Evidence, LiveCapture, Task } from '../../contracts.ts';
import { HttpError } from '../../http.ts';
import { CdpConnection, chromeEndpoint, type CdpEvent } from './cdp.ts';
import { cleanUrl, EvidenceCollector } from './evidence.ts';

type CaptureTask = Pick<Task, 'id' | 'url'>;
type Target = Protocol.Target.TargetInfo;
type Binding = { targetId: string; sessionId: string; started: number; collector: EvidenceCollector; ready: boolean };
type Attempt = { targetId: string };
const maxEntries = 400;
const retentionMs = 20 * 60_000;

export class ChromeCollector {
  private dataDir: string;
  private client?: CdpConnection;
  private connecting?: AbortController;
  private heartbeat?: NodeJS.Timeout;
  private state: ConnectionStatus['state'] = 'idle';
  private message = '';
  private task?: CaptureTask;
  private targets = new Map<string, Target>();
  private buffers = new Map<string, Evidence[]>();
  private binding?: Binding;
  private attempting?: Attempt;
  private failedTarget?: string;
  private preferredTarget?: string;
  private revision = 0;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  status(): ConnectionStatus {
    return { state: this.state, message: this.message, activeTaskId: this.task?.id ?? null };
  }

  setDataDirectory(dataDir: string) {
    if (this.dataDir === dataDir) return;
    this.disconnect();
    this.dataDir = dataDir;
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

  activate(task: CaptureTask) {
    if (this.task?.id === task.id && this.task.url === task.url) return;
    if (this.task?.id === task.id) this.buffers.delete(task.id);
    this.task = { id: task.id, url: task.url };
    this.release();
    this.failedTarget = undefined;
    this.preferredTarget = undefined;
    this.reconcile();
  }

  choose(taskId: string, targetId: string) {
    const target = this.targets.get(targetId);
    if (this.state !== 'connected' || this.task?.id !== taskId || !target || !matches(target.url, this.task.url)) {
      throw new HttpError(409, '这个标签页已离开测试网址，请从当前列表重新选择。');
    }
    if (this.binding?.targetId === targetId && this.binding.ready) return;
    this.release();
    this.failedTarget = undefined;
    this.preferredTarget = targetId;
    this.reconcile();
  }

  live(taskId: string): LiveCapture {
    const active = this.task?.id === taskId;
    const candidates = active && this.state === 'connected' ? this.candidates().map(toTab) : [];
    const target = active && this.binding?.ready ? this.targets.get(this.binding.targetId) : undefined;
    const choose = !target && !this.attempting && (candidates.length > 1 || Boolean(this.failedTarget && candidates.length));
    return {
      revision: this.revision,
      state: !active ? 'inactive' : target ? 'attached' : choose ? 'choose' : 'waiting',
      message: !active ? '这个任务暂未绑定浏览器。'
        : this.attempting ? '正在接入标签页…'
        : choose ? '选择一个已打开的测试标签页。'
        : this.state === 'connected' && !target ? '等待 Chrome 打开匹配的测试网址。' : '',
      startedAt: target && this.binding ? new Date(this.binding.started).toISOString() : null,
      tab: target ? toTab(target) : null,
      candidates,
      entries: this.recent(taskId),
    };
  }

  selected(taskId: string, ids: string[], saved: Evidence[]) {
    const available = new Map([...saved, ...this.recent(taskId)].map((entry) => [entry.id, entry]));
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
    this.binding = undefined;
    this.attempting = undefined;
    this.failedTarget = undefined;
    this.preferredTarget = undefined;
    this.targets.clear();
    this.revision++;
  }

  private release() {
    const binding = this.binding;
    this.binding = undefined;
    this.attempting = undefined;
    if (binding) void this.client?.send('Target.detachFromTarget', { sessionId: binding.sessionId }).catch(() => {});
    this.revision++;
  }

  private event(client: CdpConnection, event: CdpEvent) {
    if (client !== this.client) return;
    if (event.sessionId) {
      if (this.binding?.sessionId === event.sessionId) this.binding.collector.handle(event);
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
        if (this.targets.delete(event.params.targetId)) this.reconcile();
        break;
      case 'Target.detachedFromTarget':
        if (this.binding?.sessionId === event.params.sessionId) {
          this.failedTarget = this.binding.targetId;
          this.release();
          this.reconcile();
        }
        break;
    }
  }

  private candidates() {
    if (!this.task) return [];
    return [...this.targets.values()].filter((target) => matches(target.url, this.task!.url));
  }

  private reconcile() {
    this.revision++;
    const client = this.client;
    const task = this.task;
    if (!client || !task || this.state !== 'connected') return;
    const attached = this.binding && this.targets.get(this.binding.targetId);
    const origin = new URL(task.url).origin;
    if (attached && URL.parse(attached.url)?.origin === origin) return;
    if (this.binding) this.release();
    if (this.attempting) return;
    const candidates = this.candidates();
    const preferred = candidates.find((target) => target.targetId === this.preferredTarget);
    const target = preferred || (candidates.length === 1 ? candidates[0] : undefined);
    if (target && target.targetId !== this.failedTarget) void this.attach(client, task, origin, target.targetId);
  }

  private async attach(client: CdpConnection, task: CaptureTask, origin: string, targetId: string) {
    const attempt = { targetId };
    this.attempting = attempt;
    this.revision++;
    try {
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
      const target = this.targets.get(targetId);
      if (this.attempting !== attempt || !target || URL.parse(target.url)?.origin !== origin) {
        void client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        return;
      }
      const started = Date.now();
      const collector = new EvidenceCollector(origin, started, (entry) => this.record(task.id, entry));
      this.binding = { targetId, sessionId, started, collector, ready: false };
      await Promise.all([
        client.send('Network.enable', { maxPostDataSize: 0 }, sessionId),
        client.send('Runtime.enable', undefined, sessionId),
        client.send('Log.enable', undefined, sessionId).catch(() => {}),
      ]);
      if (this.binding?.sessionId === sessionId) this.binding.ready = true;
    } catch {
      if (this.attempting !== attempt) return;
      this.failedTarget = targetId;
      this.release();
    } finally {
      if (this.attempting === attempt) {
        this.attempting = undefined;
        this.reconcile();
      }
    }
  }

  private recent(taskId: string) {
    const all = this.buffers.get(taskId) || [];
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    const entries = all.filter((entry) => entry.at >= cutoff);
    if (entries.length !== all.length) {
      this.buffers.set(taskId, entries);
      this.revision++;
    }
    return entries;
  }

  private record(taskId: string, entry: Evidence) {
    const entries = this.recent(taskId);
    if (!this.buffers.has(taskId) && this.buffers.size >= 8) {
      this.buffers.delete(this.buffers.keys().next().value!);
    }
    this.buffers.set(taskId, [entry, ...entries.slice(0, maxEntries - 1)]);
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
