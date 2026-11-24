import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '../../src/contracts.ts';
import { api, explain, type GitLabStatus, type TaskSummary } from './api.ts';
import { ConnectionSettings, type SettingsPane } from './ConnectionSettings.tsx';
import { EvidencePanel } from './EvidencePanel.tsx';
import { ChromeCard, RepositoryCard, Sidebar, TopBar } from './Overview.tsx';
import { TaskEditor } from './TaskEditor.tsx';
import { Icon } from './ui.tsx';
import { useLiveCapture } from './useLiveCapture.ts';

function summarize(task: Task): TaskSummary {
  const { evidence, ...summary } = task;
  return { ...summary, evidenceCount: evidence.length };
}

export function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [gitlab, setGitLab] = useState<GitLabStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<{ task: Task | null } | null>(null);
  const [pane, setPane] = useState<SettingsPane | null>(null);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const selecting = useRef(false);
  const live = useLiveCapture(task?.id);

  const notify = useCallback((message: string, error = false) => setNotice({ message, error }), []);
  const refreshGitLab = useCallback(async () => setGitLab(await api.gitLabStatus()), []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    document.title = task ? `${task.title} · 联调工作台` : '联调工作台';
  }, [task?.title]);

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.has('gitlab')) {
      const failed = query.get('gitlab') === 'error';
      notify(failed ? query.get('message') || 'GitLab 授权失败。' : 'GitLab 已授权。', failed);
      history.replaceState(null, '', '/');
    }
    const controller = new AbortController();
    const signal = controller.signal;
    async function initialize() {
      try {
        const [list, connection, status] = await Promise.all([api.tasks(signal), api.chromeStatus(signal), api.gitLabStatus(signal)]);
        if (signal.aborted) return;
        setTasks(list);
        setGitLab(status);
        const last = connection.activeTaskId || localStorage.getItem('last-task');
        const initial = list.find((entry) => entry.id === last) ?? list[0];
        if (!initial) return;
        const selected = await api.task(initial.id, signal);
        if (connection.activeTaskId !== initial.id) await api.activate(initial.id, signal);
        if (!signal.aborted) setTask(selected);
      } catch (error) {
        if (!signal.aborted) notify(explain(error), true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }
    void initialize();
    const onFocus = () => { void refreshGitLab().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    return () => {
      controller.abort();
      window.removeEventListener('focus', onFocus);
    };
  }, [notify, refreshGitLab]);

  async function selectTask(id: string) {
    if (selecting.current || task?.id === id) return;
    selecting.current = true;
    try {
      const selected = await api.task(id);
      await api.activate(id);
      localStorage.setItem('last-task', id);
      setTask(selected);
    } catch (error) {
      notify(explain(error), true);
    } finally {
      selecting.current = false;
    }
  }

  async function changeConnection(action: 'connect' | 'disconnect') {
    try {
      await api.chromeConnect(action);
      live.refresh();
    } catch (error) {
      notify(explain(error), true);
    }
  }

  async function chooseTab(id: string) {
    if (!task) return;
    try {
      await api.chooseTab(task.id, id);
      live.refresh();
    } catch (error) {
      notify(explain(error), true);
    }
  }

  function saveTask(saved: Task) {
    setTasks((list) => list.some((entry) => entry.id === saved.id)
      ? list.map((entry) => entry.id === saved.id ? summarize(saved) : entry) : [summarize(saved), ...list]);
    localStorage.setItem('last-task', saved.id);
    setTask(saved);
    setEditor(null);
    live.refresh();
    notify(editor?.task ? '任务已更新。' : '任务已创建。');
  }

  async function saveEvidence(id: string, ids: string[]) {
    const saved = await api.saveEvidence(id, ids);
    setTasks((list) => list.map((entry) => entry.id === id ? summarize(saved) : entry));
    setTask((current) => current?.id === id ? saved : current);
  }

  const openNewTask = () => setEditor({ task: null });
  const connect = () => { void changeConnection('connect'); };

  return <>
    <div className="shell">
      <Sidebar tasks={tasks} selectedId={task?.id} loading={loading} onNew={openNewTask} onSelect={(id) => void selectTask(id)} />
      <main className="main">
        <TopBar task={task} gitlab={gitlab} onSettings={() => setPane('gitlab')} />
        <div className="workspace">
          <div className="page-heading">
            <div className="page-heading-copy">
              <h1>{task?.title ?? '联调工作区'}</h1>
              {task ? <p className="task-url"><Icon name="link" /><span>{task.url}</span></p>
                : <p>选择仓库和分支，查看现有 Chrome 标签页的请求与日志。</p>}
            </div>
            {task && <button className="button secondary" type="button" onClick={() => setEditor({ task })}><Icon name="edit" />编辑任务</button>}
          </div>
          <div className="summary-grid">
            <RepositoryCard task={task} />
            <ChromeCard connection={live.connection} capture={live.capture} task={task} onConnect={connect}
              onDisconnect={() => void changeConnection('disconnect')} onSettings={() => setPane('chrome')} onChoose={(id) => void chooseTab(id)} />
          </div>
          <EvidencePanel task={task} capture={live.capture} connection={live.connection} loading={loading}
            onNew={openNewTask} onConnect={connect} onSave={saveEvidence} notify={notify} />
        </div>
      </main>
    </div>
    {editor && <TaskEditor task={editor.task} gitlab={gitlab} onClose={() => setEditor(null)} onSettings={() => setPane('gitlab')} onSaved={saveTask} />}
    {pane && <ConnectionSettings initialPane={pane} gitlabStatus={gitlab} connection={live.connection} fromEditor={Boolean(editor)}
      onClose={() => setPane(null)} setGitLabStatus={setGitLab} refreshGitLab={refreshGitLab} refreshChrome={live.refresh}
      connectChrome={connect} notify={notify} />}
    {notice && <div className={`notice${notice.error ? ' error' : ''}`} role="status" aria-live="polite">
      <Icon name={notice.error ? 'close' : 'check'} /><span>{notice.message}</span>
    </div>}
  </>;
}
