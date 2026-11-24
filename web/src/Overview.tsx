import { useState, type FormEvent } from 'react';
import type { ConnectionStatus, LiveCapture, Task } from '../../src/contracts.ts';
import { type GitLabStatus, type TaskSummary } from './api.ts';
import { repositoryKey, repositoryRoles, type RepositoryRole } from './TaskEditor.tsx';
import { Badge, formatTime, Icon } from './ui.tsx';

export function Sidebar({ tasks, selectedId, loading, onNew, onSelect }: {
  tasks: TaskSummary[]; selectedId?: string; loading: boolean; onNew: () => void; onSelect: (id: string) => void;
}) {
  return <aside className="sidebar" aria-label="工作区导航">
    <div className="brand"><span className="brand-mark"><Icon name="brand" /></span><span>联调工作台</span></div>
    <button className="button sidebar-new" type="button" onClick={onNew}><Icon name="plus" />新建工作区</button>
    <div className="sidebar-section"><span>工作区</span><span className="sidebar-count">{tasks.length}</span></div>
    <nav className="task-list" aria-label="工作区">
      {tasks.length ? tasks.map((task) => <button type="button" key={task.id} className="task-item" title={task.title}
        aria-current={selectedId === task.id ? 'page' : undefined} onClick={() => onSelect(task.id)}><Icon name="list" /><span>{task.title}</span></button>)
        : <span className="sidebar-empty">{loading ? '正在加载工作区…' : '暂无工作区'}</span>}
    </nav>
    <div className="sidebar-bottom"><span className="local-icon"><Icon name="front" /></span><span>本机存储<small>证据保存在当前电脑</small></span></div>
  </aside>;
}

export function TopBar({ task, gitlab, onSettings }: { task: Task | null; gitlab: GitLabStatus | null; onSettings: () => void }) {
  return <header className="topbar">
    <div className="breadcrumb"><Icon name="list" /><span>工作区</span>
      {task && <><Icon name="chevron" className="breadcrumb-separator" /><strong>{task.title}</strong></>}
    </div>
    <div className="topbar-actions">
      <button className="button gitlab-button" type="button" onClick={onSettings}>
        <Icon name="git" /><span className="account-name">{gitlab?.profile?.username || 'GitLab'}</span>
        <Badge color={gitlab?.profile ? 'ok' : undefined}>{gitlab?.profile ? '已授权' : gitlab?.configured ? '未连接' : '未配置'}</Badge>
      </button>
      <button className="button secondary settings-button" type="button" aria-label="连接设置" title="连接设置" onClick={onSettings}>
        <Icon name="settings" /><span>连接设置</span>
      </button>
    </div>
  </header>;
}

export function RepositoryCard({ task }: { task: Task | null }) {
  return <section className="card repository-card" aria-labelledby="repository-title">
    <div className="card-heading"><span className="tile-icon violet"><Icon name="git" /></span><h2 id="repository-title">仓库与分支</h2></div>
    <div className="repo-pair">
      {(Object.keys(repositoryRoles) as RepositoryRole[]).map((role) => {
        const bindings = task?.[role] ?? [];
        return <div className="repo-item" key={role}>
          <div className="repo-label"><Icon name={role === 'frontend' ? 'front' : 'back'} />{repositoryRoles[role]}仓库</div>
          {bindings.length ? <ul className="repository-summary">
            {bindings.map((binding) => <li key={repositoryKey(binding)}>
              <div className="repo-value" title={binding.instance ? `${binding.instance}/${binding.path}` : binding.path}>{binding.path}</div>
              {binding.branches.length ? binding.branches.map((branch) => <span className="branch-name" key={branch.name}
                title={`选定分支 ${branch.name} · ${branch.commitSha}`}>{branch.name}</span>) : <span className="repo-picker-empty">未选择分支</span>}
            </li>)}
          </ul> : <div className="repo-value empty">未选择仓库</div>}
        </div>;
      })}
    </div>
  </section>;
}

export function ChromeCard({ connection, capture, task, onConnect, onDisconnect, onSettings, onChoose }: {
  connection: ConnectionStatus; capture: LiveCapture | null; task: Task | null; onConnect: () => void;
  onDisconnect: () => void; onSettings: () => void; onChoose: (id: string) => void;
}) {
  const [tabId, setTabId] = useState('');
  const { state } = connection;
  const connected = state === 'connected';
  const connecting = state === 'connecting';
  const tab = connected ? capture?.tab : undefined;
  const candidates = capture?.candidates ?? [];
  const showPicker = connected && (capture?.state === 'choose' || Boolean(tab && candidates.some((item) => item.id !== tab.id)));
  const selected = candidates.some((entry) => entry.id === tabId) ? tabId : '';
  let label = '未连接';
  let color: 'ok' | 'pending' | 'error' | undefined;
  let help = task ? '在已打开的 Chrome 中启用远程调试，再连接现有标签页。' : '新建工作区后，可以连接现有 Chrome 标签页。';
  if (connected) {
    label = tab ? '采集中' : '已连接';
    color = 'ok';
    help = capture?.message || '正在查找匹配的标签页…';
  } else if (connecting) {
    label = '连接中'; color = 'pending'; help = connection.message;
  } else if (state === 'error' || state === 'disconnected') {
    label = state === 'error' ? '连接失败' : '已断开'; color = 'error'; help = connection.message;
  }

  function choose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected) { onChoose(selected); setTabId(''); }
  }

  return <section className="card chrome-card" aria-labelledby="chrome-title">
    <div className="chrome-heading"><div className="card-heading"><span className="tile-icon blue"><Icon name="browser" /></span><h2 id="chrome-title">Chrome 连接</h2></div><Badge color={color}>{label}</Badge></div>
    <div className="connection-details">
      {tab ? <div><strong title={tab.url}>{tab.title || tab.url}</strong>
        {capture?.startedAt && <small>采集起始时间 {formatTime(capture.startedAt)}</small>}
      </div> : <p>{help}</p>}
      {showPicker && <form className="tab-picker" onSubmit={choose}>
        <select aria-label="选择 Chrome 标签页" required value={selected} onChange={(event) => setTabId(event.target.value)}>
          <option value="">{tab ? '切换标签页' : '选择标签页'}</option>
          {candidates.map((entry) => <option key={entry.id} value={entry.id}>{entry.title || entry.url} · {entry.url}</option>)}
        </select>
        <button className="button secondary" type="submit">接入</button>
      </form>}
    </div>
    {task && <div className="chrome-actions">
      {connected || connecting ? <button className="button secondary" type="button" onClick={onDisconnect}>{connecting ? '取消连接' : '断开连接'}</button>
        : <button className="button primary" type="button" onClick={onConnect}><Icon name="link" />{state === 'idle' ? '连接 Chrome' : '重新连接'}</button>}
      <button className="button secondary" type="button" onClick={onSettings}>Chrome 设置</button>
    </div>}
  </section>;
}
