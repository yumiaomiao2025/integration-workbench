import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AnalysisMessage, Evidence, EvidenceAnalysis, Task } from '../../src/contracts.ts';
import { api, explain } from './api.ts';
import { ClaudeConnectionTest } from './ClaudeConnectionTest.tsx';
import { Dialog, formatTime, Icon } from './ui.tsx';

export type AgentLaunch = { taskId: string; ids: string[] };
type Turn = { question: string; result: EvidenceAnalysis; evidence: Evidence[] };
type Conversation = { draft: string; ids: string[]; turns: Turn[]; error?: string };
const empty: Conversation = { draft: '', ids: [], turns: [] };
const triageLabels = { frontend: '建议派给前端', backend: '建议派给后端', insufficient: '需要更多证据' };

export function AgentDialog({ task, live, launch, onClose, onSave }: {
  task: Task;
  live: Evidence[];
  launch: AgentLaunch | null;
  onClose: () => void;
  onSave: (id: string, ids: string[]) => Promise<void>;
}) {
  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [pending, setPending] = useState<{ taskId: string; question: string }>();
  const [picker, setPicker] = useState<Evidence['kind']>();
  const [search, setSearch] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const conversation = conversations[task.id] ?? empty;
  const open = launch?.taskId === task.id;
  const currentPending = pending?.taskId === task.id ? pending : undefined;
  const savedIds = new Set(task.evidence.map((entry) => entry.id));
  const options = [...task.evidence.toReversed(), ...live.filter((entry) => !savedIds.has(entry.id))];
  const available = new Map(options.map((entry) => [entry.id, entry]));

  function update(id: string, changes: (previous: Conversation) => Conversation) {
    setConversations((previous) => ({ ...previous, [id]: changes(previous[id] ?? empty) }));
  }

  useEffect(() => {
    if (!launch) return;
    setPicker(undefined);
    setSearch('');
    if (launch.ids.length) update(launch.taskId, (previous) => ({
      ...previous, ids: [...new Set([...previous.ids, ...launch.ids])],
    }));
  }, [launch]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: 'nearest' });
  }, [open, conversation.turns, currentPending]);

  function togglePicker(kind: Evidence['kind']) {
    setPicker(picker === kind ? undefined : kind);
    setSearch('');
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (!conversation.draft.trim() && !conversation.ids.length)) return;
    const evidence = conversation.ids.flatMap((id) => {
      const entry = available.get(id);
      return entry ? [entry] : [];
    });
    if (evidence.length !== conversation.ids.length) {
      update(task.id, (previous) => ({ ...previous, error: '有临时证据已过期，请移除后重新发送。' }));
      return;
    }
    const question = conversation.draft.trim() || '请分析引用的证据，给出派发建议。';
    const messages: AnalysisMessage[] = conversation.turns.slice(-5).flatMap((turn) => [
      { role: 'user', text: turn.question },
      { role: 'assistant', text: answerText(turn.result).slice(0, 1600) },
    ]);
    messages.push({ role: 'user', text: question });
    const ids = evidence.map((entry) => entry.id);
    const unsaved = ids.filter((id) => !savedIds.has(id));
    const id = task.id;
    setPending({ taskId: id, question });
    setPicker(undefined);
    update(id, (previous) => ({ ...previous, error: undefined }));
    try {
      if (unsaved.length) await onSave(id, unsaved);
      const result = await api.analyzeEvidence(id, ids, messages);
      update(id, (previous) => ({
        ...previous, draft: '', turns: [...previous.turns, { question, result, evidence }],
      }));
    } catch (error) {
      update(id, (previous) => ({ ...previous, error: explain(error) }));
    } finally {
      setPending(undefined);
    }
  }

  if (!open) return null;
  const query = search.trim().toLowerCase();
  const matches = options.filter((entry) => entry.kind === picker && evidenceText(entry).toLowerCase().includes(query));

  return <Dialog id="agent-dialog" title="联调 Agent" description={task.title} onClose={onClose} initialFocus="#agent-question">
    <div className="agent-header"><ClaudeConnectionTest /></div>
    <div className="agent-thread" role="log" aria-label="联调对话">
      {!conversation.turns.length && !currentPending && <p className="agent-empty">可以直接提问，也可以先引用接口或控制台记录。</p>}
      {conversation.turns.map((turn, index) => <div className="agent-turn" key={index}>
        <p className="agent-question">{turn.question}</p>
        <Answer result={turn.result} evidence={turn.evidence} />
      </div>)}
      {currentPending && <div className="agent-turn">
        <p className="agent-question">{currentPending.question}</p><p className="agent-empty" role="status">Claude Code 正在回答…</p>
      </div>}
      <div ref={end} />
    </div>
    <form className="agent-composer" onSubmit={(event) => void send(event)}>
      {conversation.ids.length > 0 && <ul className="agent-references" aria-label="已引用的证据">
        {conversation.ids.map((id) => {
          const entry = available.get(id);
          const label = entry ? evidenceLabel(entry) : '已过期的证据';
          return <li key={id}><button type="button" className="branch-chip" title={label} aria-label={`移除引用 ${label}`}
            onClick={() => update(task.id, (previous) => ({ ...previous, ids: previous.ids.filter((value) => value !== id), error: undefined }))}>
            <span>{label}</span><Icon name="close" />
          </button></li>;
        })}
      </ul>}
      <div className="agent-attachment-actions">
        <button className="button secondary" type="button" aria-pressed={picker === 'network'} onClick={() => togglePicker('network')}><Icon name="network" />引用接口</button>
        <button className="button secondary" type="button" aria-pressed={picker === 'console'} onClick={() => togglePicker('console')}><Icon name="terminal" />引用控制台</button>
      </div>
      {picker && <div className="agent-picker">
        <label className="search-field"><Icon name="search" /><input type="search" aria-label={picker === 'network' ? '搜索接口' : '搜索控制台'}
          placeholder={picker === 'network' ? '搜索方法、地址或状态码' : '搜索日志、来源或级别'} value={search}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }}
          onChange={(event) => setSearch(event.target.value)} /></label>
        <ul className="agent-options" aria-label="可引用的证据">
          {matches.map((entry) => <li key={entry.id}>
            <button type="button" disabled={conversation.ids.includes(entry.id)} title={evidenceLabel(entry)} onClick={() => update(task.id, (previous) => ({
              ...previous, ids: [...new Set([...previous.ids, entry.id])], error: undefined,
            }))}>
              <span><strong>{evidenceLabel(entry)}</strong><small>{[formatTime(entry.at), evidenceMeta(entry)].filter(Boolean).join(' · ')}</small></span>
              <span className="agent-option-state">{conversation.ids.includes(entry.id) ? '已引用' : savedIds.has(entry.id) ? '已保存' : '实时'}</span>
            </button>
          </li>)}
        </ul>
        {!matches.length && <p className="agent-empty">{query ? '没有匹配的记录。' : '暂无可引用的记录。'}</p>}
      </div>}
      <textarea id="agent-question" aria-label="向 Agent 提问" placeholder="例如：这个接口为什么会返回 422？" maxLength={2000}
        value={conversation.draft} rows={2} onChange={(event) => {
          const draft = event.target.value;
          update(task.id, (previous) => ({ ...previous, draft }));
        }} readOnly={Boolean(currentPending)} />
      {conversation.error && <p className="claude-error" role="alert">{conversation.error}</p>}
      <div className="agent-send">
        <p>问题、引用的证据及关联分支会发送给当前模型服务。</p>
        <button className="button primary" type="submit" disabled={Boolean(pending) || (!conversation.draft.trim() && !conversation.ids.length)}>发送</button>
      </div>
    </form>
  </Dialog>;
}

