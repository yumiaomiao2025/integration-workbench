import { createSettings } from '/settings.js';

const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const labels = { frontend: '前端', backend: '后端' };
const roles = Object.keys(labels);
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const levels = { error: '错误', warning: '警告', warn: '警告', log: '日志', debug: '调试', info: '信息' };

let tasks = [];
let current = null;
let gitlab = null;
let connection = { state: 'idle', message: '', activeTaskId: null };
let capture = null;
let currentEtag = '';
let view = 'network';
let selected = new Set();
let loading = true;
let polling = false;
let changingTask = false;
let savingEvidence = false;
let noticeTimer;
let editor = null;
let connectionKey = '';
const connectionSettings = createSettings({ api, notify, explain, refreshGitLab, refreshChrome, setConnection });

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function api(path, { method = 'GET', body, etag } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetch(`/api${path}`, { method, headers, body: JSON.stringify(body), cache: 'no-store' });
  if (response.status === 304) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return { data, etag: response.headers.get('ETag') || '' };
}

function notify(message, isError = false) {
  const notice = $('#notice');
  clearTimeout(noticeTimer);
  notice.classList.toggle('error', isError);
  notice.innerHTML = `${icon(isError ? 'close' : 'check')}<span>${html(message)}</span>`;
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4800);
}

function explain(error) {
  return error instanceof TypeError ? '无法访问本机工作台，请确认服务正在运行。' : error.message;
}

function renderTaskList() {
  $('#task-count').textContent = tasks.length;
  $('#task-list').innerHTML = tasks.length ? tasks.map((task) => `
    <button class="task-item" type="button" data-task="${html(task.id)}" ${current?.id === task.id ? 'aria-current="page"' : ''} title="${html(task.title)}">${icon('list')}<span>${html(task.title)}</span></button>
  `).join('') : `<span class="sidebar-empty">${loading ? '正在加载任务…' : '暂无任务'}</span>`;
}

function renderTask() {
  $('#breadcrumb-task').textContent = current?.title || '工作区';
  $('#task-title').textContent = current?.title || '联调工作区';
  $('#task-description').classList.toggle('task-url', Boolean(current));
  $('#task-description').innerHTML = current
    ? `${icon('link')}<span>${html(current.url)}</span>`
    : '选择仓库和分支，查看现有 Chrome 标签页的请求与日志。';
  $('#edit-task').hidden = !current;
  $('#repositories').innerHTML = roles.map((role) => {
    const binding = current?.[role];
    return `<div class="repo-item">
      <div class="repo-label">${icon(role === 'frontend' ? 'front' : 'back')}${labels[role]}仓库</div>
      ${binding ? `<div class="repo-value" title="${html(binding.instance ? `${binding.instance}/${binding.path}` : binding.path)}">${html(binding.path)}</div><span class="branch-name" title="选定分支 ${html(binding.branch)} · ${html(binding.commitSha)}">${html(binding.branch)}</span>` : '<div class="repo-value empty">未选择仓库</div>'}
    </div>`;
  }).join('');
  document.title = current ? `${current.title} · 联调工作台` : '联调工作台';
  renderTaskList();
}

function renderGitLab() {
  const status = $('#gitlab-status');
  status.innerHTML = `${icon('git')}<span class="account-name">${html(gitlab?.profile?.username || 'GitLab')}</span><span class="badge ${gitlab?.profile ? 'ok' : ''}"><i></i>${gitlab?.profile ? '已授权' : gitlab?.configured ? '未连接' : '未配置'}</span>`;
  connectionSettings.updateGitLab(gitlab);
}

async function refreshGitLab() {
  const previous = gitlab;
  gitlab = (await api('/gitlab/status')).data;
  renderGitLab();
  if ($('#task-dialog').open && (previous?.profile?.id !== gitlab.profile?.id
    || previous?.instance !== gitlab.instance || previous?.configured !== gitlab.configured)) setupEditorGitLab();
}

async function refreshChrome() {
  connection = (await api('/chrome/status')).data;
  currentEtag = '';
  renderConnection();
  await refreshLive();
}

