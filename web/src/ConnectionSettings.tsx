import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ConnectionStatus } from '../../src/contracts.ts';
import { api, explain, gitLabLogin, type ChromeDetection, type ChromeSettings, type GitLabSettings, type GitLabStatus } from './api.ts';
import { ClaudeConnectionTest } from './ClaudeConnectionTest.tsx';
import { Dialog, Icon } from './ui.tsx';

export type SettingsPane = 'gitlab' | 'chrome' | 'claude';
type Notify = (message: string, isError?: boolean) => void;
type Settings = { gitlab: GitLabSettings; chrome: ChromeSettings | null };

export function ConnectionSettings({ initialPane, workspace, gitlabStatus, connection, fromEditor, onClose, setGitLabStatus,
  refreshGitLab, refreshChrome, connectChrome, notify }: {
  initialPane: SettingsPane;
  workspace: { id: string; title: string } | null;
  gitlabStatus: GitLabStatus | null;
  connection: ConnectionStatus;
  fromEditor: boolean;
  onClose: () => void;
  setGitLabStatus: (status: GitLabStatus) => void;
  refreshGitLab: () => Promise<void>;
  refreshChrome: () => void;
  connectChrome: () => void;
  notify: Notify;
}) {
  const [pane, setPane] = useState(initialPane);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const workspaceId = workspace?.id;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const chrome = workspaceId ? api.chromeSettings(workspaceId, signal) : null;
    void Promise.all([api.settings(signal), chrome]).then(([{ gitlab }, chrome]) => {
      if (!signal.aborted) setSettings({ gitlab, chrome });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(explain(error));
    });
    return () => { controller.abort(); };
  }, [retry, workspaceId]);

  return <Dialog id="settings-dialog" title="连接设置" description="管理 GitLab、Chrome 和 Claude Code 连接。" onClose={onClose}>
    <div className="settings-tabs tabs" aria-label="连接类型">
      <button type="button" className={`evidence-tab${pane === 'gitlab' ? ' active' : ''}`} aria-pressed={pane === 'gitlab'} onClick={() => setPane('gitlab')}>
        <Icon name="git" />GitLab
      </button>
      {workspace && <button type="button" className={`evidence-tab${pane === 'chrome' ? ' active' : ''}`} aria-pressed={pane === 'chrome'} onClick={() => setPane('chrome')}>
        <Icon name="browser" />Chrome
      </button>}
      <button type="button" className={`evidence-tab${pane === 'claude' ? ' active' : ''}`} aria-pressed={pane === 'claude'} onClick={() => setPane('claude')}>
        <Icon name="terminal" />Claude Code
      </button>
    </div>
    {settings ? <>
      <GitLabForm initial={settings.gitlab} visible={pane === 'gitlab'} status={gitlabStatus} fromEditor={fromEditor}
        refresh={refreshGitLab} setStatus={setGitLabStatus} notify={notify} />
      {workspace && settings.chrome && <ChromeForm workspace={workspace} initial={settings.chrome} visible={pane === 'chrome'} connection={connection}
        refresh={refreshChrome} connect={connectChrome} notify={notify} />}
    </> : loadError ? <div className="settings-loading"><p role="alert">{loadError}</p>
      <button type="button" className="button secondary" onClick={() => { setLoadError(''); setRetry((value) => value + 1); }}>重试</button>
    </div> : <p className="settings-loading" role="status">正在读取本机设置…</p>}
    {pane === 'claude' && <div className="dialog-body">
      <p>工作台使用本机 Claude Code 的模型配置。测试会向当前模型服务发送一条简短消息。</p>
      <ClaudeConnectionTest />
    </div>}
  </Dialog>;
}

type GitLabFormError = { field?: 'url' | 'clientId' | 'secret'; message: string };