function evidenceLabel(entry: Evidence) {
  return entry.kind === 'network' ? `${entry.method} ${entry.url}` : entry.message || '（空日志）';
}

function evidenceMeta(entry: Evidence) {
  return [entry.kind === 'network' ? entry.status ?? entry.error : entry.level, entry.page?.title || entry.page?.url].filter(Boolean).join(' · ');
}

function evidenceText(entry: Evidence) {
  return [evidenceLabel(entry), evidenceMeta(entry), entry.page?.url, entry.kind === 'console' ? entry.source : entry.error].join(' ');
}

function answerText(result: EvidenceAnalysis) {
  return [result.summary, ...result.findings.map((finding) => finding.reason), ...result.nextSteps].join('\n');
}

function Answer({ result, evidence }: { result: EvidenceAnalysis; evidence: Evidence[] }) {
  return <div className="agent-answer">
    {result.target && <strong>{triageLabels[result.target]}</strong>}
    <p>{result.summary}</p>
    {result.findings.length > 0 && <ul>{result.findings.map(({ index, reason }) => <li key={index}>
      <strong>{evidence[index - 1] ? evidenceLabel(evidence[index - 1]) : `证据 ${index}`}</strong><p>{reason}</p>
    </li>)}</ul>}
    {result.nextSteps.length > 0 && <><strong>下一步排查</strong><ol>
      {result.nextSteps.map((step, index) => <li key={index}>{step}</li>)}
    </ol></>}
  </div>;
}
