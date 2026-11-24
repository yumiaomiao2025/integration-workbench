import { useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, LiveCapture } from '../../src/contracts.ts';
import { api, explain } from './api.ts';

type Snapshot = { taskId?: string; connection: ConnectionStatus; capture: LiveCapture | null };
const idle: ConnectionStatus = { state: 'idle', message: '', activeTaskId: null };

export function useLiveCapture(taskId?: string) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ connection: idle, capture: null });
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    let etag = '';
    let polling = false;
    let refreshPending = false;
    async function poll() {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        if (!taskId) {
          const connection = await api.chromeStatus(controller.signal);
          if (!controller.signal.aborted) setSnapshot({ connection, capture: null });
          return;
        }
        const live = await api.live(taskId, etag, controller.signal);
        if (live && !controller.signal.aborted) {
          etag = live.etag;
          setSnapshot({ taskId, ...live.status });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          etag = '';
          setSnapshot((previous) => ({
            ...previous,
            connection: { state: 'disconnected', message: explain(error), activeTaskId: null },
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
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [taskId]);

  return {
    connection: snapshot.connection,
    capture: snapshot.taskId === taskId ? snapshot.capture : null,
    refresh: () => refreshRef.current(),
  };
}
