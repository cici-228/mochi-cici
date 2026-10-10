import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = normalize(dirname(fileURLToPath(import.meta.url)) + '/..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  try {
    let file = normalize(join(root, decodeURIComponent(req.url.split('?')[0])));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const chromePaths = [process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
const executablePath = chromePaths.find(path => { try { return statSync(path).isFile(); } catch { return false; } });
if (!executablePath) throw new Error('找不到 Chrome/Edge');
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (label, condition) => { if (!condition) throw new Error(label); console.log('PASS ' + label); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.__mochiDataReady && window.chatSendMsg && window.ciciBackgroundTick,
    { timeout: 15000 });
  await page.evaluate(() => {
    document.getElementById('modal-mask').hidden = true;
    document.getElementById('modal-mask').style.pointerEvents = 'none';
    window.enterChat();
    const oldCfg = window.replyCfg;
    window.replyCfg = () => ({ ...oldCfg(), 'rn-prob': 0, 'rs-min': 60, 'rs-max': 60,
      'touch-prob': 0, 'reply-min': 1, 'reply-max': 1, 'py-en': 0, 'turn-en': 0 });
    window.__movieChecks = 0;
    window.__realMovieRequest = window.maybeMovieRequest;
    window.maybeMovieRequest = () => { window.__movieChecks++; return true; };
    window.chatSendMsg('后台聊天验证');
  });
  check('发消息后进入等待回复', await page.evaluate(() =>
    !document.getElementById('chat-typing').hidden));
  await page.evaluate(() => {
    window.__realNow = Date.now;
    window.__fakeNow = Date.now() + 61000;
    Date.now = () => window.__fakeNow;
    window.ciciBackgroundTick();
  });
  await page.waitForFunction(() => (window.__replyDiag || 0) >= 1, { timeout: 10000 });
  check('后台心跳让到期的字卡回复进入投递链', true);
  await page.evaluate(() => {
    window.__fakeNow += 10000;
    window.ciciBackgroundTick();
  });
  await page.waitForFunction(() => window.__movieChecks >= 1, { timeout: 10000 });
  check('回复后的邀请检查继续执行', await page.evaluate(() => window.__movieChecks >= 1));
  const movieQueued = await page.evaluate(() => {
    window.maybeMovieRequest = window.__realMovieRequest;
    window.activeStore().set('movie-invite-prob', '100');
    window.taInvitePickKind = kind => kind === 'movie' ? { kind, text: '一起看电影吧' } : null;
    window.__nativeNotifies = 0;
    window.bgNotifyCheck = () => { window.__nativeNotifies++; };
    document.getElementById('tc-mask').hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const opened = window.maybeMovieRequest();
    return { opened, stored: !!window.activeStore().get('movie-background-invite'),
      panelHidden: document.getElementById('tc-mask').hidden, notices: window.__nativeNotifies };
  });
  check('后台看电影邀请先入聊天与待确认，不在后台弹面板',
    movieQueued.opened && movieQueued.stored && movieQueued.panelHidden && movieQueued.notices === 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('回到前台后显示待确认的看电影邀请', await page.evaluate(() =>
    !!document.getElementById('movie-invite-accept') &&
    !document.getElementById('tc-mask').hidden));
  const musicQueued = await page.evaluate(() => {
    document.getElementById('tc-mask').hidden = true;
    window.taInvitePickKind = kind => kind === 'music' ? { kind, text: '一起听歌吧' } : null;
    window.__realRandom = Math.random;
    Math.random = () => 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const before = window.__nativeNotifies;
    window.maybeMusicRequest();
    Math.random = window.__realRandom;
    const cid = window.__activeCid || 'default';
    return { stored: !!window.storeFor(cid).get('music-background-invite'),
      panelHidden: document.getElementById('tc-mask').hidden,
      notices: window.__nativeNotifies - before };
  });
  check('后台听歌邀请先入聊天与待确认',
    musicQueued.stored && musicQueued.panelHidden && musicQueued.notices === 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('回到前台后显示待确认的听歌邀请', await page.evaluate(() =>
    !!document.getElementById('sm-req-yes') && !document.getElementById('tc-mask').hidden));
  const gameQueued = await page.evaluate(() => {
    document.getElementById('tc-mask').hidden = true;
    document.getElementById('modal-mask').hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.sendTaInvite({ kind: 'rps', text: '来猜拳吧' }, 'TA');
    window.__fakeNow += 2000;
    window.ciciBackgroundTick();
    const cid = window.__activeCid || 'default';
    return { stored: !!window.storeFor(cid).get('ta-invite-background-pending'),
      modalHidden: document.getElementById('modal-mask').hidden };
  });
  check('普通邀请在后台保存待确认状态，不自动同意', gameQueued.stored && gameQueued.modalHidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('回到前台后显示普通邀请确认窗口', await page.evaluate(() =>
    !document.getElementById('modal-mask').hidden &&
    document.getElementById('modal-title').textContent.includes('猜拳邀请')));
  await page.evaluate(() => {
    window.__notificationRoute = [];
    const oldCid = window.__activeCid;
    const oldSwitch = window.setActiveContact;
    const oldEnter = window.enterChat;
    window.setActiveContact = cid => { window.__notificationRoute.push('contact:' + cid); window.__activeCid = cid; };
    window.enterChat = () => { window.__notificationRoute.push('chat'); };
    window.ciciHandleNativeNotification('nk|msg|test-contact|123');
    window.__restoreNotificationRoute = () => {
      window.__activeCid = oldCid;
      window.setActiveContact = oldSwitch;
      window.enterChat = oldEnter;
    };
  });
  await page.waitForFunction(() => window.__notificationRoute.length === 2, { timeout: 5000 });
  check('点击安卓消息通知会进入归属联系人的聊天', await page.evaluate(() =>
    window.__notificationRoute.join(',') === 'contact:test-contact,chat'));
  await page.evaluate(() => window.__restoreNotificationRoute());
  check('页面没有未捕获错误', errors.length === 0);
  await page.evaluate(() => { Date.now = window.__realNow; });
} finally {
  await browser.close();
  server.close();
}