function renderConnection() {
  connectionSettings.updateChrome(connection);
  const state = connection.state;
  const phase = capture?.state;
  const badge = $('#connection-badge');
  const details = $('#connection-details');
  const tab = capture?.tab;
  const candidates = capture?.candidates || [];
  const key = JSON.stringify([state, connection.message, current?.id, phase, capture?.message, capture?.startedAt, tab, candidates]);
  if (key === connectionKey) return;
  connectionKey = key;
  let label = '未连接';
  let color = '';
  let help = '在已打开的 Chrome 中启用远程调试，再连接现有标签页。';
  if (state === 'connected') {
    label = phase === 'attached' ? '采集中' : '已连接';
    color = 'ok';
    help = current ? capture?.message || '正在查找匹配的标签页…' : '新建任务后，工作台会匹配已打开的测试网址。';
  } else if (state === 'connecting') {
    label = '连接中';
    color = 'pending';
    help = connection.message;
  } else if (state === 'error' || state === 'disconnected') {
    label = state === 'error' ? '连接失败' : '已断开';
    color = 'error';
    help = connection.message;
  }
  badge.className = `badge ${color}`;
  badge.innerHTML = `<i></i>${label}`;
  let detailsMarkup = `<p>${html(help)}</p>`;
  if (tab && state === 'connected') detailsMarkup = `<div><strong title="${html(tab.url)}">${html(tab.title || tab.url)}</strong><small>采集起始时间 ${html(clock.format(new Date(capture.startedAt)))}</small></div>`;
  const showPicker = state === 'connected' && (phase === 'choose' || (tab && candidates.some((candidate) => candidate.id !== tab.id)));
  if (showPicker) {
    detailsMarkup += `<form class="tab-picker" id="tab-picker"><select name="tabId" aria-label="选择 Chrome 标签页" required>
      <option value="">${tab ? '切换标签页' : '选择标签页'}</option>${candidates.map((item) => `<option value="${html(item.id)}">${html(item.title || item.url)} · ${html(item.url)}</option>`).join('')}
      </select><button class="button secondary" type="submit">接入</button></form>`;
  }
  const previousChoice = $('#tab-picker select')?.value;
  details.innerHTML = detailsMarkup;
  if (previousChoice && $('#tab-picker select')) $('#tab-picker select').value = previousChoice;
  $('#chrome-actions').innerHTML = state === 'connected' || state === 'connecting'
    ? `<button class="button secondary" id="chrome-disconnect" type="button">${state === 'connecting' ? '取消连接' : '断开连接'}</button><button class="button secondary" id="chrome-help" type="button">Chrome 设置</button>`
    : `<button class="button primary" id="chrome-connect" type="button">${icon('link')}${state === 'idle' ? '连接 Chrome' : '重新连接'}</button><button class="button secondary" id="chrome-help" type="button">Chrome 设置</button>`;
}

function filterOptions() {
  if (view === 'network') return [['api', 'Fetch / XHR'], ['all', '全部请求'], ['failed', '失败请求']];
  if (view === 'console') return [['all', '全部级别'], ['error', '错误'], ['warn', '警告'], ['info', '日志与信息']];
  return [['all', '全部类型'], ['network', '仅请求'], ['console', '仅控制台']];
}

function filteredEntries(entries) {
  const filter = $('#entry-filter').value;
  const query = $('#entry-search').value.trim().toLowerCase();
  return entries.filter((entry) => {
    if (view === 'network' && filter === 'api' && !['XHR', 'Fetch', 'Preflight'].includes(entry.resourceType)) return false;
    if (view === 'network' && filter === 'failed' && !entry.error && Number(entry.status) < 400) return false;
    if (view === 'console' && filter !== 'all') {
      const allowed = { error: ['error', 'assert'], warn: ['warning', 'warn'], info: ['log', 'info', 'debug'] };
      if (!allowed[filter]?.includes(entry.level)) return false;
    }
    if (view === 'saved' && filter !== 'all' && entry.kind !== filter) return false;
    const content = entry.kind === 'network' ? `${entry.method} ${entry.url} ${entry.status ?? ''} ${entry.error}` : `${entry.message} ${entry.source} ${entry.level}`;
    return content.toLowerCase().includes(query);
  });
}

