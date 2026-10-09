import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(dirname(fileURLToPath(import.meta.url)) + '/..');
const browser = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  .find(path => { try { return statSync(path).isFile(); } catch { return false; } });
if (!browser) throw new Error('找不到 Chrome/Edge');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  try {
    let path = normalize(join(root, decodeURIComponent(req.url.split('?')[0])));
    if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream' });
    res.end(readFileSync(path));
  } catch { if (!res.headersSent) res.writeHead(404); res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = 18000 + Math.floor(Math.random() * 500);
const chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + join(process.env.TEMP || '/tmp', 'cici-ta-messages-' + Date.now()), '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
let ws, serial = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise(resolve => { const id = ++serial; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
      const page = pages.find(item => item.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        ws.onmessage = event => { const reply = JSON.parse(event.data); if (pending.has(reply.id)) { pending.get(reply.id)(reply.result); pending.delete(reply.id); } };
        return;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error('浏览器连接超时');
}
async function evalJs(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const state = (id, title, position = 5000) => ({ access: true, active: true, playing: true, title, artist: '歌手', duration: 180000, position, mediaId: id, activeQueueId: id, canSkipNext: true, canSkipToQueueItem: true, queue: [
  { id: '1', mediaId: '1', title: '网易云甲', artist: '歌手' },
  { id: '2', mediaId: '2', title: '网易云乙', artist: '歌手' },
  { id: '3', mediaId: '3', title: '网易云丙', artist: '歌手' }
] });
let count = 0;
function check(name, ok) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (ok) count++; }
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__calls=[];window.MochiNetease={refresh(){},requestAccess(){},command(x){window.__calls.push("command:"+x)},seekTo(){},skipToQueueItem(x){window.__calls.push("skip:"+x)}};' });
  const boot = async () => {
    await cdp('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/index.html' });
    for (let i = 0; i < 60; i++) { await sleep(250); if (await evalJs('!!window.__mochiDataReady && !!window.mochiNeteaseUpdate')) break; }
    await evalJs('document.getElementById("splash")?.click();window.__messages=[];window.chatAddSystem=(text,opts)=>window.__messages.push({text,opts});Object.assign(window.mochiMusicGetSettings(),{neteaseAutoEn:true,taPauseEn:false,taFavProb:0,taReserveProb:0,taNextProb:100,taRandProb:0,taModeProb:0});');
  };
  await boot();
  await evalJs(`window.mochiNeteaseUpdate(${JSON.stringify(state('1', '网易云甲'))});window.mochiNeteaseUpdate(${JSON.stringify(state('2', '网易云乙', 178500))});window.mochiNeteaseUpdate(${JSON.stringify(state('3', '网易云丙'))});`);
  check('网易云曲终请求 TA 切下一首', await evalJs('window.__calls.includes("command:next")'));
  check('切歌确认前没有系统消息', await evalJs('window.__messages.length===0'));
  await evalJs(`window.mochiNeteaseUpdate(${JSON.stringify(state('1', '网易云甲'))});`);
  check('切歌确认后显示歌曲名且静默', await evalJs('window.__messages.length===1 && window.__messages[0].text.includes("切到了下一首《网易云甲》") && window.__messages[0].opts.silent===true'));
  await boot();
  await evalJs('Object.assign(window.mochiMusicGetSettings(),{taNextProb:0,taRandProb:100});');
  await evalJs(`window.mochiNeteaseUpdate(${JSON.stringify(state('1', '网易云甲', 178500))});window.mochiNeteaseUpdate(${JSON.stringify(state('2', '网易云乙'))});`);
  const target = await evalJs('window.__calls.find(x=>x.startsWith("skip:"))?.slice(5)');
  check('网易云随机挑歌发出指定跳转', target === '1' || target === '3');
  check('随机挑歌确认前没有系统消息', await evalJs('window.__messages.length===0'));
  if (target) await evalJs(`window.mochiNeteaseUpdate(${JSON.stringify(state(target, target === '1' ? '网易云甲' : '网易云丙'))});`);
  check('随机挑歌确认后显示歌曲名且静默', await evalJs('window.__messages.length===1 && window.__messages[0].text.includes("随机挑了一首《") && window.__messages[0].opts.silent===true'));
} finally {
  try { ws?.close(); } catch {}
  chrome.kill(); server.close();
}
console.log('结果：' + count + '/6');
if (count !== 6) process.exitCode = 1;
