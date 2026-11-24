import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeGitLabUrl } from '../../config.ts';
import type { Evidence, RepositoryBinding, RepositoryBranch, Task, TaskInput } from '../../contracts.ts';
import { HttpError } from '../../http.ts';
import { writeJsonFile } from '../../json-file.ts';

type StoredTask = Omit<Task, 'frontend' | 'backend'> & { frontend?: unknown; backend?: unknown };

export class TaskStore {
  private file: string;
  private tasks: Task[];
  private pending: Promise<unknown> = Promise.resolve();

  static async open(file: string, defaultInstance: string) {
    let tasks: Task[] = [];
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.tasks)) {
        throw new Error('工作区文件格式不受支持。');
      }
      tasks = saved.tasks.map((task: StoredTask) => ({
        ...task,
        frontend: parseRepositories(task.frontend, defaultInstance),
        backend: parseRepositories(task.backend, defaultInstance),
      }));
      if (saved.version === 1) await writeJsonFile(file, { version: 2, tasks });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return new TaskStore(file, tasks);
  }

  private constructor(file: string, tasks: Task[]) {
    this.file = file;
    this.tasks = tasks;
  }

  list() {
    return this.tasks.map(({ evidence, ...task }) => ({ ...task, evidenceCount: evidence.length }));
  }

  get(id: string) {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) throw new HttpError(404, '找不到这个工作区。');
    return task;
  }

  create(input: TaskInput) {
    const task: Task = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), evidence: [] };
    return this.change((tasks) => [task, ...tasks]).then(() => task);
  }

  update(id: string, input: Partial<TaskInput> & Pick<Task, 'chromeDataDir'>) {
    return this.change((tasks) => {
      this.get(id);
      return tasks.map((task) => task.id === id ? { ...task, ...input } : task);
    }).then(() => this.get(id));
  }

  saveEvidence(id: string, selected: Evidence[]) {
    return this.change((tasks) => {
      const task = this.get(id);
      const saved = new Set(task.evidence.map((entry) => entry.id));
      const evidence = [...task.evidence, ...selected.filter((entry) => !saved.has(entry.id))];
      return tasks.map((entry) => entry.id === id ? { ...entry, evidence } : entry);
    }).then(() => this.get(id));
  }

  private change(update: (tasks: Task[]) => Task[]) {
    const action = this.pending.then(async () => {
      const next = update(this.tasks);
      await writeJsonFile(this.file, { version: 2, tasks: next });
      this.tasks = next;
    });
    this.pending = action.catch(() => {});
    return action;
  }
}

function parseRepositories(value: unknown, defaultInstance: string): RepositoryBinding[] {
  if (value == null) return [];
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const repositories = items.map((item) => parseRepository(item, defaultInstance));
  const keys = new Set(repositories.map(({ instance, projectId }) => `${instance}|${projectId}`));
  if (keys.size !== repositories.length) throw new HttpError(400, '同一个仓库在前端或后端列表中只能添加一次。');
  return repositories;
}

function parseRepository(value: unknown, defaultInstance: string): RepositoryBinding {
  if (!value || typeof value !== 'object') throw new HttpError(400, '请从 GitLab 列表选择仓库。');
  const { projectId, instance, path, branches, branch, commitSha } = value as Record<string, unknown>;
  if (typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId <= 0
    || (instance !== undefined && (typeof instance !== 'string' || instance.length > 2048))
    || typeof path !== 'string' || !path.trim() || path.length > 512) {
    throw new HttpError(400, '请从 GitLab 列表选择仓库。');
  }

  const branchValues = branches === undefined ? (branch === undefined ? [] : [{ name: branch, commitSha }]) : branches;
  if (!Array.isArray(branchValues)) throw new HttpError(400, '请选择有效的 GitLab 分支。');
  const selected = branchValues.map(parseBranch);
  return {
    projectId, instance: instance ? normalizeGitLabUrl(instance) : defaultInstance, path,
    branches: [...new Map(selected.map((entry) => [entry.name, entry])).values()],
  };
}

function parseBranch(value: unknown): RepositoryBranch {
  if (value && typeof value === 'object') {
    const { name, commitSha } = value as Partial<RepositoryBranch>;
    if (typeof name === 'string' && name.trim() && name.length <= 512
      && typeof commitSha === 'string' && /^[a-f0-9]{40,64}$/i.test(commitSha)) return { name, commitSha };
  }
  throw new HttpError(400, '请选择有效的 GitLab 分支。');
}

export function parseTask(value: unknown, instance: string): TaskInput {
  if (!value || typeof value !== 'object') throw new HttpError(400, '请填写工作区信息。');
  const { title, url, frontend, backend } = value as Partial<TaskInput>;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 100) {
    throw new HttpError(400, '工作区名称需包含 1–100 个字符。');
  }
  const target = typeof url === 'string' && url.length <= 2048 ? URL.parse(url.trim()) : null;
  if (!target || !['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
    throw new HttpError(400, '请输入有效的 HTTP 或 HTTPS 测试网址。');
  }
  return { title: title.trim(), url: target.href, frontend: parseRepositories(frontend, instance), backend: parseRepositories(backend, instance) };
}
