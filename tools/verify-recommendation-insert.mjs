// 网易云推荐播放时插播本地歌曲：验证当前播放列表、默认歌单和曲终顺序。
// 用法：node tools/verify-recommendation-insert.mjs（需先 node build.mjs）
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(dirname(fileURLToPath(import.meta.url)) + '/..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const chromePath = candidates.find((p) => { try { return statSync(p).isFile(); } catch (e) { return false; } });
if (!chromePath) { console.error('找不到 Chrome/Edge'); process.exit(1); }
if (typeof WebSocket !== 'function') { console.error('需要 Node 21+'); process.exit(1); }

function makeWavDataUrl(seconds, sr) {
  const n = sr * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / sr * 440) * 4000), 44 + i * 2);
  return 'data:audio/wav;base64,' + buf.toString('base64');
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = createServer((req, res) => {
  try {
    let p = normalize(join(root, decodeURIComponent(req.url.split('?')[0])));
    if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (statSync(p).isDirectory()) p = join(p, 'index.html');
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  } catch (e) { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
const cdpPort = Number(process.env.MOCHI_CDP_PORT) || (9700 + Math.floor(Math.random() * 90));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--user-data-dir=' + join(process.env.TEMP || '/tmp', 'mochi-mrq-' + Date.now()),
  '--remote-debugging-port=' + cdpPort, 'about:blank'
], { stdio: 'ignore' });
let ws = null, msgId = 0; const pend = new Map();
async function cdpConnect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
        return;
      }
    } catch (e) {}
    await sleep(150);
  }
  throw new Error('无法连接无头浏览器');
}
function cdp(method, params = {}) { const id = ++msgId; return new Promise((res) => { pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); }); }
async function evalJs(expr) {
  try {
    const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return null;
    return r && r.result ? r.result.value : null;
  } catch (e) { return null; }
}
await cdpConnect();
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__remoteCommands=[];
  window.MochiNetease={
    refresh(){}, requestAccess(){}, seekTo(){}, skipToQueueItem(){},
    command(action){window.__remoteCommands.push(action)}
  };` });
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const results = [];
function check(desc, ok, detail) {
  results.push({ desc, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + desc + (detail !== undefined ? '  [' + detail + ']' : ''));
}

async function openMusic(tab) {
  await cdp('Page.navigate', { url: baseUrl + '/index.html' });
  await sleep(2200);
  for (let i = 0; i < 40; i++) { if (await evalJs('!!window.__mochiDataReady')) break; await sleep(300); }
  await sleep(500);
  await evalJs("(function(){var s=document.getElementById('splash');if(s&&!s.classList.contains('hide')){try{s.click();}catch(e){}}return true;})()");
  await sleep(600);
  await evalJs("(function(){document.querySelectorAll('.page').forEach(function(p){p.hidden=(p.id!=='page-music');});var t=document.querySelector('#page-music .fav-tab[data-mtab=\"" + (tab || 'lib') + "\"]');if(t)t.click();return true;})()");
  await sleep(500);
}
// 在真正的音乐页面中验证：插播曲保留在默认歌单，同时加入当前推荐播放列表。
const recommendationAudio = makeWavDataUrl(30, 8000);
const insertedAudio = makeWavDataUrl(2, 8000);
await openMusic('lib');
await evalJs(`window.storeFor('default').set('music-library', JSON.stringify([{
  id:'inserted', name:'插播曲', artist:'测试', url:${JSON.stringify(insertedAudio)},
  source:'url', duration:2, playlistId:'spl_default', addedAt:Date.now()
}, {id:'old-remote',name:'旧版同步曲',source:'netease-account',playlistId:'cici_netease_remote'},
   {id:'old-heart',name:'旧版心动曲',source:'netease-account',playlistId:'cici_netease_heart'}]));
  window.storeFor('default').set('music-playlists', JSON.stringify([
    {id:'spl_default',name:'默认歌单'}, {id:'cici_netease_remote',name:'网易云当前播放'},
    {id:'cici_netease_heart',name:'网易云心动模式'}]));
  window.storeFor('default').set('music-global', JSON.stringify({
  taNextProb:0, taRandProb:0, taModeProb:0, taFavProb:0, taPauseEn:false
})); true`);
await openMusic('lib');
check('升级时清除旧版累积的自动歌单，保留我的歌曲', await evalJs(`(() => {
  const songs=JSON.parse(window.storeFor('default').get('music-library'));
  const lists=JSON.parse(window.storeFor('default').get('music-playlists'));
  return songs.length===1 && songs[0].id==='inserted' &&
    !lists.some(x=>x.id==='cici_netease_remote'||x.id==='cici_netease_heart');
})()`));
await evalJs(`window.ciciNeteaseEnhanced={
  refresh:async()=>({loggedIn:true}),
  recommendations:async()=>[
    {id:'1001',name:'推荐第一首',artists:'测试',duration:30000,picUrl:''},
    {id:'1002',name:'推荐第二首',artists:'测试',duration:30000,picUrl:''}
  ],
  loggedIn:()=>true,
  resolveTrack:async()=>({url:${JSON.stringify(recommendationAudio)},time:30000})
}; document.getElementById('music-daily-recommend').click(); true`);
await sleep(1000);
check('每日推荐由 CiCi 起播第一首', await evalJs("document.getElementById('sm-pb-name')?.textContent.trim()==='推荐第一首'"));
check('每日推荐只在当前播放，不进入我的音乐库', await evalJs("!JSON.parse(window.storeFor('default').get('music-library')).some(x=>x.playlistId==='cici_netease_daily'||x.playlistId==='cici_netease_heart')"));
await evalJs(`document.querySelector('#music-lib-list .sm-song-more[data-id="inserted"]').click();
  document.getElementById('sm-e-qnext').click(); true`);
check('插播曲进入待播队列', await evalJs("window.mochiMusicQueuedTracks().some(x=>x.id==='inserted')"));
await evalJs("document.getElementById('sm-next').click(); true");
await sleep(350);
await evalJs("document.getElementById('sm-queue').click(); true");
const visibleIds = await evalJs("Array.from(document.querySelectorAll('#td-qlist .sm-song')).map(x=>x.dataset.qid).join(',')");
check('插播时当前播放列表包含原推荐曲和插播曲', visibleIds === 'cici_net_daily_1001,inserted,cici_net_daily_1002', visibleIds);
check('插播曲仍在默认歌单', await evalJs("JSON.parse(window.storeFor('default').get('music-library')).some(x=>x.id==='inserted'&&x.playlistId==='spl_default')"));
await evalJs("document.getElementById('sm-q-close').click(); true");
for (let i = 0; i < 30; i++) {
  if (await evalJs("document.getElementById('sm-pb-name')?.textContent.trim()==='推荐第二首'")) break;
  await sleep(150);
}
check('插播自然结束后继续原推荐列表下一首', await evalJs("document.getElementById('sm-pb-name')?.textContent.trim()==='推荐第二首'"));
await evalJs(`window.ciciNeteaseEnhanced.recommendations=async()=>[
  {id:'1001',name:'推荐第一首',artists:'测试',duration:30000,picUrl:''},
  {id:'1003',name:'刷新后的新歌',artists:'测试',duration:30000,picUrl:''}
]; window.mochiMusicRefreshRecommendation(); true`);
await sleep(200);
await evalJs("document.getElementById('sm-queue').click(); true");
const refreshedIds = await evalJs("Array.from(document.querySelectorAll('#td-qlist .sm-song')).map(x=>x.dataset.qid).join(',')");
check('推荐列表刷新保留已播曲和插播曲，并接上新歌',
  refreshedIds === 'cici_net_daily_1001,inserted,cici_net_daily_1002,cici_net_daily_1003', refreshedIds);
check('刷新推荐列表不打断当前播放', await evalJs("document.getElementById('sm-pb-name')?.textContent.trim()==='推荐第二首'"));
await evalJs("document.getElementById('sm-q-close').click(); true");
await evalJs(`window.mochiNeteaseUpdate({access:true,active:true,playing:true,
  title:'远程第一首',artist:'测试',duration:30000,position:1000,
  mediaId:'2001',activeQueueId:'q1',queue:[
    {id:'q1',mediaId:'2001',title:'远程第一首',artist:'测试'},
    {id:'q2',mediaId:'2002',title:'远程第二首',artist:'测试'}
  ]}); window.mochiNeteasePlayCurrent(); true`);
await evalJs(`document.querySelector('#music-lib-list .sm-song-more[data-id="inserted"]').click();
  document.getElementById('sm-e-qnext').click();
  window.mochiMusicPlayQueuedTrack('inserted'); true`);
await evalJs(`window.mochiNeteaseUpdate({access:true,active:true,playing:false,
  title:'远程第一首',artist:'测试',duration:30000,position:1000,
  mediaId:'2001',activeQueueId:'q1',queue:[
    {id:'q1',mediaId:'2001',title:'远程第一首',artist:'测试'},
    {id:'q2',mediaId:'2002',title:'远程第二首',artist:'测试'},
    {id:'q3',mediaId:'2003',title:'远程新加入歌曲',artist:'测试'}
  ]}); true`);
await sleep(300);
await evalJs("document.getElementById('sm-queue').click(); true");
const remoteIds = await evalJs("Array.from(document.querySelectorAll('#td-qlist .sm-song')).map(x=>x.dataset.qid).join(',')");
check('队列接管并刷新后保留插播曲、接入网易云新增曲',
  /^cici_remote_[^,]+_0,inserted,cici_remote_[^,]+_1,cici_remote_[^,]+$/.test(remoteIds), remoteIds);
check('网易云当前播放只在当前列表，不累积进我的音乐库', await evalJs("!JSON.parse(window.storeFor('default').get('music-library')).some(x=>x.playlistId==='cici_netease_remote'||x.playlistId==='cici_netease_daily'||x.playlistId==='cici_netease_heart')"));
check('接管时暂停网易云', await evalJs("window.__remoteCommands.includes('pause')"));
await evalJs("document.getElementById('sm-q-close').click(); true");
for (let i = 0; i < 30; i++) {
  if (await evalJs("document.getElementById('sm-pb-name')?.textContent.trim()==='远程第二首'")) break;
  await sleep(150);
}
check('插播结束后由 CiCi 播放网易云队列的下一首', await evalJs("document.getElementById('sm-pb-name')?.textContent.trim()==='远程第二首'"));
check('CiCi 接播时未请求网易云恢复播放', await evalJs("!window.__remoteCommands.includes('play')"));
await evalJs(`window.mochiNeteaseUpdate({access:true,active:true,playing:false,
  title:'远程第二首',artist:'测试',duration:30000,position:0,mediaId:'2002',activeQueueId:'q2'});
  window.mochiNeteaseUpdate({access:true,active:true,playing:true,
  title:'用户手动选的歌',artist:'测试',duration:30000,position:0,mediaId:'2003',activeQueueId:'q3'}); true`);
check('网易云再次手动播放时停止 CiCi 音频', await evalJs("!window.mochiMusicHasLocalPlayback()"));
await evalJs(`window.mochiNeteaseUpdate({access:true,active:true,playing:true,
  title:'新队列第一首',artist:'测试',duration:30000,position:1000,
  mediaId:'3001',activeQueueId:'n1',queue:[
    {id:'n1',mediaId:'3001',title:'新队列第一首',artist:'测试'},
    {id:'n2',mediaId:'3002',title:'新队列第二首',artist:'测试'}
  ]}); window.mochiNeteasePlayCurrent();
  document.querySelector('#music-lib-list .sm-song-more[data-id="inserted"]').click();
  document.getElementById('sm-e-qnext').click();
  window.mochiMusicPlayQueuedTrack('inserted');
  window.mochiNeteaseUpdate({access:true,active:true,playing:true,
    title:'刚手动点的歌',artist:'测试',duration:30000,position:0,
    mediaId:'3003',activeQueueId:'n3'}); true`);
check('刚接管时网易云手动选歌也立即停止 CiCi', await evalJs("!window.mochiMusicHasLocalPlayback()"));
try { if (ws) ws.close(); } catch (e) {}
try { chrome.kill(); } catch (e) {}
try { server.close(); } catch (e) {}
const failed = results.filter(item => !item.ok).length;
console.log(`结果：${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
