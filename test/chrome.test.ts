import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChromeCollector } from '../src/modules/chrome/index.ts';
import { CdpConnection, chromeEndpoint } from '../src/modules/chrome/cdp.ts';
import { listen, stop, until } from './support.ts';

const executable = process.env.WORKBENCH_TEST_CHROME;

test('collects two tabs in one Chrome instance and keeps listening after navigation', {
  skip: executable ? false : 'Set WORKBENCH_TEST_CHROME to the Chrome executable to run this test',
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'workbench-chrome-'));
  const fixture = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
      <button id="run">Send request</button><script>
        const started = crypto.randomUUID();
        window.pageSession = started;
        console.log('before connecting');
        document.querySelector('#run').onclick = async () => {
          const response = await fetch('/api/orders?password=quite-private');
          await response.json();
          console.warn('request complete', response.status);
        };
      </script>`);
  });
  const origin = await listen(fixture);
  const pageUrl = `${origin}/orders`;
  const secondaryUrl = `${origin}/inventory`;
  const chrome = spawn(executable!, [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${dataDir}`, '--remote-debugging-port=0', pageUrl,
  ], { stdio: 'ignore', windowsHide: true });
  const exited = once(chrome, 'exit').catch(() => []);
  let driver: CdpConnection | undefined;
  const collector = new ChromeCollector(dataDir, pageUrl);
  const secondary = new ChromeCollector(dataDir, secondaryUrl);
  t.after(async () => {
    collector.disconnect();
    secondary.disconnect();
    if (driver) await driver.send('Browser.close').catch(() => {});
    driver?.close();
    if (chrome.exitCode === null && !chrome.killed) chrome.kill();
    await exited;
    await stop(fixture);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const endpoint = await until(() => chromeEndpoint(dataDir).catch(() => undefined));
  driver = await CdpConnection.open(endpoint, AbortSignal.timeout(5_000));
  const devtools = driver;
  const tab = await until(async () => (await devtools.send('Target.getTargets')).targetInfos.find((target) => target.url === pageUrl));
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const getPageSession = async () => (await devtools.send('Runtime.evaluate', { expression: 'window.pageSession' }, sessionId)).result.value;
  const pageSession = await until(getPageSession);
  assert.equal(typeof pageSession, 'string');

  collector.connect();
  await until(async () => collector.live().state === 'attached' ? true : undefined);
  assert.equal(collector.live().tabs[0]?.id, tab.targetId);
  assert.equal(await getPageSession(), pageSession);
  await devtools.send('Runtime.evaluate', { expression: 'document.querySelector("#run").click()' }, sessionId);
  const entries = await until(async () => {
    const entries = collector.live().entries;
    return entries.some((entry) => entry.kind === 'network' && entry.url === `${origin}/api/orders`)
      && entries.some((entry) => entry.kind === 'console' && entry.message === 'request complete 200') ? entries : undefined;
  });
  assert.doesNotMatch(JSON.stringify(entries), /quite-private|before connecting/);

  const { targetId: secondaryTarget } = await devtools.send('Target.createTarget', { url: secondaryUrl });
  secondary.connect();
  await until(async () => secondary.live().tabs[0]?.id === secondaryTarget ? true : undefined);
  const { sessionId: secondarySession } = await devtools.send('Target.attachToTarget', { targetId: secondaryTarget, flatten: true });
  await devtools.send('Runtime.evaluate', { expression: 'console.error("secondary workspace only")' }, secondarySession);
  await until(async () => secondary.live().entries.some((entry) => entry.kind === 'console' && entry.message === 'secondary workspace only') ? true : undefined);
  assert.doesNotMatch(JSON.stringify(collector.live().entries), /secondary workspace only/);
  secondary.disconnect();
  assert.equal(collector.live().tabs[0]?.id, tab.targetId);
  collector.choose(secondaryTarget);
  await until(async () => collector.live().tabs.length === 2 ? true : undefined);
  await devtools.send('Runtime.evaluate', { expression: 'console.error("second page in same task")' }, secondarySession);
  const fromSecondPage = await until(async () => collector.live().entries.find((entry) =>
    entry.kind === 'console' && entry.message === 'second page in same task'));
  assert.equal(fromSecondPage.page?.url, secondaryUrl);
  collector.remove(secondaryTarget);
  assert.deepEqual(collector.live().tabs.map(({ id }) => id), [tab.targetId]);

  await devtools.send('Page.navigate', { url: `${origin}/orders/details` }, sessionId);
  await until(async () => collector.live().tabs[0]?.url.endsWith('/details') ? true : undefined);
  await until(async () => {
    const current = await getPageSession();
    return current && current !== pageSession ? true : undefined;
  });
  await devtools.send('Runtime.evaluate', { expression: 'console.error("after navigation")' }, sessionId);
  await until(async () => collector.live().entries.some((entry) => entry.kind === 'console' && entry.message === 'after navigation') ? true : undefined);
});
