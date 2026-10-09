import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(dirname(fileURLToPath(import.meta.url)) + '/..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chromePath = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean).find(path => { try { return statSync(path).isFile(); } catch { return false; } });
if (!chromePath) throw new Error('找不到 Chrome/Edge');
const server = createServer((req, res) => {
  try {
    let path = normalize(join(root, decodeURIComponent(req.url.split('?')[0])));
    if (!path.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream' });
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = 9800 + Math.floor(Math.random() * 80);
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + join(process.env.TEMP || '/tmp', 'cici-resume-' + Date.now()), '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
let ws, msgId = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise(resolve => { const id = ++msgId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, timeout = 10000) {
  for (let i = 0; i < timeout / 100; i++) { if (await evaluate(expression)) return true; await sleep(100); }
  return false;
}
function wav(seconds) {
  const length = seconds * 8000;
  const buffer = Buffer.alloc(44 + length, 128);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + length, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(length, 40);
  return 'data:audio/wav;base64,' + buffer.toString('base64');
}
const remote = { access: true, active: true, playing: true, title: '网易云歌曲', artist: '歌手', duration: 180000, position: 5000, mediaId: 'remote-1', activeQueueId: 'remote-1', canSkipNext: true, queue: [] };
const results = [];
function check(label, ok) { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + label); }
try {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
      const page = pages.find(item => item.type === 'page');
      if (!page) throw new Error('page missing');
      ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      ws.onmessage = event => { const message = JSON.parse(event.data); if (pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); } };
      break;
    } catch { await sleep(150); }
  }
  if (!ws) throw new Error('无法连接浏览器');
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__remoteCalls=[];window.__remoteFixture=' + JSON.stringify(remote) + ';window.MochiNetease={refresh(){},requestAccess(){},command(x){window.__remoteCalls.push(x);if(x==="pause")setTimeout(()=>window.mochiNeteaseUpdate({...window.__remoteFixture,playing:false}),100);if(x==="play"&&!window.__remotePlayFails)setTimeout(()=>window.mochiNeteaseUpdate({...window.__remoteFixture,playing:true}),600)},seekTo(){},skipToQueueItem(){}};' });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/index.html' });
  if (!await waitFor('!!window.__mochiDataReady')) throw new Error('页面未加载');
  const localWav = wav(20);
  await evaluate(`window.storeFor('default').set('music-library',JSON.stringify([{id:'fallback-song',name:'默认下一首',url:${JSON.stringify(localWav)},source:'url',playlistId:'spl_default',duration:20},{id:'invite-song',name:'邀请本地曲',url:${JSON.stringify(wav(3))},source:'url',playlistId:'spl_default',duration:3}]));window.storeFor('default').set('music-favs',JSON.stringify(['invite-song']));window.storeFor('default').set('music-favs-ta',JSON.stringify([{id:'missing-reserve',name:'预订测试曲'}]));`);
  await evaluate('window.xyStore("xy-home-v2").set("cc-groups-public",JSON.stringify({text:[],musicKeyword:[["曲风",["治愈"]]]}));');
  await cdp('Page.reload', { ignoreCache: true });
  await sleep(1000);
  if (!await waitFor('!!window.__mochiDataReady && typeof window.maybeMusicRequest==="function"')) throw new Error('音乐模块未加载');
  await evaluate('document.getElementById("splash")?.click();');
  const bookedWav = wav(3);
  await evaluate(`window.CiCiMusicApi={request:(token,type,value)=>{const data=type==='search'?{code:200,data:{songs:[{id:9101,name:'预订在线曲',artists:'歌手',duration:3000}]}}:type==='lyric'?{code:200,data:{lrc:''}}:{code:200,data:[{url:${JSON.stringify(bookedWav)}}]};setTimeout(()=>window.ciciOnlineMusicResponse(token,JSON.stringify(data)),0)}};Object.assign(window.mochiMusicGetSettings(),{reqProb:0,taReserveProb:100,keywordProb:0,cooldownMs:0,taPauseEn:false,taFavProb:0});window.mochiNeteaseUpdate(window.__remoteFixture);`);
  await evaluate(`window.CiCiMusicApi.request=(token,type,value)=>{const data=type==='search'?{code:200,data:{songs:[{id:9101,name:'预订在线曲',artists:'歌手',duration:3000}]}}:type==='lyric'?{code:200,data:{lrc:''}}:{code:200,data:[{url:${JSON.stringify(bookedWav)}}]};setTimeout(()=>window.ciciOnlineMusicResponse(token,JSON.stringify(data)),250)};window.__testHidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__testHidden});window.__random=Math.random;Math.random=()=>0.999;window.maybeMusicRequest();Math.random=window.__random;`);
  if (!await waitFor('window.mochiMusicQueuedTracks().length>0')) throw new Error('后台预订未入队');
  await evaluate('window.__pendingReservationId=window.mochiMusicQueuedTracks()[0].id;');
  await evaluate('window.__testHidden=true;window.mochiMusicPlayNextQueued();');
  await sleep(900);
  check('退后台等待搜索结果时预订仍留在队列', await evaluate('window.mochiMusicQueuedTracks().some(x=>x.id===window.__pendingReservationId)'));
  await evaluate('window.__testHidden=false;window.mochiMusicPlayNextQueued();');
  check('回前台后可继续消费预订', await waitFor('window.__musicPlaying && document.getElementById("sm-pb-name")?.textContent==="预订在线曲"', 7000));
  await waitFor('window.mochiNeteaseIsPlaying() && window.mochiNeteaseSharedActive()', 7000);
  await evaluate('delete document.hidden;');
  async function bookAndPlay() {
    await evaluate('window.__remoteCalls=[];window.__random=Math.random;Math.random=()=>0.999;window.maybeMusicRequest();Math.random=window.__random;');
    if (!await waitFor('window.mochiMusicQueuedTracks().some(x=>x.title==="预订在线曲")')) throw new Error('预订未加入队列');
    await evaluate('window.mochiMusicPlayNextQueued();');
    if (!await waitFor('!!window.__musicPlaying && window.__remoteCalls.includes("pause") && document.getElementById("sm-pb-name")?.textContent==="预订在线曲"')) throw new Error('预订曲未播放');
  }
  await bookAndPlay();
  check('预订曲先于网易云播放', await evaluate('!window.mochiNeteaseSharedActive()'));
  check('预订曲播完优先恢复网易云', await waitFor('window.__remoteCalls.includes("play") && window.mochiNeteaseIsPlaying()', 7000));
  check('网易云恢复成功时不播放默认下一首', await evaluate('document.getElementById("sm-pb-name")?.textContent !== "默认下一首"'));
  await evaluate('window.__remotePlayFails=true;window.mochiNeteaseUpdate(window.__remoteFixture);');
  await bookAndPlay();
  check('网易云未能播放时接默认下一首', await waitFor('window.__remoteCalls.includes("play") && document.getElementById("sm-pb-name")?.textContent==="默认下一首" && !!window.__musicPlaying', 15000));
  await evaluate('window.__remotePlayFails=false;window.mochiNeteaseUpdate(window.__remoteFixture);');
  await bookAndPlay();
  await sleep(350);
  await evaluate('window.mochiNeteaseUpdate({...window.__remoteFixture,active:false,playing:false});');
  check('网易云会话消失时接默认下一首', await waitFor('document.getElementById("sm-pb-name")?.textContent==="默认下一首" && !!window.__musicPlaying', 7000));
  async function inviteNamed(online = false) {
    await evaluate(`window.mochiMusicStopForRemote();window.__remoteCalls=[];window.__remoteFixture={...window.__remoteFixture,active:true,playing:false};window.mochiNeteaseUpdate(window.__remoteFixture);Object.assign(window.mochiMusicGetSettings(),{reqProb:100,plainInviteProb:0,keywordProb:0,taReserveProb:0,cooldownMs:0});window.__random=Math.random;Math.random=()=>${online ? '0.999' : '0.001'};window.maybeMusicRequest();Math.random=window.__random;`);
    if (!await waitFor(`!!document.getElementById('sm-req-yes') && document.getElementById('tc-body')?.textContent.includes('${online ? '预订测试曲' : '邀请本地曲'}')`)) throw new Error('指定歌曲邀请未出现');
    await evaluate('window.__remoteFixture={...window.__remoteFixture,playing:true};window.mochiNeteaseUpdate(window.__remoteFixture);document.getElementById("sm-req-yes").click();');
    if (!await waitFor(`window.__remoteCalls.includes('pause') && !!window.__musicPlaying && document.getElementById('sm-pb-name')?.textContent==='${online ? '预订在线曲' : '邀请本地曲'}'`)) throw new Error('邀请歌曲未播放');
  }
  await inviteNamed();
  check('已有歌曲邀请播完返回网易云并确认播放', await waitFor('window.__remoteCalls.includes("play") && window.mochiNeteaseIsPlaying() && window.mochiNeteaseSharedActive()', 7000));
  check('已有歌曲邀请恢复网易云时不接默认歌', await evaluate('document.getElementById("sm-pb-name")?.textContent !== "默认下一首"'));
  await evaluate('window.__remotePlayFails=true;');
  await inviteNamed();
  check('已有歌曲邀请恢复失败后接默认歌', await waitFor('window.__remoteCalls.includes("play") && document.getElementById("sm-pb-name")?.textContent==="默认下一首" && !!window.__musicPlaying', 15000));
  await evaluate('window.__remotePlayFails=false;');
  await inviteNamed(true);
  check('在线指定歌曲邀请播完返回网易云', await waitFor('window.__remoteCalls.includes("play") && window.mochiNeteaseIsPlaying() && window.mochiNeteaseSharedActive()', 7000));
  const styleWav = wav(2);
  await evaluate(`window.__styleUrlIds=[];window.__stylePlayed=[];window.__remoteCalls=[];window.CiCiMusicApi={request:(token,type,value)=>{let data;if(type==='style')data={code:200,data:{songs:Array.from({length:8},(_,i)=>({id:9201+i,name:'歌单曲'+(i+1),artists:'歌手',duration:i===3?120000:2000,fee:0}))}};else if(type==='lyric')data={code:200,data:{lrc:''}};else {window.__styleUrlIds.push(Number(value));data={code:200,data:[0,2,5,6,7].includes(Number(value)-9201)?[]:[Number(value)===9204?{url:${JSON.stringify(styleWav)},freeTrialInfo:{}}:{url:${JSON.stringify(styleWav)}}]}}setTimeout(()=>window.ciciOnlineMusicResponse(token,JSON.stringify(data)),0)}};window.__styleCapture=setInterval(()=>{const name=document.getElementById('sm-pb-name')?.textContent||'';if(window.__musicPlaying&&name.startsWith('歌单曲')&&!window.__stylePlayed.includes(name))window.__stylePlayed.push(name)},50);Object.assign(window.mochiMusicGetSettings(),{reqProb:0,taReserveProb:100,keywordProb:100,cooldownMs:0});window.mochiNeteaseUpdate(window.__remoteFixture);window.__random=Math.random;Math.random=()=>0.999;window.maybeMusicRequest();Math.random=window.__random;`);
  check('关键词预订从当前搜索歌单中取曲', await waitFor('window.mochiMusicQueuedTracks().some(x=>x.title==="歌单曲2")'));
  await evaluate('window.mochiMusicPlayNextQueued();');
  check('可播放歌曲之间允许两首失败或试听', await waitFor('window.__stylePlayed.includes("歌单曲2") && window.__stylePlayed.includes("歌单曲5")', 15000));
  check('连续三首失败后才恢复网易云', await waitFor('window.__styleUrlIds.includes(9208) && window.__remoteCalls.includes("play") && window.mochiNeteaseIsPlaying()', 15000));
  const styleSequence = await evaluate('({played:window.__stylePlayed,urls:window.__styleUrlIds})');
  check('关键词歌单内持续播放而非首曲结束就返回', styleSequence.played.join(',') === '歌单曲2,歌单曲5' && styleSequence.urls.filter(Number.isFinite).join(',') === '9201,9202,9203,9204,9205,9206,9207,9208');
  await evaluate(`window.__styleUrlIds=[];window.__stylePlayed=[];window.__remoteCalls=[];window.__remoteFixture={...window.__remoteFixture,playing:false};window.mochiNeteaseUpdate(window.__remoteFixture);Object.assign(window.mochiMusicGetSettings(),{reqProb:100,plainInviteProb:0,keywordProb:100,cooldownMs:0});window.__random=Math.random;Math.random=()=>0.999;window.maybeMusicRequest();Math.random=window.__random;`);
  check('TA 关键词听歌邀请可接受', await waitFor('!!document.getElementById("sm-req-yes") && document.getElementById("tc-body")?.textContent.includes("治愈")'));
  await evaluate('document.getElementById("sm-req-yes")?.click();');
  check('接受邀请后也在同一搜索歌单内连续播放', await waitFor('window.__stylePlayed.includes("歌单曲2") && window.__stylePlayed.includes("歌单曲5")', 15000));
  check('关键词邀请连续三首失败后返回网易云', await waitFor('window.__styleUrlIds.includes(9208) && window.__remoteCalls.includes("play") && window.mochiNeteaseIsPlaying()', 15000));
  await evaluate('clearInterval(window.__styleCapture);');
} finally {
  try { ws?.close(); } catch {}
  chrome.kill(); server.close();
}
console.log('结果：' + results.filter(Boolean).length + '/' + results.length);
if (results.some(ok => !ok)) process.exitCode = 1;
