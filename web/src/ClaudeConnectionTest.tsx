import { useEffect, useRef, useState } from 'react';
import { api, explain } from './api.ts';

export function ClaudeConnectionTest() {
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function check() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setChecking(true);
    setStatus(undefined);
    try {
      const { elapsedMs } = await api.checkClaude(controller.signal);
      if (!controller.signal.aborted) setStatus({ text: `模型已响应 · ${(elapsedMs / 1000).toFixed(1)} 秒` });
    } catch (error) {
      if (!controller.signal.aborted) setStatus({ text: explain(error), error: true });
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setChecking(false);
    }
  }

  return <div className="claude-check">
    <button className="button secondary" type="button" disabled={checking} onClick={() => void check()}>
      {checking ? '正在测试 Claude Code…' : '测试 Claude Code 连接'}
    </button>
    {status && <p className={status.error ? 'claude-error' : 'claude-ready'} role={status.error ? 'alert' : 'status'}>{status.text}</p>}
  </div>;
}
