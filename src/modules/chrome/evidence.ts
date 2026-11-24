import { randomUUID } from 'node:crypto';
import type { Protocol } from 'devtools-protocol';
import type { ConsoleEvidence, Evidence, NetworkEvidence } from '../../contracts.ts';
import type { CdpEvent } from './cdp.ts';

type PendingRequest = Omit<NetworkEvidence, 'duration' | 'error'> & { timestamp: number };
const secretAssignments = /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|authorization|cookie)(?:["'])?\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;

export function cleanUrl(raw: string) {
  const url = URL.parse(raw);
  return url && ['https:', 'http:'].includes(url.protocol) ? `${url.origin}${url.pathname}`.slice(0, 2048) : '';
}

export function safeText(value: string, limit: number) {
  return value.slice(0, limit * 3)
    .replace(secretAssignments, '[敏感字段已省略]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已省略]')
    .replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => cleanUrl(url) || '[网址已省略]')
    .slice(0, limit);
}

function describe(argument: Protocol.Runtime.RemoteObject) {
  if (typeof argument.value === 'string') return safeText(argument.value, 700);
  if (argument.type === 'object' && argument.subtype !== 'error' && argument.subtype !== 'null') {
    return `[${argument.className || argument.subtype || 'Object'}]`;
  }
  return safeText(String(argument.unserializableValue ?? argument.value ?? argument.description ?? argument.type), 700);
}

export class EvidenceCollector {
  private origin: string;
  private since: number;
  private append: (evidence: Evidence) => void;
  private requests = new Map<string, PendingRequest>();
  private contexts = new Set<number>();

  constructor(origin: string, since: number, append: (evidence: Evidence) => void) {
    this.origin = origin;
    this.since = since;
    this.append = append;
  }

  handle(event: CdpEvent) {
    switch (event.method) {
      case 'Network.requestWillBeSent': this.requestStarted(event.params); break;
      case 'Network.responseReceived': {
        const request = this.requests.get(event.params.requestId);
        if (request) request.status = event.params.response.status;
        break;
      }
      case 'Network.loadingFinished':
        this.requestFinished(event.params.requestId, event.params.timestamp);
        break;
      case 'Network.loadingFailed':
        this.requestFinished(event.params.requestId, event.params.timestamp, event.params.errorText);
        break;
      case 'Runtime.executionContextCreated': {
        const context = event.params.context;
        if (this.isTaskOrigin(context.origin) && context.auxData?.isDefault !== false) this.contexts.add(context.id);
        break;
      }
      case 'Runtime.executionContextDestroyed': this.contexts.delete(event.params.executionContextId); break;
      case 'Runtime.executionContextsCleared': this.contexts.clear(); break;
      case 'Runtime.consoleAPICalled': this.consoleCalled(event.params); break;
      case 'Runtime.exceptionThrown': this.exception(event.params); break;
      case 'Log.entryAdded': {
        const { entry } = event.params;
        if ((entry.url && this.isTaskOrigin(entry.url)) || (entry.networkRequestId && this.requests.has(entry.networkRequestId))) {
          this.log(entry.timestamp, entry.level, entry.text, cleanUrl(entry.url || ''));
        }
        break;
      }
    }
  }

  private requestStarted(event: Protocol.Network.RequestWillBeSentEvent) {
    const existing = this.requests.get(event.requestId);
    if (existing && event.redirectResponse) {
      existing.status = event.redirectResponse.status;
      this.requestFinished(event.requestId, event.timestamp);
    }
    // Document requests must match the task themselves. Fetch/XHR may call another origin.
    const documentUrl = event.type === 'Document' ? event.request.url : event.documentURL;
    const url = cleanUrl(event.request.url);
    if (!url || !this.isTaskOrigin(documentUrl) || event.wallTime * 1000 < this.since) return;
    this.requests.set(event.requestId, {
      id: randomUUID(), kind: 'network', at: new Date(event.wallTime * 1000).toISOString(),
      timestamp: event.timestamp, method: event.request.method.slice(0, 16), url,
      status: null, resourceType: event.type || 'Other',
    });
    if (this.requests.size > 1000) this.requests.delete(this.requests.keys().next().value!);
  }

  private requestFinished(requestId: string, finishedAt: number, error = '') {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    const { timestamp, ...record } = request;
    this.append({ ...record, duration: Math.max(0, Math.round((finishedAt - timestamp) * 1000)), error: safeText(error, 240) });
  }

  private consoleCalled(event: Protocol.Runtime.ConsoleAPICalledEvent) {
    if (!this.contexts.has(event.executionContextId)) return;
    const frame = event.stackTrace?.callFrames[0];
    this.log(event.timestamp, event.type, event.args.slice(0, 12).map(describe).join(' '), source(frame));
  }

  private exception(event: Protocol.Runtime.ExceptionThrownEvent) {
    const details = event.exceptionDetails;
    const frame = details.stackTrace?.callFrames[0];
    if (!this.contexts.has(details.executionContextId ?? -1)
      && !this.isTaskOrigin(details.url || frame?.url || '')) return;
    this.log(event.timestamp, 'error', details.exception?.description || details.text, source(frame)
      || (cleanUrl(details.url || '') ? `${cleanUrl(details.url || '')}:${details.lineNumber + 1}` : ''));
  }

  private log(timestamp: number, level: string, message: string, sourceLocation: string) {
    if (!Number.isFinite(timestamp) || timestamp < this.since) return;
    const entry: ConsoleEvidence = {
      id: randomUUID(), kind: 'console', at: new Date(timestamp).toISOString(),
      level, message: safeText(message, 1800), source: sourceLocation,
    };
    this.append(entry);
  }

  private isTaskOrigin(url: string) {
    return URL.parse(url)?.origin === this.origin;
  }
}

function source(frame?: Protocol.Runtime.CallFrame) {
  if (!frame) return '';
  const url = cleanUrl(frame.url);
  return url ? `${url}:${frame.lineNumber + 1}` : '';
}
