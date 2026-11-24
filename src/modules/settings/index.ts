import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { normalizeGitLabUrl } from '../../config.ts';
import { HttpError } from '../../http.ts';
import { writeJsonFile } from '../../json-file.ts';
import { canProtectSecrets, protectSecret, unprotectSecret } from './windows-secrets.ts';

type GitLabDefaults = { baseUrl: string; clientId: string; clientSecret: string; redirectUri: string };
type GitLabSettings = Omit<GitLabDefaults, 'redirectUri'> & { confidential: boolean };
type StoredGitLab = Omit<GitLabSettings, 'clientSecret'> & { encryptedSecret?: string };
type StoredSettings = { version: 1; gitlab?: StoredGitLab; chromeDataDir?: string };

export class SettingsStore {
  private file: string;
  private defaults: { gitlab: GitLabDefaults; chromeDataDir: string };
  private stored: StoredSettings;
  private secret: string;
  private pending: Promise<unknown> = Promise.resolve();

  static async open(file: string, defaults: { gitlab: GitLabDefaults; chromeDataDir: string }) {
    let stored: StoredSettings = { version: 1 };
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as StoredSettings;
      if (raw.version !== 1) throw new Error('连接设置文件格式不受支持。');
      stored = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let secret = '';
    if (canProtectSecrets && stored.gitlab?.encryptedSecret) {
      // A copied settings file may belong to a different Windows user.
      secret = await unprotectSecret(stored.gitlab.encryptedSecret).catch(() => '');
    }
    return new SettingsStore(file, defaults, stored, secret);
  }

  private constructor(file: string, defaults: { gitlab: GitLabDefaults; chromeDataDir: string }, stored: StoredSettings, secret: string) {
    this.file = file;
    this.defaults = defaults;
    this.stored = stored;
    this.secret = secret;
  }

  gitlab() {
    const settings = this.gitlabSettings();
    return {
      baseUrl: settings.baseUrl,
      clientId: settings.confidential && !settings.clientSecret ? '' : settings.clientId,
      clientSecret: settings.clientSecret,
      redirectUri: this.defaults.gitlab.redirectUri,
    };
  }

  chromeDataDir() {
    return this.stored.chromeDataDir || this.defaults.chromeDataDir;
  }

  publicSettings() {
    const { baseUrl, clientId, confidential, clientSecret } = this.gitlabSettings();
    return {
      gitlab: {
        baseUrl, clientId, confidential, hasSecret: Boolean(clientSecret),
        secretProtection: canProtectSecrets ? 'windows' : 'session',
        redirectUri: this.defaults.gitlab.redirectUri,
      },
      chrome: { dataDir: this.stored.chromeDataDir || '', defaultDataDir: this.defaults.chromeDataDir },
    };
  }

  setGitLab(input: unknown) {
    const { baseUrl, clientId, confidential, clientSecret } = settingsInput(input);
    return this.change(async () => {
      const current = this.gitlabSettings();
      const sameApp = baseUrl === current.baseUrl && clientId === current.clientId;
      const secret = confidential ? clientSecret || (sameApp ? current.clientSecret : '') : '';
      if (confidential && !secret) throw new HttpError(400, '请输入保密应用的 Client Secret。');
      let encryptedSecret: string | undefined;
      if (secret && canProtectSecrets) {
        encryptedSecret = sameApp && secret === current.clientSecret ? this.stored.gitlab?.encryptedSecret : undefined;
        if (!encryptedSecret) {
          encryptedSecret = await protectSecret(secret).catch(() => {
            throw new HttpError(500, '无法用当前 Windows 用户保存密钥，请重试。');
          });
        }
      }
      const updated: StoredSettings = { ...this.stored, gitlab: { baseUrl, clientId, confidential, encryptedSecret } };
      await writeJsonFile(this.file, updated);
      this.stored = updated;
      this.secret = secret;
    });
  }

  private gitlabSettings(): GitLabSettings {
    if (this.stored.gitlab) {
      const { baseUrl, clientId, confidential } = this.stored.gitlab;
      return { baseUrl, clientId, confidential, clientSecret: this.secret };
    }
    const { baseUrl, clientId, clientSecret } = this.defaults.gitlab;
    return { baseUrl, clientId, clientSecret, confidential: Boolean(clientSecret) };
  }

  private change(action: () => Promise<void>) {
    const pending = this.pending.then(action);
    this.pending = pending.catch(() => {});
    return pending;
  }
}

export function parseChromePath(input: unknown) {
  const { dataDir } = fields(input);
  if (typeof dataDir !== 'string' || dataDir.length > 2048 || dataDir.includes('\0')) {
    throw new HttpError(400, '请输入有效的 Chrome 用户数据目录。');
  }
  const path = dataDir.trim().replace(/^"(.*)"$/, '$1');
  if (!path) return '';
  if (!isAbsolute(path) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(path))) {
    throw new HttpError(400, '请输入本机 Chrome 用户数据目录的完整路径。');
  }
  return resolve(path);
}

function fields(input: unknown) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '请填写连接设置。');
  return input as Record<string, unknown>;
}

function settingsInput(input: unknown) {
  const { baseUrl, clientId, confidential, clientSecret } = fields(input);
  if (typeof baseUrl !== 'string' || baseUrl.length > 2048) throw new HttpError(400, '请输入 GitLab 实例地址。');
  if (typeof clientId !== 'string' || !/^\S{1,512}$/.test(clientId.trim())) throw new HttpError(400, '请输入 OAuth 应用 ID。');
  if (typeof confidential !== 'boolean' || (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.length > 2048))) {
    throw new HttpError(400, '请检查 OAuth 应用类型和密钥。');
  }
  return { baseUrl: normalizeGitLabUrl(baseUrl), clientId: clientId.trim(), confidential, clientSecret: clientSecret?.trim() || '' };
}
