import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = process.cwd();
const browserPath = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(path => { try { return statSync(path).isFile(); } catch { return false; } });
assert.ok(browserPath, '需要本机 Chrome 或 Edge');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((request, response) => {
  try {
    const relative = decodeURIComponent(request.url.split('?')[0]).replace(/^[/\\]+/, '') || 'index.html';
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) { response.writeHead(403); response.end(); return; }
    const content = readFileSync(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    response.end(content);
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__nativeVoiceMock = { calls: [], mode: 'ok', delay: 20 };
    window.MochiVoiceRecorder = {
      start(token) {
        const mock = window.__nativeVoiceMock;
        mock.calls.push('start');
        const mode = mock.mode;
        setTimeout(() => window.mochiNativeVoiceResult(token,
          mode === 'deny' ? 'error' : 'started', mode === 'deny' ? 'permission-denied' : ''), mock.delay);
      },
      stop(token) {
        window.__nativeVoiceMock.calls.push('stop');
        const sample = btoa('native audio payload '.repeat(40));
        setTimeout(() => window.mochiNativeVoiceResult(token, 'stopped', sample), 30);
      },
      cancel() { window.__nativeVoiceMock.calls.push('cancel'); }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => !!window.__mochiDataReady);
  await page.evaluate(() => {
    document.querySelector('.splash-confirm-btn')?.click();
    document.getElementById('splash').hidden = true;
    window.enterChat();
    window.activeStore().set('cs-voice-send', '1');
    document.dispatchEvent(new Event('voice-send-changed'));
    window.chatVoiceReceipt = async () => 'yes';
    document.getElementById('chat-mic-btn').click();
  });
  await page.evaluate(() => document.getElementById('voice-record-btn').click());
  await page.waitForFunction(() => document.getElementById('voice-status').textContent === '正在录音…');
  await page.waitForTimeout(1100);
  await page.evaluate(() => document.getElementById('voice-record-btn').click());
  await page.waitForFunction(() => !document.getElementById('voice-send-btn').disabled);
  assert.equal(await page.locator('#voice-status').textContent(), '录制完成');
  await page.evaluate(() => document.getElementById('voice-send-btn').click());
  await page.waitForFunction(() => !!document.querySelector('#chat-body .msg-voice'));
  assert.deepEqual((await page.evaluate(() => window.__nativeVoiceMock.calls)).slice(0, 2), ['start', 'stop']);
  console.log('PASS 原生录音回传后可试听并发送到聊天');

  await page.evaluate(() => {
    window.__nativeVoiceMock.mode = 'deny';
    document.getElementById('chat-mic-btn').click();
    document.getElementById('voice-record-btn').click();
  });
  await page.waitForFunction(() => document.getElementById('cc-toast')?.textContent.includes('麦克风权限被拒绝'));
  assert.equal(await page.locator('#voice-send-btn').isDisabled(), true);
  console.log('PASS 系统拒绝权限时显示明确提示且不能发送');

  await page.evaluate(() => {
    window.__nativeVoiceMock.mode = 'ok';
    window.__nativeVoiceMock.delay = 500;
    document.getElementById('voice-record-btn').click();
    document.getElementById('voice-close').click();
  });
  await page.waitForTimeout(700);
  assert.ok((await page.evaluate(() => window.__nativeVoiceMock.calls)).includes('cancel'));
  assert.equal(await page.locator('#voice-panel').getAttribute('hidden'), '');
  console.log('PASS 录音授权等待中关闭面板会取消请求');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
