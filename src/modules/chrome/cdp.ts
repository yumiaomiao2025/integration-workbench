import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;
export type CdpEvent = { [K in keyof Events]: { method: K; params: Events[K][0]; sessionId?: string } }[keyof Events];
type CommandResponse = { id: number; result?: unknown; error?: { message: string } };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export async function chromeEndpoint(dataDir: string) {
  let contents: string;
  try {
    contents = await readFile(join(dataDir, 'DevToolsActivePort'), 'utf8');
  } catch (error) {
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) {
      throw new Error('本机采集器无法读取 Chrome 配置目录，请检查当前系统账号的访问权限。');
    }
    throw new Error('未发现可连接的 Chrome。请在已打开的 Chrome 中启用远程调试，再重试。');
  }
  const [port, path] = contents.trim().split(/\r?\n/).map((line) => line.trim());
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535
    || !/^\/devtools\/browser(?:\/[\w-]+)?$/.test(path || '')) {
    throw new Error('Chrome 调试地址无效，请关闭后重新启用远程调试。');
  }
  return `ws://127.0.0.1:${port}${path}`;
}

export async function checkChromeEndpoint(dataDir: string) {
  try {
    const endpoint = new URL(await chromeEndpoint(dataDir));
    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
      const done = (ready: boolean) => { socket.destroy(); resolve(ready); };
      socket.setTimeout(1000);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    });
    return listening
      ? { ready: true, message: '发现可连接的 Chrome。可以返回工作台连接。' }
      : { ready: false, message: 'Chrome 调试端口未响应。请确认 Chrome 仍在运行，并重新启用远程调试。' };
  } catch (error) {
    return { ready: false, message: (error as Error).message };
  }
}

export class CdpConnection {
  private socket: WebSocket;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  onEvent: (event: CdpEvent) => void = () => {};
  onClose: () => void = () => {};

  static open(endpoint: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const socket = new WebSocket(endpoint);
    return new Promise<CdpConnection>((resolve, reject) => {
      const bail = (message: string) => {
        cleanup();
        socket.close();
        reject(new Error(message));
      };
      const failed = () => bail('连接未建立。请检查 Chrome 远程调试是否开启，以及是否允许连接。');
      const aborted = () => bail('已取消 Chrome 连接。');
      const opened = () => {
        cleanup();
        resolve(new CdpConnection(socket));
      };
      const timer = setTimeout(() => bail('等待 Chrome 确认超时，请重试连接并在 Chrome 中点击允许。'), 60_000);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
        signal.removeEventListener('abort', aborted);
      };
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('error', () => this.close());
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Chrome 连接已断开。'));
      }
      this.pending.clear();
      this.onClose();
    }, { once: true });
  }

  send<K extends keyof Commands>(method: K, params?: Commands[K]['paramsType'][0], sessionId?: string, timeout = 8_000) {
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Chrome 连接已断开。'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Chrome 调试指令等待超时。'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    }) as Promise<Commands[K]['returnType']>;
  }

  close() {
    this.socket.close();
  }

  private receive(data: unknown) {
    if (typeof data !== 'string') return;
    let message: CdpEvent | CommandResponse;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.method && message.params) {
      this.onEvent(message);
    }
  }
}
