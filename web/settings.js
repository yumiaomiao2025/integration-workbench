export function createSettings({ api, notify, explain, refreshGitLab, refreshChrome, setConnection }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#settings-dialog');
  const gitlabForm = $('#gitlab-settings-form');
  const chromeForm = $('#chrome-settings-form');
  const tabs = [...dialog.querySelectorAll('[data-settings-tab]')];
  const url = $('#settings-gitlab-url');
  const clientId = $('#settings-gitlab-client-id');
  const confidential = $('#settings-gitlab-confidential');
  const secret = $('#settings-gitlab-secret');
  const directory = $('#settings-chrome-directory');
  const detect = $('#settings-chrome-detection');
  let settings;
  let pane = 'gitlab';
  let loading = false;
  let loadError = '';
  let readVersion = 0;
  let chromeCheck = 0;
  let gitlabStatus;
  let chromeStatus;

  function showPane(value) {
    pane = value;
    for (const tab of tabs) {
      const active = tab.dataset.settingsTab === pane;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', active);
    }
    $('#settings-loading').hidden = !loading;
    $('#settings-load-error').hidden = !loadError;
    $('#settings-load-error p').textContent = loadError;
    gitlabForm.hidden = !settings || pane !== 'gitlab';
    chromeForm.hidden = !settings || pane !== 'chrome';
  }

  async function load() {
    const version = ++readVersion;
    settings = undefined;
    loading = true;
    loadError = '';
    showPane(pane);
    try {
      const { data } = await api('/settings');
      if (!dialog.open || version !== readVersion) return;
      settings = data;
      populateGitLab();
      populateChrome();
    } catch (error) {
      if (version === readVersion) loadError = explain(error);
    } finally {
      if (version === readVersion) {
        loading = false;
        showPane(pane);
      }
    }
  }

  function populateGitLab() {
    const config = settings.gitlab;
    url.value = config.baseUrl;
    clientId.value = config.clientId;
    confidential.checked = config.confidential;
    secret.value = '';
    $('#settings-gitlab-callback').value = config.redirectUri;
    clearGitLabError();
    updateGitLab();
  }

  function populateChrome() {
    directory.value = settings.chrome.dataDir;
    directory.placeholder = settings.chrome.defaultDataDir;
    $('#settings-chrome-default').textContent = `留空使用自动查找的目录。如果使用自定义配置，请填写 Chrome 用户数据根目录。默认路径为 ${settings.chrome.defaultDataDir}。`;
    hideDetection();
    setError('chrome', '');
    updateChrome();
  }

  function setError(section, message) {
    const field = $(`#settings-${section}-error`);
    field.textContent = message;
    field.hidden = !message;
  }

  function gitlabDraft() {
    return {
      baseUrl: parseGitLabUrl(url.value), clientId: clientId.value.trim(),
      confidential: confidential.checked, clientSecret: confidential.checked ? secret.value.trim() : '',
    };
  }

  function updateGitLab() {
    if (!settings) return;
    const config = settings.gitlab;
    const draft = gitlabDraft();
    const sameApp = draft.baseUrl === config.baseUrl && draft.clientId === config.clientId;
    const dirty = !sameApp || draft.confidential !== config.confidential || Boolean(draft.clientSecret);
    const secretSaved = sameApp && config.hasSecret;
    const profile = gitlabStatus?.profile;
    const authorizeReady = !dirty && Boolean(config.clientId) && (!config.confidential || config.hasSecret) && !profile;
    const account = $('#settings-gitlab-account');
    account.textContent = profile ? `已授权 · ${profile.name} (@${profile.username})`
      : authorizeReady ? 'GitLab 设置已保存，等待授权。' : 'GitLab 尚未授权。';
    account.parentElement.classList.toggle('setting-ready', authorizeReady || Boolean(profile));
    $('#settings-gitlab-logout').hidden = !profile;
    $('#settings-gitlab-secret-fields').hidden = !draft.confidential;
    secret.disabled = !draft.confidential;
    secret.required = draft.confidential && !secretSaved;
    secret.placeholder = secretSaved ? '已保存，留空保留现有密钥' : '粘贴 GitLab 显示的 Client Secret';
    $('#settings-gitlab-secret-help').textContent = config.secretProtection === 'windows'
      ? '密钥由当前 Windows 用户加密保存。' : '密钥保留在本次本机服务会话中。';
    const authorize = $('#settings-gitlab-authorize');
    authorize.hidden = !authorizeReady;
    authorize.target = $('#task-dialog').open ? '_blank' : '_self';
    const saveButton = $('#save-gitlab-settings');
    saveButton.classList.toggle('primary', !authorizeReady);
    saveButton.classList.toggle('secondary', authorizeReady);
    $('#settings-gitlab-hint').textContent = dirty ? '保存后即可授权。' : (config.confidential && !config.hasSecret ? '请输入密钥后保存。' : '');

    const register = $('#settings-gitlab-register');
    register.hidden = !draft.baseUrl;
    if (draft.baseUrl) register.href = `${draft.baseUrl}/oauth/applications`;
    else register.removeAttribute('href');
  }

  function clearGitLabError() {
    for (const field of [url, clientId, secret]) field.removeAttribute('aria-invalid');
    setError('gitlab', '');
  }

  function validateGitLab(draft) {
    let error;
    if (!draft.baseUrl) error = [url, '请输入有效的 GitLab 实例地址，例如 gitlab.example.com。'];
    else if (!/^\S{1,512}$/.test(draft.clientId)) error = [clientId, '请粘贴 GitLab 页面上完整的应用程序 ID。'];
    else if (secret.required && !draft.clientSecret) error = [secret, '请输入 GitLab 私密应用的密码（Client Secret）。'];
    if (!error) return true;
    const [field, message] = error;
    field.setAttribute('aria-invalid', 'true');
    field.focus();
    setError('gitlab', message);
    return false;
  }

  function updateChrome() {
    if (!settings) return;
    const changed = directory.value.trim() !== settings.chrome.dataDir;
    const state = chromeStatus?.state;
    const connect = $('#settings-chrome-connect');
    connect.hidden = changed;
    connect.disabled = state === 'connecting' || state === 'connected';
    connect.textContent = state === 'connecting' ? '连接中…' : state === 'connected' ? 'Chrome 已连接' : '连接 Chrome';
    $('#settings-chrome-hint').textContent = changed ? '保存目录后即可连接。'
      : ['connecting', 'error', 'disconnected'].includes(state) ? chromeStatus.message : '';
  }

  function hideDetection() {
    ++chromeCheck;
    detect.hidden = true;
    $('#settings-chrome-test').disabled = false;
  }

  async function checkChrome() {
    const check = ++chromeCheck;
    const button = $('#settings-chrome-test');
    button.disabled = true;
    setError('chrome', '');
    detect.hidden = true;
    try {
      const { data } = await api('/settings/chrome/check', { method: 'POST', body: { dataDir: directory.value } });
      if (check !== chromeCheck) return;
      detect.className = `form-note ${data.ready ? 'setting-ready' : 'setting-unavailable'}`;
      detect.textContent = data.message;
      detect.hidden = false;
    } catch (error) {
      if (check === chromeCheck) setError('chrome', explain(error));
    } finally {
      if (check === chromeCheck) button.disabled = false;
    }
  }

  async function save(event, section) {
    event.preventDefault();
    const version = readVersion;
    const isGitLab = section === 'gitlab';
    const button = isGitLab ? $('#save-gitlab-settings') : $('#save-chrome-settings');
    const body = isGitLab ? gitlabDraft() : { dataDir: directory.value };
    if (isGitLab) {
      clearGitLabError();
      if (!validateGitLab(body)) return;
    } else {
      setError(section, '');
    }
    button.disabled = true;
    const label = button.textContent;
    button.textContent = '保存中…';
    try {
      const { data } = await api(`/settings/${section}`, { method: 'PUT', body });
      await (isGitLab ? refreshGitLab() : refreshChrome()).catch(() => {});
      if (version === readVersion && dialog.open) {
        settings[section] = data[section];
        if (isGitLab) populateGitLab();
        else populateChrome();
      }
      notify(isGitLab ? 'GitLab 设置已保存。' : 'Chrome 设置已保存。');
    } catch (error) {
      if (version === readVersion && dialog.open) setError(section, explain(error));
      else notify(explain(error), true);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function copy(input) {
    try {
      await navigator.clipboard.writeText(input.value);
      notify('地址已复制。');
    } catch {
      input.select();
      notify('已选中地址，可手动复制。');
    }
  }

  gitlabForm.addEventListener('input', () => { clearGitLabError(); updateGitLab(); });
  gitlabForm.addEventListener('submit', (event) => { void save(event, 'gitlab'); });
  chromeForm.addEventListener('submit', (event) => { void save(event, 'chrome'); });
  directory.addEventListener('input', () => { setError('chrome', ''); hideDetection(); updateChrome(); });
  $('#settings-chrome-test').addEventListener('click', () => { void checkChrome(); });
  $('#settings-chrome-connect').addEventListener('click', () => { void setConnection('connect'); });
  $('#copy-gitlab-callback').addEventListener('click', () => { void copy($('#settings-gitlab-callback')); });
  $('#copy-chrome-address').addEventListener('click', () => { void copy($('#settings-chrome-address')); });
  $('#settings-retry').addEventListener('click', () => { void load(); });
  $('#settings-gitlab-logout').addEventListener('click', async () => {
    try {
      await api('/gitlab/logout', { method: 'POST' });
      await refreshGitLab();
      notify('已退出 GitLab。');
    } catch (error) {
      setError('gitlab', explain(error));
    }
  });
  for (const tab of tabs) tab.addEventListener('click', () => showPane(tab.dataset.settingsTab));
  dialog.addEventListener('close', () => { secret.value = ''; hideDetection(); });

  return {
    open(section = 'gitlab') {
      pane = section;
      if (dialog.open) { showPane(pane); return; }
      dialog.showModal();
      void load();
    },
    updateGitLab(status) { gitlabStatus = status; updateGitLab(); },
    updateChrome(status) { chromeStatus = status; updateChrome(); },
  };
}

function parseGitLabUrl(value) {
  const address = value.trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(address);
  const bareAddress = /^(?:[\p{L}\p{N}][\p{L}\p{N}.-]*|\[[a-f\d:]+\])(?::\d+)?(?:\/[^\s\\]*)?$/iu;
  if (!hasScheme && !bareAddress.test(address)) return '';
  const url = URL.parse(hasScheme ? address : `https://${address}`);
  if (!url || url.username || url.password || url.search || url.hash) return '';
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) return '';
  url.pathname = url.pathname.replace(/\/(?:oauth\/applications(?:\/\d+(?:\/edit)?)?|(?:-\/)?user_settings\/applications)\/?$/, '');
  return url.href.replace(/\/+$/, '');
}
