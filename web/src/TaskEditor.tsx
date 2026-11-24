import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { RepositoryBinding, Task, TaskInput } from '../../src/contracts.ts';
import { api, explain, gitLabLogin, type Branch, type GitLabStatus, type Project } from './api.ts';
import { Dialog } from './ui.tsx';

export const repositoryRoles = { frontend: '前端', backend: '后端' } as const;
export type RepositoryRole = keyof typeof repositoryRoles;
type LinkedProject = Project & { instance?: string };
type RepoChoice = { project: LinkedProject | null; branch: Branch | null };
type Page<T> = { items: T[]; nextPage: number | null };

function fromBinding(binding?: RepositoryBinding | null): RepoChoice {
  return binding ? {
    project: { id: binding.projectId, path: binding.path, instance: binding.instance },
    branch: { name: binding.branch, commitSha: binding.commitSha },
  } : { project: null, branch: null };
}

function toBinding({ project, branch }: RepoChoice): RepositoryBinding | null {
  return project && branch ? { projectId: project.id, instance: project.instance, path: project.path, branch: branch.name, commitSha: branch.commitSha } : null;
}

export function TaskEditor({ task, gitlab, onClose, onSettings, onSaved }: {
  task: Task | null;
  gitlab: GitLabStatus | null;
  onClose: () => void;
  onSettings: () => void;
  onSaved: (task: Task) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [url, setUrl] = useState(task?.url ?? '');
  const [repositories, setRepositories] = useState({ frontend: fromBinding(task?.frontend), backend: fromBinding(task?.backend) });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    for (const [role, selection] of Object.entries(repositories)) {
      if (selection.project && !selection.branch) {
        setError(`请选择${repositoryRoles[role as RepositoryRole]}分支。`);
        return;
      }
    }
    const input: TaskInput = { title, url, frontend: toBinding(repositories.frontend), backend: toBinding(repositories.backend) };
    setSaving(true);
    setError('');
    try {
      onSaved(await api.saveTask(task?.id, input));
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setSaving(false);
    }
  }

  return <Dialog id="task-dialog" title={task ? '编辑联调任务' : '新建联调任务'}
    description="填写测试网址，并关联需要联调的仓库。" onClose={onClose} initialFocus="#editor-name">
    <form onSubmit={(event) => void submit(event)}>
      <div className="dialog-body">
        <label className="field">任务名称<input id="editor-name" placeholder="例如：订单提交联调" required maxLength={100} autoComplete="off"
          value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field">测试网址<input type="url" placeholder="https://test.example.com/orders" required maxLength={2048} autoComplete="off"
          value={url} onChange={(event) => setUrl(event.target.value)} /></label>
        <div className="form-note">
          {gitlab?.profile ? `已连接 GitLab · ${gitlab.profile.username}` : gitlab?.configured
            ? <><a href={gitLabLogin} target="_blank" rel="noopener">连接 GitLab</a> 后可选择仓库和分支。</>
            : <><button className="text-button" type="button" onClick={onSettings}>配置 GitLab</button> 后可选择仓库和分支。测试网址也可以先保存为任务。</>}
        </div>
        <div className="editor-repositories">
          {(Object.keys(repositoryRoles) as RepositoryRole[]).map((role) => <RepositoryPicker key={role} role={role}
            selection={repositories[role]} gitlab={gitlab} onChange={(choice) => setRepositories((previous) => ({ ...previous, [role]: choice }))} />)}
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <footer className="dialog-footer">
        <button className="button secondary" type="button" onClick={onClose}>取消</button>
        <button className="button primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存任务'}</button>
      </footer>
    </form>
  </Dialog>;
}

function projectId(project?: LinkedProject | null) {
  return project ? `${project.instance ?? ''}|${project.id}` : '';
}

function includeSelected<T>(items: T[], selected: T | null, key: (item: T) => string) {
  const options = new Map(items.map((item) => [key(item), item]));
  if (selected && !options.has(key(selected))) return [selected, ...options.values()];
  return [...options.values()];
}

