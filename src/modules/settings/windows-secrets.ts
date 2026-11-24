import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const canProtectSecrets = process.platform === 'win32';

export function protectSecret(secret: string) {
  return dpapi('Protect', Buffer.from(secret));
}

export async function unprotectSecret(secret: string) {
  const clear = await dpapi('Unprotect', Buffer.from(secret, 'base64'));
  return Buffer.from(clear, 'base64').toString('utf8');
}

function dpapi(operation: 'Protect' | 'Unprotect', input: Buffer) {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;
    $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());
    $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Console]::Write([Convert]::ToBase64String($result));`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && /^[a-z\d+/]+=*$/i.test(output)) resolve(output);
      else reject(new Error('无法使用当前 Windows 用户保护或读取 OAuth 密钥。'));
    });
    child.stdin.end(input.toString('base64'));
  });
}
