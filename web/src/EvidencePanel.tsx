import { useEffect, useRef, useState } from 'react';
import type { ConnectionStatus, Evidence, LiveCapture, Task } from '../../src/contracts.ts';
import { explain } from './api.ts';
import { formatTime, Icon } from './ui.tsx';

type View = 'network' | 'console' | 'saved';
const views: { id: View; label: string; icon: 'network' | 'terminal' | 'bookmark' }[] = [
  { id: 'network', label: '请求', icon: 'network' },
  { id: 'console', label: '控制台', icon: 'terminal' },
  { id: 'saved', label: '已保存', icon: 'bookmark' },
];
const filters: Record<View, [string, string][]> = {
  network: [['api', 'Fetch / XHR'], ['all', '全部请求'], ['failed', '失败请求']],
  console: [['all', '全部级别'], ['error', '错误'], ['warn', '警告'], ['info', '日志与信息']],
  saved: [['all', '全部类型'], ['network', '仅请求'], ['console', '仅控制台']],
};
const levels: Record<string, string> = { error: '错误', warning: '警告', warn: '警告', log: '日志', debug: '调试', info: '信息' };
const consoleFilters: Record<string, string[]> = { error: ['error', 'assert'], warn: ['warning', 'warn'], info: ['log', 'info', 'debug'] };
const noEntries: Evidence[] = [];
const noSelection: ReadonlySet<string> = new Set();

export function EvidencePanel({ task, capture, connection, loading, onNew, onConnect, onSave, notify }: {
  task: Task | null;
  capture: LiveCapture | null;
  connection: ConnectionStatus;
  loading: boolean;
  onNew: () => void;
  onConnect: () => void;
  onSave: (taskId: string, ids: string[]) => Promise<void>;
  notify: (message: string, isError?: boolean) => void;
}) {
  const [view, setView] = useState<View>('network');
  const [filter, setFilter] = useState('api');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<{ taskId?: string; ids: Set<string> }>();
  const [saving, setSaving] = useState(false);
  const selectAll = useRef<HTMLInputElement>(null);
  const live = capture?.entries ?? noEntries;
  const selected = selection && selection.taskId === task?.id ? selection.ids : noSelection;
  const saved = task?.evidence ?? noEntries;
  const savedIds = new Set(saved.map((entry) => entry.id));
  const byView = {
    network: live.filter((entry) => entry.kind === 'network'),
    console: live.filter((entry) => entry.kind === 'console'),
    saved: saved.toReversed(),
  };
  const entries = byView[view].filter((entry) => matches(entry, view, filter, search.trim().toLowerCase()));
  const selectable = entries.filter((entry) => !savedIds.has(entry.id));
  const selectedCount = selectable.filter((entry) => selected.has(entry.id)).length;

  useEffect(() => { setSelection(undefined); }, [task?.id]);
  useEffect(() => {
    const available = new Set(live.map((entry) => entry.id));
    if (!capture || !selection || selection.taskId !== task?.id) return;
    const valid = [...selection.ids].filter((id) => available.has(id));
    if (valid.length === selection.ids.size) return;
    setSelection({ taskId: task?.id, ids: new Set(valid) });
    notify(`${selection.ids.size - valid.length} 条所选记录已超出本机缓存。`, true);
  }, [capture, live, selection, task?.id, notify]);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  });

  function chooseView(next: View) {
    setView(next);
    setFilter(filters[next][0][0]);
    setSearch('');
  }

  function toggle(ids: string[], checked: boolean) {
    setSelection((previous) => {
      const next = new Set(previous?.taskId === task?.id ? previous?.ids : undefined);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return { taskId: task?.id, ids: next };
    });
  }

  async function save() {
    if (!task || !selected.size || saving) return;
    const ids = [...selected];
    setSaving(true);
    try {
      await onSave(task.id, ids);
      setSelection((previous) => previous?.taskId === task.id
        ? { taskId: task.id, ids: new Set([...previous.ids].filter((id) => !ids.includes(id))) } : previous);
      notify(`已保存 ${ids.length} 条证据。`);
    } catch (error) {
      notify(explain(error), true);
    } finally {
      setSaving(false);
    }
  }

  return <section className="card evidence-card" aria-labelledby="evidence-title">
    <div className="evidence-heading">
      <div><h2 id="evidence-title">联调证据</h2><p>查看请求和日志，勾选需要保存到任务的记录。</p></div>
      <button className="button primary" type="button" disabled={!selected.size || saving} onClick={() => void save()}>
        <Icon name="bookmark" />{saving ? '保存中…' : selected.size ? `保存所选 (${selected.size})` : '保存所选'}
      </button>
    </div>
    <div className="evidence-toolbar">
      <div className="tabs" aria-label="记录类型">
        {views.map((option) => <button key={option.id} className={`evidence-tab${view === option.id ? ' active' : ''}`} type="button"
          aria-pressed={view === option.id} onClick={() => chooseView(option.id)}>
          <Icon name={option.icon} />{option.label}<span className="tab-count">{byView[option.id].length}</span>
        </button>)}
      </div>
      <div className="filters">
        <select aria-label="筛选记录" value={filter} onChange={(event) => setFilter(event.target.value)}>
          {filters[view].map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select>
        <div className="search-field"><Icon name="search" />
          <input aria-label="搜索记录" type="search" placeholder="搜索记录" autoComplete="off" value={search}
            onChange={(event) => setSearch(event.target.value)} />
        </div>
      </div>
    </div>
    <div className="evidence-content">
      {entries.length ? <div className="table-wrap"><table><thead><tr>
        {view === 'saved' ? <th>类型</th> : <th className="pick"><input ref={selectAll} type="checkbox" aria-label="选择当前筛选结果"
          checked={selectable.length > 0 && selectedCount === selectable.length} disabled={!selectable.length}
          onChange={(event) => toggle(selectable.map((entry) => entry.id), event.target.checked)} /></th>}
        <th>时间</th><th>{view === 'network' ? '请求' : view === 'console' ? '消息' : '证据详情'}</th>
        <th>{view === 'network' ? '状态' : view === 'console' ? '级别' : '状态 / 级别'}</th>{view === 'network' && <th>耗时</th>}
      </tr></thead><tbody>
        {entries.map((entry) => <EvidenceRow key={entry.id} entry={entry} view={view} saved={savedIds.has(entry.id)}
          checked={selected.has(entry.id)} toggle={(checked) => toggle([entry.id], checked)} />)}
      </tbody></table></div> : <EmptyEvidence view={view} loading={loading} total={byView[view].length} task={task}
        connection={connection} capture={capture} onNew={onNew} onConnect={onConnect} />}
    </div>
    <p className="evidence-footer">{view === 'saved' ? `已保存 ${saved.length} 条证据。`
      : entries.length ? `显示 ${entries.length} 条记录 · 本机临时记录最多保留 20 分钟。`
        : '本机临时记录保留最近 20 分钟，最多 400 条。'}</p>
  </section>;
}