function RepositoryPicker({ role, selection, gitlab, onChange }: {
  role: RepositoryRole;
  selection: RepoChoice;
  gitlab: GitLabStatus | null;
  onChange: (choice: RepoChoice) => void;
}) {
  const [projectSearch, setProjectSearch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const label = repositoryRoles[role];
  const { project, branch } = selection;
  const instance = gitlab?.instance;
  const account = gitlab?.profile ? `${instance}|${gitlab.profile.id}` : '';
  const chosenProjectId = project?.instance === instance ? project?.id : undefined;
  const fetchBranches = useCallback((search: string, page: number, signal: AbortSignal) => api.branches(chosenProjectId!, search, page, signal), [chosenProjectId]);
  const projects = usePagedOptions(account, projectSearch, api.projects);
  const branches = usePagedOptions(account && chosenProjectId !== undefined ? `${account}|${chosenProjectId}` : '', branchSearch, fetchBranches);
  const projectOptions = includeSelected(projects.items.map((item) => ({ ...item, instance })), project, projectId);
  const branchOptions = includeSelected(branches.items, branch, (item) => item.name);
  const message = projects.error || branches.error;

  function chooseProject(id: string) {
    const next = projectOptions.find((item) => projectId(item) === id) ?? null;
    onChange({ project: next, branch: null });
    setBranchSearch('');
  }

  return <fieldset className="repo-editor">
    <legend>{label}仓库</legend>
    <input className="repo-search" aria-label={`搜索${label}仓库`} placeholder="搜索仓库" autoComplete="off" disabled={!account}
      value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} />
    <select aria-label={`选择${label}仓库`} disabled={!account} value={projectId(project)} onChange={(event) => chooseProject(event.target.value)}>
      <option value="">选择仓库</option>
      {projectOptions.map((item) => <option key={projectId(item)} value={projectId(item)}>
        {item.path}{item.instance && item.instance !== instance ? ` · ${new URL(item.instance).host}` : ''}
      </option>)}
    </select>
    {projects.nextPage && <button className="button secondary" type="button" disabled={projects.loading} onClick={projects.more}>更多仓库</button>}
    <input className="repo-search" aria-label={`搜索${label}分支`} placeholder="搜索分支" autoComplete="off" disabled={!account || chosenProjectId === undefined}
      value={branchSearch} onChange={(event) => setBranchSearch(event.target.value)} />
    <select aria-label={`选择${label}分支`} disabled={!account || chosenProjectId === undefined} value={branch?.name ?? ''}
      onChange={(event) => onChange({ project, branch: branchOptions.find((item) => item.name === event.target.value) ?? null })}>
      <option value="">选择分支</option>
      {branchOptions.map((item) => <option key={item.name} value={item.name}>{item.name}{item.isDefault ? ' · 默认' : ''}</option>)}
    </select>
    {branches.nextPage && <button className="button secondary" type="button" disabled={branches.loading} onClick={branches.more}>更多分支</button>}
    {message && <p className="repo-message" role="alert">{message}</p>}
  </fieldset>;
}

function usePagedOptions<T>(scope: string, query: string, load: (search: string, page: number, signal: AbortSignal) => Promise<Page<T>>) {
  const key = `${scope}\0${query}`;
  const [requested, setRequested] = useState({ key, page: 1 });
  const [result, setResult] = useState<{ key: string; page: number; items: T[]; nextPage: number | null; error?: string }>();
  const page = requested.key === key ? requested.page : 1;
  const current = result?.key === key ? result : undefined;

  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(query, page, controller.signal).then((data) => {
        if (!controller.signal.aborted) setResult((previous) => ({
          key, page, nextPage: data.nextPage,
          items: page > 1 && previous?.key === key ? [...previous.items, ...data.items] : data.items,
        }));
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setResult((previous) => ({
          key, page, items: previous?.key === key ? previous.items : [], nextPage: null, error: explain(error),
        }));
      });
    }, query && page === 1 ? 240 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [key, page, scope, query, load]);

  return {
    items: scope ? current?.items ?? [] : [],
    nextPage: current?.nextPage,
    loading: Boolean(scope) && current?.page !== page,
    error: current?.error,
    more: () => { if (current?.nextPage) setRequested({ key, page: current.nextPage }); },
  };
}
