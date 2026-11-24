import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

export function readConfig() {
  const port = Number(process.env.PORT || 4321);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('PORT 必须是 1024–65535 之间的整数。');
  }

  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    dataFile: resolve(process.env.WORKBENCH_DATA_FILE || join(root, 'data', 'tasks.json')),
    chromeDataDir: resolve(process.env.CHROME_USER_DATA_DIR || chromeDataDirectory()),
    webDir: join(root, 'web'),
    gitlab: {
      baseUrl: normalizeGitLabUrl(process.env.GITLAB_URL || 'https://gitlab.com'),
      clientId: process.env.GITLAB_CLIENT_ID?.trim() || '',
      clientSecret: process.env.GITLAB_CLIENT_SECRET?.trim() || '',
      redirectUri: `${origin}/api/gitlab/callback`,
    },
  };
}

export function settingsPath(dataFile: string) {
  return join(dirname(dataFile), 'settings.json');
}

export function normalizeGitLabUrl(value: string) {
  const url = URL.parse(value.trim());
  if (!url || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, '请输入 GitLab 实例的根地址。');
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new HttpError(400, 'GitLab 实例地址应使用 HTTPS。本机测试实例可使用 HTTP。');
  }
  return url.href.replace(/\/+$/, '');
}

function chromeDataDirectory() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'google-chrome');
}
