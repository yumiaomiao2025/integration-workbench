import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeGitLabUrl } from '../../config.ts';
import type { Evidence, RepositoryBinding, Task, TaskInput } from '../../contracts.ts';
import { HttpError } from '../../http.ts';
import { writeJsonFile } from '../../json-file.ts';

export class TaskStore {
  private file: string;
  private tasks: Task[];
  private pending: Promise<unknown> = Promise.resolve();

  static async open(file: string) {
    let tasks: Task[] = [];
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.tasks)) {
        throw new Error('任务文件格式不受支持。');
      }
      tasks = saved.tasks;
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
    if (!task) throw new HttpError(404, '找不到这个联调任务。');
    return task;
  }

  create(input: TaskInput) {
    const task: Task = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), evidence: [] };
    return this.change((tasks) => [task, ...tasks]).then(() => task);
  }

  update(id: string, input: TaskInput) {
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

  async setLegacyInstance(instance: string) {
    if (!this.tasks.some((task) => [task.frontend, task.backend].some((repo) => repo && !repo.instance))) return;
    const update = (repo: RepositoryBinding | null) => repo && !repo.instance ? { ...repo, instance } : repo;
    await this.change((tasks) => tasks.map((task) => ({ ...task, frontend: update(task.frontend), backend: update(task.backend) })));
  }

  private change(update: (tasks: Task[]) => Task[]) {
    const action = this.pending.then(async () => {
      const next = update(this.tasks);
      await writeJsonFile(this.file, { version: 1, tasks: next });
      this.tasks = next;
    });
    this.pending = action.catch(() => {});
    return action;
  }
}

function parseRepository(value: unknown, defaultInstance: string): RepositoryBinding | null {
  if (value === null || value === undefined) return null;
  if (value && typeof value === 'object') {
    const { projectId, instance, path, branch, commitSha } = value as Partial<RepositoryBinding>;
    if (typeof projectId === 'number' && Number.isSafeInteger(projectId) && projectId > 0
      && (instance === undefined || (typeof instance === 'string' && instance.length <= 2048))
      && typeof path === 'string' && path.trim() && path.length <= 512
      && typeof branch === 'string' && branch.trim() && branch.length <= 512
      && typeof commitSha === 'string' && /^[a-f0-9]{40,64}$/i.test(commitSha)) {
      return { projectId, instance: instance ? normalizeGitLabUrl(instance) : defaultInstance, path, branch, commitSha };
    }
  }
  throw new HttpError(400, '请从 GitLab 列表选择仓库和分支。');
}

export function parseTask(value: unknown, instance: string): TaskInput {
  if (!value || typeof value !== 'object') throw new HttpError(400, '请填写任务信息。');
  const { title, url, frontend, backend } = value as Partial<TaskInput>;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 100) {
    throw new HttpError(400, '任务名称需包含 1–100 个字符。');
  }
  const target = typeof url === 'string' && url.length <= 2048 ? URL.parse(url.trim()) : null;
  if (!target || !['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
    throw new HttpError(400, '请输入有效的 HTTP 或 HTTPS 测试网址。');
  }
  return { title: title.trim(), url: target.href, frontend: parseRepository(frontend, instance), backend: parseRepository(backend, instance) };
}