function matches(entry: Evidence, view: View, filter: string, query: string) {
  if (entry.kind === 'network' && view === 'network') {
    if (filter === 'api' && !['XHR', 'Fetch', 'Preflight'].includes(entry.resourceType)) return false;
    if (filter === 'failed' && !entry.error && (entry.status ?? 0) < 400) return false;
  }
  if (entry.kind === 'console' && view === 'console' && filter !== 'all' && !consoleFilters[filter]?.includes(entry.level)) return false;
  if (view === 'saved' && filter !== 'all' && entry.kind !== filter) return false;
  const content = entry.kind === 'network' ? `${entry.method} ${entry.url} ${entry.status ?? ''} ${entry.error}`
    : `${entry.message} ${entry.source} ${entry.level}`;
  return content.toLowerCase().includes(query);
}

function EvidenceRow({ entry, view, saved, checked, toggle }: {
  entry: Evidence; view: View; saved: boolean; checked: boolean; toggle: (checked: boolean) => void;
}) {
  const network = entry.kind === 'network';
  const summary = network ? <><span className="method">{entry.method}</span>{entry.url}</> : entry.message || '（空日志）';
  const body = network ? [entry.resourceType, entry.error, `${entry.duration} ms`].filter(Boolean).join(' · ') : entry.source || '页面日志';
  const badge = network ? entry.error ? '失败' : entry.status ?? '—' : levels[entry.level] || entry.level;
  const status = network ? entry.status ?? 0 : 0;
  const color = network ? entry.error || status >= 400 ? 'bad' : status >= 200 && status < 300 ? 'good' : ''
    : ['error', 'assert'].includes(entry.level) ? 'bad' : ['warning', 'warn'].includes(entry.level) ? 'warn' : '';
  return <tr>
    {view === 'saved' ? <td>{network ? '请求' : '控制台'}</td> : <td className="pick">
      {saved ? <span className="entry-saved" title="已保存" aria-label="已保存"><Icon name="check" /></span>
        : <input type="checkbox" aria-label={network ? '选择请求' : '选择日志'} checked={checked} onChange={(event) => toggle(event.target.checked)} />}
    </td>}
    <td className="when" title={entry.at}>{formatTime(entry.at)}</td>
    <td><details><summary>{summary}</summary><div className="entry-detail">{body}</div></details></td>
    <td><span className={`record-pill ${color}`}>{badge}</span></td>
    {view === 'network' && entry.kind === 'network' && <td className="duration">{entry.duration} ms</td>}
  </tr>;
}

function EmptyEvidence({ view, loading, total, task, capture, connection, onNew, onConnect }: {
  view: View; loading: boolean; total: number; task: Task | null; capture: LiveCapture | null; connection: ConnectionStatus;
  onNew: () => void; onConnect: () => void;
}) {
  let title = '等待绑定测试标签页';
  let description = '请在现有 Chrome 中打开任务配置的测试网址。';
  let action: { label: string; icon: 'plus' | 'link'; onClick: () => void } | undefined;
  if (loading) [title, description] = ['正在加载任务', '加载完成后可查看联调记录。'];
  else if (!task) {
    [title, description] = ['还没有联调任务', '新建任务并填写测试网址，工作台会匹配已打开的 Chrome 标签页。'];
    action = { label: '新建任务', icon: 'plus', onClick: onNew };
  } else if (total) [title, description] = ['没有符合筛选条件的记录', '可以修改关键词或切换筛选条件。'];
  else if (view === 'saved') [title, description] = ['还没有保存证据', '在请求或控制台中勾选记录，点击「保存所选」。'];
  else if (['idle', 'error', 'disconnected'].includes(connection.state)) {
    [title, description] = ['等待连接 Chrome', '连接后会自动采集匹配标签页的请求和日志。'];
    action = { label: '连接 Chrome', icon: 'link', onClick: onConnect };
  } else if (capture?.state === 'attached') {
    [title, description] = [view === 'network' ? '等待新的请求' : '等待新的日志', '在已连接的 Chrome 标签页继续操作，记录会出现在这里。'];
  } else if (connection.state === 'connecting') [title, description] = ['正在连接 Chrome', '如 Chrome 弹出确认窗口，请点击允许。'];

  return <div className="empty-state">
    <span className="empty-mark"><Icon name={views.find((item) => item.id === view)!.icon} /></span>
    <h3>{title}</h3><p>{description}</p>
    {action && <button className="button secondary" type="button" onClick={action.onClick}><Icon name={action.icon} />{action.label}</button>}
  </div>;
}
