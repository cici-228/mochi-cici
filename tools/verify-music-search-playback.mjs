import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = normalize(dirname(fileURLToPath(import.meta.url)) + '/..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  try {
    let path = normalize(join(root, decodeURIComponent(req.url.split('?')[0])));
    if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const chromePaths = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = chromePaths.find(path => { try { return statSync(path).isFile(); } catch { return false; } });
if (!executablePath) throw new Error('找不到 Chrome/Edge');
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 850 } });
const check = (label, condition) => {
  if (!condition) throw new Error(label);
  console.log('PASS ' + label);
};
try {
  await page.addInitScript(() => {
    window.__mockAudio = [];
    window.Audio = function () {
      const listeners = {};
      const audio = {
        paused: true, ended: false, currentTime: 0, duration: 180,
        readyState: 4, networkState: 1, volume: 1, muted: false,
        buffered: { length: 1, end: () => 180 }, style: {},
        addEventListener: (name, callback) => { (listeners[name] ||= []).push(callback); },
        removeAttribute: () => {}, load: () => {},
        play() {
          this.paused = false;
          this.onplay?.();
          (listeners.playing || []).forEach(callback => callback());
          return Promise.resolve();
        },
        pause() { this.paused = true; this.onpause?.(); }
      };
      window.__mockAudio.push(audio);
      return audio;
    };
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/index.html');
  await page.waitForFunction(() => window.__mochiDataReady && window.mochiMusicOpenQueue, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.ciciNeteaseEnhanced = {
      refresh: async () => ({ loggedIn: true }), loggedIn: () => true,
      findCandidates: async () => [
        { id: '9001', name: '搜索甲', artists: '测试', duration: 180000, picUrl: '' },
        { id: '9002', name: '搜索乙', artists: '测试', duration: 180000, picUrl: '' }
      ],
      resolveTrack: async () => ({ url: 'https://cdn.test/song.mp3', source: 'netease' }),
      recommendations: async () => [
        { id: '8001', name: '列表甲', artists: '测试', duration: 180000, picUrl: '' },
        { id: '8002', name: '列表乙', artists: '测试', duration: 180000, picUrl: '' }
      ]
    };
    document.getElementById('music-search').hidden = false;
    document.getElementById('cici-netease-recommendations').hidden = false;
    document.getElementById('page-music').hidden = false;
    document.getElementById('modal-mask').hidden = true;
    document.getElementById('modal-mask').style.pointerEvents = 'none';
  });
  const placement = await page.evaluate(() => {
    const search = document.getElementById('music-search');
    const library = document.querySelector('#page-music [data-mpanel="lib"]');
    const scroll = document.querySelector('#page-music .cal-scroll');
    return search.parentElement === scroll && search.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  check('搜索卡在音乐库上方且共用滚动区域', !!placement);
  const searchBox = page.locator('.ce-box[data-for="music-search-input"]');
  await searchBox.fill('浪漫');
  await page.locator('#music-search-submit').click();
  await page.waitForSelector('#music-search-results [data-search-index="0"]', { timeout: 5000 });
  check('搜索框仍在，两个结果显示在独立卡片', await page.locator('#music-search-form').isVisible() &&
    await page.locator('#music-search-results [data-search-index]').count() === 2);
  await page.locator('#music-search-results [data-search-index="0"]').click();
  await page.evaluate(() => window.mochiMusicOpenQueue());
  const singleQueue = await page.locator('#td-qlist .sm-song-name').allTextContents();
  check('空列表点搜索甲，只把搜索甲放进当前播放', singleQueue.length === 1 && singleQueue[0] === '搜索甲');
  await page.evaluate(() => window.__mockAudio.at(-1).onended());
  check('单首搜索曲播完停止，不循环搜索结果', await page.locator('#sm-player-bar').isHidden());
  await searchBox.fill('');
  check('清空搜索词后结果消失、搜索框保留', await page.locator('#music-search-results [data-search-index]').count() === 0 &&
    await page.locator('#music-search-form').isVisible());

  await page.evaluate(() => { document.getElementById('tc-mask').hidden = true; });
  await page.locator('#music-daily-recommend').click();
  await page.waitForFunction(() => document.getElementById('sm-pb-name')?.textContent.trim() === '列表甲');
  await searchBox.fill('幸福');
  await page.locator('#music-search-submit').click();
  await page.waitForSelector('#music-search-results [data-search-index="1"]');
  await page.locator('#music-search-results [data-search-index="1"]').click();
  await page.evaluate(() => window.mochiMusicOpenQueue());
  const mergedQueue = await page.locator('#td-qlist .sm-song-name').allTextContents();
  check('选中的搜索乙排第一，后面只接原列表待播的列表乙',
    mergedQueue.join('|') === '搜索乙|列表乙');
  await page.evaluate(() => window.__mockAudio.at(-1).onended());
  await page.waitForFunction(() => document.getElementById('sm-pb-name')?.textContent.trim() === '列表乙');
  check('搜索乙播完接列表乙', true);
} finally {
  await browser.close();
  server.close();
}
