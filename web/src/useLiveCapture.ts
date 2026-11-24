import { useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, LiveCapture } from '../../src/contracts.ts';
import { api, explain } from './api.ts';

type Snapshot = { taskId?: string; connection: ConnectionStatus; capture: LiveCapture | null };
const idle: ConnectionStatus = { state: 'idle', message: '' };

export function useLiveCapture(taskId?: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ connection: idle, capture: null });
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!taskId) return;
    const id = taskId;
    const controller = new AbortController();
    let etag = '';
    let polling = false;
    let refreshPending = false;
    async function poll() {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const live = await api.live(id, etag, controller.signal);
        if (live && !controller.signal.aborted) {
          etag = live.etag;
          setSnapshot({ taskId: id, ...live.status });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          etag = '';
          setSnapshot((previous) => ({
            taskId: id,
            capture: previous.taskId === id ? previous.capture : null,
            connection: { state: 'disconnected', message: explain(error) },
          }));
        }
      } finally {
        polling = false;
        if (refreshPending) {
          etag = '';
          refreshPending = false;
          void poll();
        }
      }
    }
    refreshRef.current = () => {
      if (polling) refreshPending = true;
      else { etag = ''; void poll(); }
    };
    const onFocus = () => { void poll(); };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(onFocus, 800);
    void poll();
    return () => {
      controller.abort();
      refreshRef.current = () => {};
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [taskId]);

  return {
    connection: snapshot.taskId === taskId ? snapshot.connection : idle,
    capture: snapshot.taskId === taskId ? snapshot.capture : null,
    refresh: () => refreshRef.current(),
  };
}