function renderEvidence() {
  const live = capture?.entries || [];
  const requests = live.filter((entry) => entry.kind === 'network');
  const logs = live.filter((entry) => entry.kind === 'console');
  $('#network-count').textContent = requests.length;
  $('#console-count').textContent = logs.length;
  $('#saved-count').textContent = current?.evidence.length || 0;
  const source = { network: requests, console: logs, saved: [...(current?.evidence || [])].reverse() }[view];
  const entries = filteredEntries(source);
  const content = $('#evidence-content');
  const saved = new Set(current?.evidence.map((entry) => entry.id));
  if (entries.length) {
    const open = new Set([...content.querySelectorAll('details[open]')].map((detail) => detail.dataset.detail));
    const focus = content.contains(document.activeElement) && document.activeElement.dataset.entry;
    const dimensions = view === 'network' ? '<th>耗时</th>' : '';
    content.innerHTML = `<div class="table-wrap"><table><thead><tr>
      ${view === 'saved' ? '<th>类型</th>' : '<th class="pick"><input type="checkbox" id="pick-visible" aria-label="选择当前筛选结果"></th>'}
      <th>时间</th><th>${view === 'network' ? '请求' : view === 'console' ? '消息' : '证据详情'}</th>
      <th>${view === 'network' ? '状态' : view === 'console' ? '级别' : '状态 / 级别'}</th>${dimensions}
      </tr></thead><tbody>${entries.map((entry) => evidenceRow(entry, saved.has(entry.id), open.has(entry.id))).join('')}</tbody></table></div>`;
    if (focus) content.querySelector(`[data-entry="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  } else {
    const [title, help, action] = emptyEvidence(source.length);
    content.innerHTML = `<div class="empty-state"><span class="empty-mark">${icon(view === 'network' ? 'network' : view === 'console' ? 'terminal' : 'bookmark')}</span>
      <h3>${html(title)}</h3><p>${html(help)}</p>${action ? `<button class="button secondary" type="button" data-empty-action="${action}">${icon(action === 'new' ? 'plus' : 'link')}${action === 'new' ? '新建任务' : '连接 Chrome'}</button>` : ''}</div>`;
  }
  updateSelection(entries);
  $('#evidence-summary').textContent = view === 'saved'
    ? `已保存 ${current?.evidence.length || 0} 条证据。`
    : entries.length ? `显示 ${entries.length} 条记录 · 本机临时记录最多保留 20 分钟。` : '本机临时记录保留最近 20 分钟，最多 400 条。';
}

function emptyEvidence(total) {
  if (loading) return ['正在加载任务', '加载完成后可查看联调记录。'];
  if (!current) return ['还没有联调任务', '新建任务并填写测试网址，工作台会匹配已打开的 Chrome 标签页。', 'new'];
  if (total) return ['没有符合筛选条件的记录', '可以修改关键词或切换筛选条件。'];
  if (view === 'saved') return ['还没有保存证据', '在请求或控制台中勾选记录，点击「保存所选」。'];
  if (connection.state === 'idle' || connection.state === 'error' || connection.state === 'disconnected') {
    return ['等待连接 Chrome', '连接后会自动采集匹配标签页的请求和日志。', 'connect'];
  }
  if (capture?.state === 'attached') return [view === 'network' ? '等待新的请求' : '等待新的日志', '在已连接的 Chrome 标签页继续操作，记录会出现在这里。'];
  if (connection.state === 'connecting') return ['正在连接 Chrome', '如 Chrome 弹出确认窗口，请点击允许。'];
  return ['等待绑定测试标签页', '请在现有 Chrome 中打开任务配置的测试网址。'];
}

function evidenceRow(entry, saved, open) {
  const network = entry.kind === 'network';
  const summary = network ? `<span class="method">${html(entry.method)}</span>${html(entry.url)}` : html(entry.message || '（空日志）');
  const body = network ? [entry.resourceType, entry.error, `${entry.duration} ms`].filter(Boolean).join(' · ') : entry.source || '页面日志';
  const badge = network ? (entry.error ? '失败' : entry.status ?? '—') : levels[entry.level] || entry.level;
  const color = network ? (entry.error || entry.status >= 400 ? 'bad' : entry.status >= 200 && entry.status < 300 ? 'good' : '')
    : ['error', 'assert'].includes(entry.level) ? 'bad' : ['warning', 'warn'].includes(entry.level) ? 'warn' : '';
  return `<tr>${view === 'saved' ? `<td>${network ? '请求' : '控制台'}</td>` : `<td class="pick">${saved ? `<span class="entry-saved" title="已保存" aria-label="已保存">${icon('check')}</span>` : `<input type="checkbox" aria-label="选择${network ? '请求' : '日志'}" data-entry="${html(entry.id)}" ${selected.has(entry.id) ? 'checked' : ''}>`}</td>`}
    <td class="when" title="${html(entry.at)}">${html(clock.format(new Date(entry.at)))}</td>
    <td><details data-detail="${html(entry.id)}" ${open ? 'open' : ''}><summary>${summary}</summary><div class="entry-detail">${html(body)}</div></details></td>
    <td><span class="record-pill ${color}">${html(badge)}</span></td>${view === 'network' ? `<td class="duration">${html(entry.duration)} ms</td>` : ''}</tr>`;
}

function updateSelection(entries) {
  const button = $('#save-evidence');
  button.disabled = selected.size === 0 || savingEvidence;
  button.querySelector('span').textContent = savingEvidence ? '保存中…' : selected.size ? `保存所选 (${selected.size})` : '保存所选';
  const all = $('#pick-visible');
  if (!all) return;
  const boxes = [...$('#evidence-content').querySelectorAll('[data-entry]')];
  const checked = entries ? entries.filter((entry) => selected.has(entry.id)).length : boxes.filter((box) => box.checked).length;
  all.checked = boxes.length > 0 && checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
  all.disabled = !boxes.length;
}

function switchView(next) {
  view = next;
  $('#entry-filter').innerHTML = filterOptions().map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  $('#entry-search').value = '';
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
  }
  renderEvidence();
}

async function refreshLive() {
  if (polling) return;
  polling = true;
  const taskId = current?.id;
  try {
    if (!taskId) {
      const next = (await api('/chrome/status')).data;
      if (!current) {
        connection = next;
        renderConnection();
      }
      return;
    }
    const result = await api(`/tasks/${taskId}/live`, { etag: currentEtag });
    if (!result || current?.id !== taskId) return;
    currentEtag = result.etag;
    connection = result.data.connection;
    capture = result.data.capture;
    const liveIds = new Set(capture.entries.map((entry) => entry.id));
    const removed = [...selected].filter((id) => !liveIds.has(id));
    if (removed.length) {
      removed.forEach((id) => selected.delete(id));
      notify(`${removed.length} 条所选记录已超出本机缓存。`, true);
    }
    renderConnection();
    renderEvidence();
  } catch (error) {
    if (current?.id === taskId) {
      currentEtag = '';
      connection = { state: 'disconnected', message: explain(error), activeTaskId: null };
      renderConnection();
    }
  } finally {
    polling = false;
  }
}

async function selectTask(id, activate = true) {
  if (changingTask || current?.id === id) return;
  changingTask = true;
  try {
    const { data } = await api(`/tasks/${id}`);
    if (activate) connection = (await api(`/tasks/${id}/activate`, { method: 'POST' })).data;
    setCurrent(data);
    await refreshLive();
  } catch (error) {
    notify(explain(error), true);
  } finally {
    changingTask = false;
  }
}

function setCurrent(task) {
  if (current?.id !== task.id) {
    selected.clear();
    capture = null;
    currentEtag = '';
    localStorage.setItem('last-task', task.id);
  }
  current = task;
  renderTask();
  renderConnection();
  renderEvidence();
}

async function setConnection(action) {
  try {
    connection = (await api(`/chrome/${action}`, { method: 'POST' })).data;
    currentEtag = '';
    renderConnection();
    renderEvidence();
    await refreshLive();
  } catch (error) {
    notify(explain(error), true);
  }
}

async function saveEvidence() {
  if (!current || selected.size === 0 || savingEvidence) return;
  const taskId = current.id;
  const ids = [...selected];
  savingEvidence = true;
  updateSelection();
  try {
    const { data } = await api(`/tasks/${taskId}/evidence`, { method: 'POST', body: { ids } });
    if (current?.id === taskId) {
      ids.forEach((id) => selected.delete(id));
      setCurrent(data);
    }
    notify(`已保存 ${ids.length} 条证据。`);
  } catch (error) {
    notify(explain(error), true);
  } finally {
    savingEvidence = false;
    updateSelection();
  }
}

function openEditor(task = null) {
  const dialog = $('#task-dialog');
  if (dialog.open) return;
  editor = {
    taskId: task?.id,
    repos: Object.fromEntries(roles.map((role) => {
      const binding = task?.[role];
      const project = binding ? { id: binding.projectId, path: binding.path, instance: binding.instance || gitlab?.instance } : null;
      const branch = binding ? { name: binding.branch, commitSha: binding.commitSha } : null;
      return [role, { project, branch, projects: project ? [project] : [], branches: branch ? [branch] : [], projectPage: null, branchPage: null, projectRequest: 0, branchRequest: 0 }];
    })),
  };
  $('#editor-title').textContent = task ? '编辑联调任务' : '新建联调任务';
  $('#editor-name').value = task?.title || '';
  $('#editor-url').value = task?.url || '';
  $('#editor-error').hidden = true;
  $('#submit-task').disabled = false;
  $('#editor-repositories').innerHTML = roles.map((role) => `<fieldset class="repo-editor" data-role="${role}">
    <legend>${labels[role]}仓库</legend>
    <input class="repo-search" data-search="project" aria-label="搜索${labels[role]}仓库" placeholder="搜索仓库" autocomplete="off">
    <select data-select="project" aria-label="选择${labels[role]}仓库"></select>
    <button class="button secondary" type="button" data-more="project" hidden>更多仓库</button>
    <input class="repo-search" data-search="branch" aria-label="搜索${labels[role]}分支" placeholder="搜索分支" autocomplete="off">
    <select data-select="branch" aria-label="选择${labels[role]}分支"></select>
    <button class="button secondary" type="button" data-more="branch" hidden>更多分支</button>
    <p class="repo-message" hidden></p></fieldset>`).join('');
  dialog.showModal();
  setupEditorGitLab();
  $('#editor-name').focus();
}

function setupEditorGitLab() {
  if (!editor) return;
  const note = $('#editor-gitlab');
  note.innerHTML = gitlab?.profile ? `已连接 GitLab · ${html(gitlab.profile.username)}` : gitlab?.configured
    ? '<a href="/api/gitlab/login" target="_blank" rel="noopener">连接 GitLab</a> 后可选择仓库和分支。'
    : '<button class="text-button" id="task-gitlab-settings" type="button">配置 GitLab</button> 后可选择仓库和分支。测试网址也可以先保存为任务。';
  for (const role of roles) {
    const slot = editor.repos[role];
    slot.projects = slot.projects.filter((project) => projectIdentity(project) === projectIdentity(slot.project) || project.instance === gitlab?.instance);
    slot.projectPage = null;
    renderRepositoryEditor(role);
    if (gitlab?.profile) {
      void fetchOptions(role, 'project');
      if (slot.project?.instance === gitlab.instance) void fetchOptions(role, 'branch');
    }
  }
}

function projectIdentity(project) {
  return project ? `${project.instance}|${project.id}` : '';
}

function renderRepositoryEditor(role) {
  const slot = editor.repos[role];
  const field = $(`[data-role="${role}"]`);
  const canSearch = Boolean(gitlab?.profile);
  const canSearchBranch = canSearch && Boolean(slot.project) && slot.project.instance === gitlab.instance;
  field.querySelector('[data-search="project"]').disabled = !canSearch;
  field.querySelector('[data-search="branch"]').disabled = !canSearchBranch;
  const project = field.querySelector('[data-select="project"]');
  project.innerHTML = `<option value="">选择仓库</option>${slot.projects.map((item) => `<option value="${html(projectIdentity(item))}">${html(item.path)}${item.instance && item.instance !== gitlab?.instance ? ` · ${html(new URL(item.instance).host)}` : ''}</option>`).join('')}`;
  project.value = projectIdentity(slot.project);
  project.disabled = !canSearch;
  const branch = field.querySelector('[data-select="branch"]');
  branch.innerHTML = `<option value="">选择分支</option>${slot.branches.map((item) => `<option value="${html(item.name)}">${html(item.name)}${item.isDefault ? ' · 默认' : ''}</option>`).join('')}`;
  branch.value = slot.branch?.name || '';
  branch.disabled = !canSearchBranch;
  field.querySelector('[data-more="project"]').hidden = !canSearch || !slot.projectPage;
  field.querySelector('[data-more="branch"]').hidden = !canSearchBranch || !slot.branchPage;
}

async function fetchOptions(role, kind, more = false) {
  const session = editor;
  const slot = session?.repos[role];
  const profile = gitlab?.profile?.id;
  if (!slot || !profile || (kind === 'branch' && slot.project?.instance !== gitlab.instance)) return;
  const instance = gitlab.instance;
  const currentProject = projectIdentity(slot.project);
  const request = ++slot[`${kind}Request`];
  const field = $(`[data-role="${role}"]`);
  const input = field.querySelector(`[data-search="${kind}"]`);
  const query = new URLSearchParams({ search: input.value.trim(), page: String(more ? slot[`${kind}Page`] : 1) });
  const message = field.querySelector('.repo-message');
  message.hidden = true;
  try {
    const endpoint = kind === 'project' ? '/gitlab/projects' : `/gitlab/projects/${slot.project.id}/branches`;
    const { data } = await api(`${endpoint}?${query}`);
    if (editor !== session || gitlab.instance !== instance || gitlab.profile?.id !== profile
      || slot[`${kind}Request`] !== request || (kind === 'branch' && projectIdentity(slot.project) !== currentProject)) return;
    const key = kind === 'project' ? projectIdentity : (item) => item.name;
    const list = kind === 'project' ? 'projects' : 'branches';
    const results = kind === 'project' ? data.items.map((item) => ({ ...item, instance })) : data.items;
    const items = more ? [...slot[list], ...results] : results;
    if (slot[kind] && !items.some((item) => key(item) === key(slot[kind]))) items.unshift(slot[kind]);
    slot[list] = [...new Map(items.map((item) => [key(item), item])).values()];
    slot[`${kind}Page`] = data.nextPage;
    renderRepositoryEditor(role);
  } catch (error) {
    if (editor !== session || slot[`${kind}Request`] !== request) return;
    message.textContent = explain(error);
    message.hidden = false;
  }
}

async function submitTask(event) {
  event.preventDefault();
  const session = editor;
  const error = $('#editor-error');
  const button = $('#submit-task');
  error.hidden = true;
  const body = { title: $('#editor-name').value, url: $('#editor-url').value };
  for (const role of roles) {
    const { project, branch } = session.repos[role];
    if (project && !branch) {
      error.textContent = `请选择${labels[role]}分支。`;
      error.hidden = false;
      return;
    }
    body[role] = project ? { projectId: project.id, instance: project.instance, path: project.path, branch: branch.name, commitSha: branch.commitSha } : null;
  }
  button.disabled = true;
  try {
    const { data } = await api(session.taskId ? `/tasks/${session.taskId}` : '/tasks', { method: session.taskId ? 'PUT' : 'POST', body });
    tasks = session.taskId ? tasks.map((task) => task.id === data.id ? data : task) : [data, ...tasks];
    currentEtag = '';
    capture = null;
    setCurrent(data);
    if (editor === session) $('#task-dialog').close();
    await refreshLive();
    notify(session.taskId ? '任务已更新。' : '任务已创建。');
  } catch (failure) {
    error.textContent = explain(failure);
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { task, view: next, emptyAction, close, more } = button.dataset;
  if (task) void selectTask(task);
  if (next) switchView(next);
  if (close) $(`#${close}`).close();
  if (button.id === 'new-task' || emptyAction === 'new') openEditor();
  if (button.id === 'edit-task') openEditor(current);
  if (button.id === 'chrome-connect' || emptyAction === 'connect') void setConnection('connect');
  if (button.id === 'chrome-disconnect') void setConnection('disconnect');
  if (button.id === 'chrome-help') connectionSettings.open('chrome');
  if (button.id === 'save-evidence') void saveEvidence();
  if (['gitlab-status', 'open-settings', 'task-gitlab-settings'].includes(button.id)) connectionSettings.open();
  if (more) void fetchOptions(button.closest('[data-role]').dataset.role, more, true);
});

document.addEventListener('submit', (event) => {
  if (event.target.id === 'task-form') void submitTask(event);
  if (event.target.id === 'tab-picker') {
    event.preventDefault();
    const tabId = new FormData(event.target).get('tabId');
    void api(`/tasks/${current.id}/tab`, { method: 'POST', body: { tabId } }).then(() => {
      currentEtag = '';
      return refreshLive();
    }).catch((error) => notify(explain(error), true));
  }
});

document.addEventListener('change', (event) => {
  const element = event.target;
  if (element.id === 'entry-filter') renderEvidence();
  if (element.dataset.entry || element.id === 'pick-visible') {
    const boxes = element.id === 'pick-visible' ? $('#evidence-content').querySelectorAll('[data-entry]') : [element];
    for (const box of boxes) {
      box.checked = element.checked;
      if (box.checked) selected.add(box.dataset.entry);
      else selected.delete(box.dataset.entry);
    }
    updateSelection();
  }
  if (element.dataset.select) {
    const field = element.closest('[data-role]');
    const role = field.dataset.role;
    const slot = editor.repos[role];
    if (element.dataset.select === 'project') {
      slot.project = slot.projects.find((item) => projectIdentity(item) === element.value) || null;
      slot.branch = null;
      slot.branches = [];
      slot.branchPage = null;
      ++slot.branchRequest;
      field.querySelector('[data-search="branch"]').value = '';
      renderRepositoryEditor(role);
      void fetchOptions(role, 'branch');
    } else {
      slot.branch = slot.branches.find((item) => item.name === element.value) || null;
    }
  }
});

const timers = new WeakMap();
document.addEventListener('input', (event) => {
  if (event.target.id === 'entry-search') renderEvidence();
  const kind = event.target.dataset.search;
  if (!kind) return;
  const role = event.target.closest('[data-role]').dataset.role;
  ++editor.repos[role][`${kind}Request`];
  const session = editor;
  clearTimeout(timers.get(event.target));
  timers.set(event.target, setTimeout(() => {
    if (editor === session) void fetchOptions(role, kind);
  }, 240));
});

$('#task-dialog').addEventListener('close', () => { editor = null; });
window.addEventListener('focus', () => { void refreshGitLab().catch(() => {}); void refreshLive(); });

async function init() {
  const query = new URLSearchParams(location.search);
  if (query.get('gitlab')) {
    const failed = query.get('gitlab') === 'error';
    notify(failed ? query.get('message') || 'GitLab 授权失败。' : 'GitLab 已授权。', failed);
    history.replaceState(null, '', '/');
  }
  switchView('network');
  renderTask();
  renderConnection();
  try {
    const [loaded, chrome] = await Promise.all([api('/tasks'), api('/chrome/status'), refreshGitLab()]);
    tasks = loaded.data;
    connection = chrome.data;
    loading = false;
    const desired = connection.activeTaskId || localStorage.getItem('last-task');
    const initial = tasks.find((task) => task.id === desired) || tasks[0];
    if (initial) await selectTask(initial.id, initial.id !== connection.activeTaskId);
  } catch (error) {
    notify(explain(error), true);
  } finally {
    loading = false;
    renderTask();
    renderConnection();
    renderEvidence();
    setInterval(() => { void refreshLive(); }, 800);
  }
}

void init();