function GitLabForm({ initial, visible, status, fromEditor, refresh, setStatus, notify }: {
  initial: GitLabSettings; visible: boolean; status: GitLabStatus | null; fromEditor: boolean;
  refresh: () => Promise<void>; setStatus: (status: GitLabStatus) => void; notify: Notify;
}) {
  const [config, setConfig] = useState(initial);
  const [url, setUrl] = useState(initial.baseUrl);
  const [clientId, setClientId] = useState(initial.clientId);
  const [confidential, setConfidential] = useState(initial.confidential);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<GitLabFormError | null>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const idField = useRef<HTMLInputElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const baseUrl = parseGitLabUrl(url);
  const sameApp = baseUrl === config.baseUrl && clientId.trim() === config.clientId;
  const dirty = !sameApp || confidential !== config.confidential || (confidential && Boolean(secret.trim()));
  const secretSaved = sameApp && config.hasSecret;
  const profile = status?.profile;
  const canAuthorize = !dirty && Boolean(config.clientId) && (!config.confidential || config.hasSecret) && !profile;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const id = clientId.trim();
    const clientSecret = confidential ? secret.trim() : '';
    if (!baseUrl) {
      setError({ field: 'url', message: '请输入有效的 GitLab 实例地址，例如 gitlab.example.com。' });
      urlField.current?.focus();
      return;
    }
    if (!/^\S{1,512}$/.test(id)) {
      setError({ field: 'clientId', message: '请粘贴 GitLab 页面上完整的应用程序 ID。' });
      idField.current?.focus();
      return;
    }
    if (confidential && !secretSaved && !clientSecret) {
      setError({ field: 'secret', message: '请输入 GitLab 私密应用的密码（Client Secret）。' });
      secretField.current?.focus();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { gitlab } = await api.saveGitLab({ baseUrl, clientId: id, confidential, clientSecret });
      setConfig(gitlab);
      setUrl(gitlab.baseUrl);
      setClientId(gitlab.clientId);
      setConfidential(gitlab.confidential);
      setSecret('');
      await refresh().catch(() => {});
      notify('GitLab 设置已保存。');
    } catch (failure) {
      setError({ message: explain(failure) });
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    try {
      setStatus(await api.gitLabLogout());
      notify('已退出 GitLab。');
    } catch (failure) {
      setError({ message: explain(failure) });
    }
  }

  return <form noValidate hidden={!visible} onChange={() => setError(null)} onSubmit={(event) => void save(event)}>
    <div className="dialog-body">
      <div className={`settings-account form-note${canAuthorize || profile ? ' setting-ready' : ''}`}>
        <span role="status">{profile ? `已授权 · ${profile.name} (@${profile.username})`
          : canAuthorize ? 'GitLab 设置已保存，等待授权。' : 'GitLab 尚未授权。'}</span>
        {profile && <button className="button secondary" type="button" onClick={() => void logout()}>退出授权</button>}
      </div>
      {error && <p className="form-error" id="settings-gitlab-error" role="alert">{error.message}</p>}
      <label className="field">GitLab 实例或 OAuth 应用页面地址<input ref={urlField} inputMode="url" placeholder="gitlab.example.com"
        maxLength={2048} required spellCheck={false} aria-invalid={error?.field === 'url'} aria-errormessage="settings-gitlab-error"
        value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <div className="settings-instructions">
        <p>在 GitLab 应用设置中，将下方地址填到「回调 URL」或 Redirect URI，范围勾选 <code>read_api</code>。</p>
        <CopyAddress id="settings-gitlab-callback" label="OAuth 回调地址" value={config.redirectUri}>
          {baseUrl && <a className="button secondary" href={`${baseUrl}/oauth/applications`} target="_blank" rel="noopener noreferrer">打开 GitLab 应用设置</a>}
        </CopyAddress>
      </div>
      <label className="field">应用程序 ID<input ref={idField} placeholder="复制 GitLab 的完整 Application ID" maxLength={512}
        required autoComplete="off" spellCheck={false} aria-invalid={error?.field === 'clientId'} aria-errormessage="settings-gitlab-error"
        value={clientId} onChange={(event) => setClientId(event.target.value)} /></label>
      <div>
        <label className="settings-checkbox"><input type="checkbox" checked={confidential} onChange={(event) => setConfidential(event.target.checked)} />
          <span>GitLab 应用已勾选「私密」（Confidential）</span></label>
        <p className="settings-field-help">GitLab 的「私密」为「否」时，只填应用程序 ID 即可。</p>
      </div>
      {confidential && <div>
        <label className="field">密码（Client Secret）<input ref={secretField} type="password" maxLength={2048} autoComplete="new-password"
          spellCheck={false} aria-invalid={error?.field === 'secret'} aria-errormessage="settings-gitlab-error" required={!secretSaved}
          placeholder={secretSaved ? '已保存，留空保留现有密钥' : '粘贴 GitLab 显示的 Client Secret'} value={secret}
          onChange={(event) => setSecret(event.target.value)} /></label>
        <p className="settings-field-help" id="settings-gitlab-secret-help">{config.secretProtection === 'windows'
          ? '密钥由当前 Windows 用户加密保存。' : '密钥保留在本次本机服务会话中。'}</p>
      </div>}
    </div>
    <footer className="dialog-footer settings-footer">
      <span className="settings-footer-status" role="status">{dirty ? '保存后即可授权。'
        : config.confidential && !config.hasSecret ? '请输入密钥后保存。' : ''}</span>
      <button className={`button ${canAuthorize ? 'secondary' : 'primary'}`} type="submit" disabled={saving}>{saving ? '保存中…' : '保存 GitLab 设置'}</button>
      {canAuthorize && !saving && <a className="button primary" href={gitLabLogin} target={fromEditor ? '_blank' : '_self'} rel="noopener">前往 GitLab 授权</a>}
    </footer>
  </form>;
}

