import { useCallback, useState, type FormEvent } from 'react';
import type { RepositoryBinding, Task, TaskInput } from '../../src/contracts.ts';
import { api, explain, gitLabLogin, type Branch, type GitLabStatus, type Project } from './api.ts';
import { SearchPicker } from './SearchPicker.tsx';
import { Dialog, Icon } from './ui.tsx';

export const repositoryRoles = { frontend: '前端', backend: '后端' } as const;
export type RepositoryRole = keyof typeof repositoryRoles;

export function repositoryKey({ instance, projectId }: RepositoryBinding) {
  return `${instance ?? ''}|${projectId}`;
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
  const [repositories, setRepositories] = useState<Pick<TaskInput, RepositoryRole>>({
    frontend: task?.frontend ?? [], backend: task?.backend ?? [],
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      onSaved(await api.saveTask(task?.id, { title, url, ...repositories }));
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setSaving(false);
    }
  }

  return <Dialog id="task-dialog" title={task ? '编辑任务' : '新建任务'}
    description="填写任务名称和测试网址。仓库与分支可以稍后补充。" onClose={onClose} initialFocus="#editor-name">
    <form onSubmit={(event) => void submit(event)}>
      <div className="dialog-body">
        <label className="field">任务名称<input id="editor-name" placeholder="例如：订单提交联调" required maxLength={100} autoComplete="off"
          value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field">测试网址<input type="url" placeholder="https://test.example.com/orders" required maxLength={2048} autoComplete="off"
          value={url} onChange={(event) => setUrl(event.target.value)} /></label>
        {!gitlab?.profile && <div className="form-note">
          {gitlab?.configured ? <a href={gitLabLogin} target="_blank" rel="noopener">连接 GitLab</a>
            : <button className="text-button" type="button" onClick={onSettings}>配置 GitLab</button>}
          {' 后可搜索仓库和分支。'}
        </div>}
        <div className="editor-repositories">
          {(Object.keys(repositoryRoles) as RepositoryRole[]).map((role) => <RepositoryPicker key={role} role={role}
            repositories={repositories[role]} gitlab={gitlab}
            onChange={(update) => setRepositories((previous) => ({ ...previous, [role]: update(previous[role]) }))} />)}
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

function RepositoryPicker({ role, repositories, gitlab, onChange }: {
  role: RepositoryRole;
  repositories: RepositoryBinding[];
  gitlab: GitLabStatus | null;
  onChange: (update: (previous: RepositoryBinding[]) => RepositoryBinding[]) => void;
}) {
  const label = repositoryRoles[role];
  const instance = gitlab?.instance;
  const account = gitlab?.profile ? `${instance}|${gitlab.profile.id}` : '';
  const selected = new Set(repositories.map(repositoryKey));

  function projectKey(project: Project) { return `${instance}|${project.id}`; }

  function remove(key: string) {
    onChange((previous) => previous.filter((repository) => repositoryKey(repository) !== key));
  }

  function toggleProject(project: Project, checked: boolean) {
    const key = projectKey(project);
    if (!checked) return remove(key);
    onChange((previous) => previous.some((repository) => repositoryKey(repository) === key) ? previous
      : [...previous, { projectId: project.id, path: project.path, instance, branches: [] }]);
  }

  return <fieldset className="repo-editor">
    <legend>{label}仓库 <small>可选</small></legend>
    {account && <SearchPicker key={account} title={`添加${label}仓库`} searchLabel={`搜索${label}仓库名称或路径`} scope={account}
      load={api.projects} itemKey={projectKey} label={(project) => project.path} selected={selected} onChange={toggleProject} />}
    {!repositories.length && <p className="repo-picker-empty">未添加仓库</p>}
    {repositories.map((repository) => {
      const key = repositoryKey(repository);
      return <RepositoryCard key={key} repository={repository}
        scope={account && repository.instance === instance ? `${account}|${repository.projectId}` : ''}
        onRemove={() => remove(key)} onToggleBranch={(branch, checked) => onChange((previous) => previous.map((entry) => {
          if (repositoryKey(entry) !== key) return entry;
          if (!checked) return { ...entry, branches: entry.branches.filter((item) => item.name !== branch.name) };
          if (entry.branches.some((item) => item.name === branch.name)) return entry;
          return { ...entry, branches: [...entry.branches, { name: branch.name, commitSha: branch.commitSha }] };
        }))} />;
    })}
  </fieldset>;
}

function RepositoryCard({ repository, scope, onRemove, onToggleBranch }: {
  repository: RepositoryBinding;
  scope: string;
  onRemove: () => void;
  onToggleBranch: (branch: Branch, checked: boolean) => void;
}) {
  const load = useCallback((query: string, page: number, signal: AbortSignal) => api.branches(repository.projectId, query, page, signal), [repository.projectId]);
  return <div className="selected-repository">
    <div className="selected-repository-heading">
      <strong title={repository.instance ? `${repository.instance}/${repository.path}` : repository.path}>{repository.path}</strong>
      <button className="icon-button" type="button" aria-label={`移除仓库 ${repository.path}`} onClick={onRemove}><Icon name="close" /></button>
    </div>
    {repository.branches.length ? <div className="branch-selection">
      {repository.branches.map((branch) => <button className="branch-chip" type="button" key={branch.name}
        aria-label={`移除分支 ${branch.name}`} title={branch.name} onClick={() => onToggleBranch(branch, false)}>
        <span>{branch.name}</span><Icon name="close" />
      </button>)}
    </div> : <p className="repo-picker-empty">未选择分支</p>}
    {scope && <SearchPicker key={scope} title={`选择分支 · ${repository.path}`} searchLabel={`搜索分支 · ${repository.path}`} scope={scope}
      load={load} itemKey={(branch) => branch.name} label={(branch) => `${branch.name}${branch.isDefault ? ' · 默认' : ''}`}
      selected={new Set(repository.branches.map((branch) => branch.name))} onChange={onToggleBranch} />}
  </div>;
}