function ChromeForm({ workspace, initial, visible, connection, refresh, connect, notify }: {
  workspace: { id: string; title: string }; initial: ChromeSettings; visible: boolean; connection: ConnectionStatus;
  refresh: () => void; connect: () => void; notify: Notify;
}) {
  const [config, setConfig] = useState(initial);
  const [directory, setDirectory] = useState(initial.dataDir);
  const [detection, setDetection] = useState<ChromeDetection | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const changed = directory.trim() !== config.dataDir;
  const connected = connection.state === 'connected';
  const connecting = connection.state === 'connecting';

  useEffect(() => () => pending.current?.abort(), []);

  function changeDirectory(value: string) {
    pending.current?.abort();
    setChecking(false);
    setDetection(null);
    setError('');
    setDirectory(value);
  }

  async function detect() {
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    setError('');
    setChecking(true);
    setDetection(null);
    try {
      const result = await api.chromeCheck(workspace.id, directory, controller.signal);
      if (!controller.signal.aborted) setDetection(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(explain(failure));
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const chrome = await api.saveChrome(workspace.id, directory);
      setConfig(chrome);
      changeDirectory(chrome.dataDir);
      refresh();
      notify('任务的 Chrome 设置已保存。');
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setSaving(false);
    }
  }

  return <form hidden={!visible} onSubmit={(event) => void save(event)}>
    <div className="dialog-body">
      <div className="settings-instructions">
        <p>当前任务为「{workspace.title}」。</p>
        <p>在已经打开的 Chrome 144 或更新版本中访问下方地址，启用远程调试。连接时，Chrome 会请求你的许可。</p>
        <CopyAddress id="settings-chrome-address" label="Chrome 远程调试设置地址" value="chrome://inspect/#remote-debugging" />
      </div>
      <label className="field">Chrome 用户数据目录<input autoComplete="off" spellCheck={false} maxLength={2048}
        placeholder={config.defaultDataDir} value={directory} onChange={(event) => changeDirectory(event.target.value)} /></label>
      <p className="settings-field-help">留空使用默认目录 {config.defaultDataDir}。如需连接另一个 Chrome 实例，请填入该实例的用户数据根目录。</p>
      {detection && <p className={`form-note ${detection.ready ? 'setting-ready' : 'setting-unavailable'}`} role="status">{detection.message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <footer className="dialog-footer settings-footer">
      <span className="settings-footer-status" role="status">{changed ? '保存目录后即可连接。'
        : ['connecting', 'error', 'disconnected'].includes(connection.state) ? connection.message : ''}</span>
      <button className="button secondary" type="button" disabled={checking || saving} onClick={() => void detect()}>{checking ? '检测中…' : '检测 Chrome'}</button>
      {!changed && <button className="button secondary" type="button" disabled={connecting || connected || saving} onClick={connect}>
        {connecting ? '连接中…' : connected ? 'Chrome 已连接' : '连接 Chrome'}
      </button>}
      <button className="button primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存 Chrome 设置'}</button>
    </footer>
  </form>;
}

function CopyAddress({ id, label, value, children }: { id: string; label: string; value: string; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback('已复制');
    } catch {
      input.current?.select();
      setFeedback('可手动复制');
    }
  }
  return <>
    <label className="field" htmlFor={id}>{label}</label>
    <div className="settings-copy">
      <input id={id} ref={input} value={value} readOnly />
      <button className="button secondary" type="button" onClick={() => void copy()}>{feedback || '复制地址'}</button>
      {children}
    </div>
  </>;
}

function parseGitLabUrl(value: string) {
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
