(function () { try {
(function () {
const MUSIC_PREFIX = 'xy-home-v2:default';
const store = window.storeFor('default');
function toast(msg) {
let t = document.getElementById('cc-toast');
if (!t) { t = document.createElement('div'); t.id = 'cc-toast'; document.body.appendChild(t); }
t.textContent = msg;
t.className = 'cc-toast'; void t.offsetWidth; t.className = 'cc-toast show';
t.style.opacity = '';
clearTimeout(t._timer);
t._timer = setTimeout(() => { t.className = 'cc-toast'; }, 2000);
}
function playbackPrompt(message) {
if (typeof window.toast === 'function') window.toast(message);
else toast(message);
}
window.mochiMusicPlaybackPrompt = playbackPrompt;
let library = [];          // {id,name,artist,url,source,duration,playlistId,addedAt}
const sessionTracks = new Map();
const transientNeteasePlaylist = id => ['cici_netease_remote', 'cici_netease_daily', 'cici_netease_heart'].includes(id);
let playlists = [];        // {id,name,createdAt}
let history = [];          // {id,trackId,trackName,triggerType,ts} —— TA 邀请听歌记录
let myHistory = [];        // {id,trackId,trackName,ts} —— 我的听歌记录（自己点击播放）
let hisSubTab = 'ta';      // 听歌记录二级子 tab：ta（TA 邀请）/ mine（我的）；默认 ta 与原 tab 语义一致
const DEF_SETTINGS = { floatEn: true, reqProb: 5, plainInviteProb: 70, keywordProb: 50, inviteWaitMs: 300000, onlineApiUrl: '', cooldownMs: 600000, widgetCoverMode: 'song', togetherProb: 50, togetherLeaveProb: 20, taNextProb: 15, taRandProb: 10, taModeProb: 5, taFavProb: 20, taLyricFavProb: 20, taReserveProb: 6, taPauseProb: 3, taPauseEn: true, neteaseAutoEn: false };
let settings = Object.assign({}, DEF_SETTINGS);
function probOf(v, def) { const n = (typeof v === 'number' && !isNaN(v)) ? v : def; return Math.max(0, Math.min(100, n)); }
let currentId = null;
let mode = 'list';         // list / shuffle / single
let audio = null;
let progressTimer = null;
let floatClosed = false;   // 悬浮小框手动收起
let floatMin = false;      // 悬浮小框是否处于最小（最初版最小单行小框）状态
let floatHideByWidget = false; // 桌面小组件触发播放时抑制悬浮小框自动唤出（小组件本身就是控制器，避免重复弹出）
let taActive = false;      // CiCi 已开始听歌后置 true，歌曲结束 TA 可能按设置接动作
let cooldownAt = 0;        // TA 音乐请求冷却时间戳
let reqData = null;        // 待确认的 TA 请求 {trackId}
let curTab = 'lib';
let playQueue = [];        // 播放队列：用户点「下一首播放」加入的歌曲 id 列表，播完当前手动/自动切歌时优先按序播放
let recommendationSession = null; // 网易云每日推荐/心动模式由 CiCi 播放；插播后回到此列表
let accountPlaySerial = 0;
let accountFailureSerial = -1;
let accountPlaybackSource = '';
let accountRecoveryAttempted = false;
let accountRecoveryAt = 0;
let accountStreamStale = false;
let accountResumeSeek = null;
let accountLastPosition = null;
window.mochiMusicAdoptNeteaseQueue = function (snapshot) {
const api = window.ciciNeteaseEnhanced;
if (!api || !api.loggedIn() || !snapshot || !Array.isArray(snapshot.queue)) return false;
const rows = snapshot.queue.filter(item => item && String(item.title || '').trim());
if (rows.length < (snapshot.allowSingle ? 1 : 2)) return false;
let currentIndex = rows.findIndex(item => String(item.id || '') === String(snapshot.activeQueueId || ''));
if (currentIndex < 0 && snapshot.mediaId)
currentIndex = rows.findIndex(item => String(item.mediaId || '') === String(snapshot.mediaId));
if (currentIndex < 0)
currentIndex = rows.findIndex(item => String(item.title || '') === String(snapshot.title || '') &&
String(item.artist || '') === String(snapshot.artist || ''));
if (currentIndex < 0 || (currentIndex >= rows.length - 1 && !snapshot.allowSingle)) return false;
const upcoming = rows.slice(currentIndex);
const pid = 'cici_netease_remote';
const oldIds = new Set(sessionTracks.keys());
sessionTracks.clear();
const batch = Date.now().toString(36);
const ids = upcoming.map((item, index) => {
const mediaId = String(item.mediaId || '');
const track = {
id: 'cici_remote_' + batch + '_' + index, playlistId: pid,
remoteQueueId: String(item.id || ''),
neteaseId: /^\d+$/.test(mediaId) ? mediaId : '',
name: String(item.title), artist: String(item.artist || ''),
cover: String(item.cover || (index === 0 ? snapshot.cover || '' : '')),
duration: index === 0 ? Number(snapshot.duration || 0) / 1000 : 0,
url: '', source: 'netease-account', neteaseAccount: true,
addedAt: Date.now()
};
sessionTracks.set(track.id, track);
return track.id;
});
playQueue = playQueue.filter(id => !oldIds.has(id));
recommendationSession = { mode: 'remote', pid, ids, index: 0, failures: 0 };
renderPage();
return true;
};
window.mochiMusicRefreshAdoptedQueue = function (snapshot) {
const session = recommendationSession;
if (!session || session.mode !== 'remote' || !snapshot || !Array.isArray(snapshot.queue)) return false;
const rows = snapshot.queue.filter(item => item && String(item.title || '').trim());
if (rows.length < 2) return false;
const activeIndex = rows.findIndex(item => String(item.id || '') === String(snapshot.activeQueueId || ''));
if (activeIndex < 0) return false;
const currentIndex = Math.max(0, session.ids.indexOf(currentId), session.index);
const played = session.ids.slice(0, currentIndex + 1);
const inserted = session.ids.slice(currentIndex + 1).filter(id => {
const track = findTrack(id);
return track && track.playlistId !== session.pid;
});
let changed = false;
const fresh = [];
for (const row of rows.slice(activeIndex + 1)) {
const queueId = String(row.id || '');
if (!queueId || queueId === '-1') continue;
let track = [...sessionTracks.values()].find(item => item.playlistId === session.pid && item.remoteQueueId === queueId);
if (!track) {
const mediaId = String(row.mediaId || '');
track = { id: 'cici_remote_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
playlistId: session.pid, remoteQueueId: queueId,
neteaseId: /^\d+$/.test(mediaId) ? mediaId : '', name: String(row.title),
artist: String(row.artist || ''), cover: String(row.cover || ''), duration: 0, url: '',
source: 'netease-account', neteaseAccount: true, addedAt: Date.now() };
sessionTracks.set(track.id, track);
changed = true;
}
if (track.name !== String(row.title) || track.artist !== String(row.artist || '')) {
track.name = String(row.title); track.artist = String(row.artist || ''); changed = true;
}
if (row.cover && track.cover !== String(row.cover)) { track.cover = String(row.cover); changed = true; }
fresh.push(track.id);
}
if (!fresh.length) return false;
const nextIds = [...new Set([...played, ...inserted, ...fresh])];
if (nextIds.join('\u001f') !== session.ids.join('\u001f')) {
session.ids = nextIds;
session.index = Math.max(0, session.ids.indexOf(currentId));
changed = true;
}
if (changed) renderPage();
return changed;
};
window.mochiMusicPlayRemoteQueueItem = function (snapshot, queueId) {
const api = window.ciciNeteaseEnhanced;
if (!api || !api.loggedIn() || !snapshot || !Array.isArray(snapshot.queue)) return false;
const target = snapshot.queue.find(item => item && String(item.id || '') === String(queueId || ''));
if (!target || !String(target.title || '').trim()) return false;
const selected = Object.assign({}, snapshot, {
activeQueueId: String(queueId), title: String(target.title), artist: String(target.artist || ''),
duration: String(snapshot.activeQueueId || '') === String(queueId) ? snapshot.duration : 0,
cover: String(target.cover || ''), allowSingle: true
});
if (!window.mochiMusicAdoptNeteaseQueue(selected)) return false;
const first = recommendationSession && recommendationSession.ids[0];
if (!first) return false;
playTrack(first);
return true;
};
const onlineReservations = new Map(); // 列表外歌曲的待播占位；搜索成功后替换为默认歌单歌曲
const taReservedIds = new Set();
let currentTaReservationId = null;
let inviteReturnTrackId = null; // 本地邀请曲终后，优先恢复网易云
let expectedPlayback = null;
let failedPlaybackId = null;
let temporaryOnlineId = null;
let temporaryOnlineCreatedId = null;
let temporaryOnlinePrompt = '';
let temporaryOnlineBackup = null;
let onlineAttempt = null;
let inviteFlow = null;
let officialInvitePending = null; // 加入网易云账号歌单后，等待用户手动播放这首歌
let myInviteListening = false;
let myInviteAwaitingUntil = 0;
let inviteResumeGuardUntil = 0;
function clearExpectedPlayback() {
if (expectedPlayback) clearTimeout(expectedPlayback.timer);
expectedPlayback = null;
}
function failExpectedPlayback(id) {
if (!expectedPlayback || expectedPlayback.id !== id) return;
const failed = expectedPlayback;
clearExpectedPlayback();
failedPlaybackId = id;
if (inviteFlow && inviteFlow.localTrackId === id) {
const flow = inviteFlow;
if (typeof failed.onFailure === 'function') { failed.onFailure(); return; }
if (inviteFlow === flow) {
flow.waiting = false;
flow.localTrackId = null;
if (!startNextMusicInviteLocal(flow)) runMusicInviteStep(flow);
}
return;
}
if (typeof failed.onFailure === 'function') failed.onFailure();
else playbackPrompt(failed.message);
}
function expectPlayback(id, message, onFailure, timeoutMs = 30000) {
clearExpectedPlayback();
failedPlaybackId = null;
const pending = { id, message, onFailure, timer: null };
pending.timer = setTimeout(() => {
if (expectedPlayback === pending && currentId === id) failExpectedPlayback(id);
}, timeoutMs);
expectedPlayback = pending;
}
let localPlId = 'default'; // 本地上传的目标播放列表（歌单），单选歌曲时由弹窗决定
let failMap = {};          // 连续播放失败计数（songId→次数），每次成功播放清零；用于区分临时/网络失败与真坏链
const localBlobCache = {};
function loadArr(k) { try { const v = JSON.parse(store.get(k) || 'null'); return Array.isArray(v) ? v : []; } catch(e){ return []; } }
function saveArr(k, a) { store.set(k, JSON.stringify(a)); }
function partnerName() {
if (window.chatPartnerName) return window.chatPartnerName();
return window.activeStore().get('lbl-partner') || 'TA';
}
function findTrack(id) { return sessionTracks.get(id) || library.find(m => m.id === id) || null; }
function fmtDur(sec) {
if (isNaN(sec) || sec < 0) return '00:00';
const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
}
function fmtDT(ts) {
const d = new Date(ts);
const p = (n) => (n < 10 ? '0' + n : '' + n);
return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function songIcoHtml(m, icon) {
if (m && m.cover) {
return '<span class="sm-song-ico has-cov" style="background-image:url(\'' + esc(m.cover) + '\')"></span>';
}
return '<span class="sm-song-ico"><svg viewBox="0 0 24 24" fill="currentColor">' + (icon || '<path d="M8 5.5v13l11-6.5z"/>') + '</svg></span>';
}
function compressCover(file, cb) {
if (!window.mochiImgIngest) { cb(''); return; }
window.mochiImgIngest(file, { maxSide: 512, quality: 0.82, mime: 'image/jpeg', opaque: true, tag: 'pl-cover' }).then((r) => {
cb(r && r.st === 'ok' && r.data ? r.data : '');
});
}
function saveLibrary() { saveArr('music-library', library.filter(m => m && !transientNeteasePlaylist(m.playlistId))); }
let _saveLibTimer = null;
function saveLibrarySoon() {
if (_saveLibTimer) return;
_saveLibTimer = setTimeout(function () { _saveLibTimer = null; saveLibrary(); }, 1500);
}
function savePlaylists() { saveArr('music-playlists', playlists); }
function saveHistory() { saveArr('music-history', history); }
function saveMyHistory() { saveArr('music-my-history', myHistory); }
function saveSettings() {
store.set('music-global', JSON.stringify(settings));
document.dispatchEvent(new Event('mochi-music-settings-changed'));
}
window.mochiMusicGetSettings = function () { return settings; };
window.mochiMusicLocalLyricSnapshot = function () {
const track = findTrack(currentId);
return track && audio && !audio.paused && !audio.ended ? {
key: String(track.id), title: track.name || '', artist: track.artist || '',
mediaId: track.neteaseId || '', lrc: track.lrc || '', position: Math.round(audio.currentTime * 1000)
} : null;
};
function loadAll() {
library = loadArr('music-library');
playlists = loadArr('music-playlists');
history = loadArr('music-history');
myHistory = loadArr('music-my-history');
{
let migrated = false;
const mine = [];
history = history.filter(h => {
if (h && !h.mode && !h.rejected && !h.triggerType) {
mine.push(h); migrated = true; return false;
}
return true;
});
if (mine.length) {
const existIds = new Set(myHistory.map(h => h && h.id));
mine.forEach(h => { if (!existIds.has(h.id)) { myHistory.push(h); existIds.add(h.id); } });
if (myHistory.length > 500) myHistory = myHistory.slice(-500);
}
if (migrated) { saveHistory(); saveMyHistory(); }
}
try { settings = Object.assign({}, DEF_SETTINGS, JSON.parse(store.get('music-global') || '{}')); } catch(e) {}
settings.reqProb = Math.max(1, Math.round(probOf(settings.reqProb, 5)));
library.forEach(m => { if (!m.source) m.source = m.url ? 'url' : 'local'; });
if (!playlists.length && !store.get('music-default-done')) {
playlists.push({ id: 'spl_default', name: '默认歌单', createdAt: Date.now() });
store.set('music-default-done', '1');
}
if (!playlists.some(p => p.id === 'spl_default')) {
playlists.unshift({ id: 'spl_default', name: '默认歌单', createdAt: Date.now() });
}
library.forEach(m => {
if (!m || !m.neteaseId) return;
const seedId = String(m.neteaseId);
const isSeed = (seedId === '2613048732' || seedId === '27538343');
const target = neteaseMetingUrl(seedId);
const hasOldOuterUrl = m.url && /music\.163\.com\/song\/media\/outer\/url/i.test(m.url);
if (hasOldOuterUrl || (isSeed && (m.url !== target || m.source !== 'url'))) {
m.url = target;
m.source = 'url';
saveLibrary();
if (isSeed) { try { if (window.idbDelete) window.idbDelete(MUSIC_PREFIX + ':music-file:' + m.id); } catch (e) {} }
}
});
{
let httpsUpgraded = false;
library.forEach(m => {
if (!m || m.neteaseId || m.source !== 'url' || !m.url) return;
if (/^http:\/\//i.test(m.url)) { m.url = m.url.replace(/^http:\/\//i, 'https://'); httpsUpgraded = true; }
});
if (httpsUpgraded) saveLibrary();
}
{
const before = library.length;
library = library.filter(m => !(m && m.id && m.id.indexOf('sm_seed_') === 0));
if (library.length !== before) {
saveLibrary();
try {
if (window.idbGetAllKeys) {
window.idbGetAllKeys().then(keys => {
keys.filter(k => k.indexOf(MUSIC_PREFIX + ':music-file:sm_seed_') === 0)
.forEach(k => { if (window.idbDelete) window.idbDelete(k); });
});
}
} catch (e) {}
}
}
mergeDesksMusic();
const oldLibrarySize = library.length;
const oldPlaylistSize = playlists.length;
library = library.filter(m => m && !transientNeteasePlaylist(m.playlistId));
playlists = playlists.filter(p => p && !transientNeteasePlaylist(p.id));
if (library.length !== oldLibrarySize) saveLibrary();
if (playlists.length !== oldPlaylistSize) savePlaylists();
}
function loadArrFrom(s, k) { try { const v = JSON.parse(s.get(k) || 'null'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
function mergeDesksMusic() {
let contacts = [];
try { contacts = window.getContacts() || []; } catch (e) {}
const otherCids = contacts.map(c => c.id).filter(id => id && id !== 'default');
if (store.get('music-merge-done')) return;
if (!otherCids.length) { store.set('music-merge-done', '1'); return; }
const libIds = new Set(library.map(m => m && m.id));
const plIds = new Set(playlists.map(p => p && p.id));
const histIds = new Set(history.map(h => h && h.id));
const myHistIds = new Set(myHistory.map(h => h && h.id));
let changed = false;
let myChanged = false;
otherCids.forEach(cid => {
let s; try { s = window.storeFor(cid); } catch (e) { return; }
loadArrFrom(s, 'music-library').forEach(m => {
if (!m || !m.id || libIds.has(m.id)) return;
library.push(m); libIds.add(m.id); changed = true;
});
loadArrFrom(s, 'music-playlists').forEach(p => {
if (!p || !p.id || plIds.has(p.id)) return;
playlists.push(p); plIds.add(p.id); changed = true;
});
loadArrFrom(s, 'music-history').forEach(h => {
if (!h || !h.id || histIds.has(h.id)) return;
history.push(h); histIds.add(h.id); changed = true;
});
loadArrFrom(s, 'music-my-history').forEach(h => {
if (!h || !h.id || myHistIds.has(h.id)) return;
myHistory.push(h); myHistIds.add(h.id); myChanged = true;
});
});
if (changed) { saveLibrary(); savePlaylists(); saveHistory(); }
if (myChanged) { saveMyHistory(); }
otherCids.forEach(cid => {
let s; try { s = window.storeFor(cid); } catch (e) { return; }
if (!s || typeof s.remove !== 'function') return;
try { s.remove('music-library'); } catch (e) {}
try { s.remove('music-playlists'); } catch (e) {}
try { s.remove('music-history'); } catch (e) {}
try { s.remove('music-my-history'); } catch (e) {}
});
store.set('music-merge-done', '1');
if (window.idbGet && window.idbSet && window.idbGetAllKeys) {
const localIds = library.filter(m => m && (m.source === 'local' || (!m.url && m.source !== 'url'))).map(m => m.id);
if (!localIds.length) return;
window.idbGetAllKeys().then(keys => {
const have = new Set(keys || []);
otherCids.forEach(cid => {
const srcPrefix = 'xy-home-v2:' + cid + ':music-file:';
localIds.forEach(id => {
const srcKey = srcPrefix + id;
const dstKey = MUSIC_PREFIX + ':music-file:' + id;
if (have.has(srcKey) && !have.has(dstKey)) {
window.idbGet(srcKey).then(v => {
if (v !== undefined && v !== null) window.idbSet(dstKey, v).catch(() => {});
}).catch(() => {});
}
});
});
}).catch(() => {});
}
}
const DEMO_NOTES = [
[523,523,587,587,659,659,587,523,523,587,587,659,659,587,659,698,784,784,698,698,659,659,587],
[659,659,698,784,784,698,659,587,523,523,587,659,659,587,587,659,784,784,880,880,784,659,587]
];
function genDemoWavJS(idx) {
try {
const sr = 8000, dur = 0.42;
const notes = DEMO_NOTES[idx === 0 ? 0 : 1] || DEMO_NOTES[0];
const total = sr * 14;
const pcm = new Int16Array(total);
let t = 0;
notes.forEach((f) => {
const nStart = Math.floor(t * sr);
const nEnd = Math.min(Math.floor((t + dur) * sr), total);
for (let i = nStart; i < nEnd; i++) {
const tt = (i / sr) - t;
const env = Math.min(1, tt / 0.02) * Math.pow(0.001, Math.max(0, tt - 0.02) / (dur - 0.02));
pcm[i] = Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * f * tt) * env * 0.5)) * 32767;
}
t += dur * 0.9;
});
const n = total;
const wav = new DataView(new ArrayBuffer(44 + n * 2));
const ws = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
ws(0, 'RIFF'); wav.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
ws(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
wav.setUint32(24, sr, true); wav.setUint32(28, sr * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
ws(36, 'data'); wav.setUint32(40, n * 2, true);
for (let i = 0; i < n; i++) wav.setInt16(44 + i * 2, pcm[i], true);
const bytes = new Uint8Array(wav.buffer);
let bin = '';
for (let i = 0; i < bytes.length; i += 8192) {
bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
}
return 'data:audio/wav;base64,' + btoa(bin);
} catch (e) { return ''; }
}
function genDemoAudio(idx) {
return new Promise((resolve) => {
const fallback = () => { try { resolve(genDemoWavJS(idx) || ''); } catch (e) { resolve(''); } };
try {
const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
if (!AC) { fallback(); return; }
const sr = 22050;
const ctx = new AC(1, sr * 14, sr);
const notes = DEMO_NOTES[idx === 0 ? 0 : 1] || DEMO_NOTES[0];
let t = ctx.currentTime;
const dur = 0.42;
notes.forEach((f) => {
const osc = ctx.createOscillator();
const g = ctx.createGain();
osc.type = 'sine';
osc.frequency.value = f;
g.gain.setValueAtTime(0, t);
g.gain.linearRampToValueAtTime(0.5, t + 0.02);
g.gain.exponentialRampToValueAtTime(0.001, t + dur);
osc.connect(g);
g.connect(ctx.destination);
osc.start(t);
osc.stop(t + dur + 0.05);
t += dur * 0.9;
});
let cbDone = false;
const finishRender = (buf) => {
if (cbDone) return; cbDone = true;
try {
const ch = buf.getChannelData(0);
const n = ch.length;
const wav = new DataView(new ArrayBuffer(44 + n * 2));
const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
writeStr(0, 'RIFF'); wav.setUint32(4, 36 + n * 2, true); writeStr(8, 'WAVE');
writeStr(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
wav.setUint32(24, sr, true); wav.setUint32(28, sr * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
writeStr(36, 'data'); wav.setUint32(40, n * 2, true);
for (let i = 0; i < n; i++) wav.setInt16(44 + i * 2, Math.max(-1, Math.min(1, ch[i])) * 32767, true);
const bytes = new Uint8Array(wav.buffer);
let bin = '';
for (let i = 0; i < bytes.length; i += 8192) {
bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
}
resolve('data:audio/wav;base64,' + btoa(bin));
} catch (e) { fallback(); }
};
try {
const hasPromise = typeof ctx.startRendering === 'function' && ctx.startRendering.length === 0 && 'Promise' in window;
if (hasPromise) {
const rp = ctx.startRendering();
if (rp && typeof rp.then === 'function') rp.then(finishRender).catch(fallback);
else { ctx.oncomplete = (ev) => { try { finishRender(ev.renderedBuffer); } catch (e) { fallback(); } }; }
} else {
ctx.oncomplete = (ev) => { try { finishRender(ev.renderedBuffer); } catch (e) { fallback(); } };
ctx.startRendering();
}
} catch (e) { fallback(); }
} catch (e) { fallback(); }
});
}
const KNOWN_NETEASE = {
'27538343': { name: 'Baby', artist: 'EXO-K' },
'2613048732': { name: 'Moonlit Dream', artist: 'DLSS / shell' }
};
function parseNeteasePageTitle(html) {
if (!html || typeof html !== 'string') return null;
let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
if (!m) return null;
let title = m[1].trim().replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
let duration = 0;
const dm = html.match(/property=["']music:duration["'][^>]*content=["'](\d+)["']/i) || html.match(/content=["'](\d+)["'][^>]*property=["']music:duration["']/i);
if (dm) duration = parseInt(dm[1], 10) || 0;
title = title.replace(/\s*[-－]\s*单曲\s*[-－]\s*网易云音乐\s*$/i, '');
title = title.replace(/\s*[-－]\s*网易云音乐\s*$/i, '');
const parts = title.split(/\s*[-－]\s*/);
if (parts.length >= 2) {
return { name: parts[0].trim(), artist: parts.slice(1).join(' - ').trim(), pic: '', duration: duration };
}
if (parts.length === 1 && parts[0]) {
return { name: parts[0].trim(), artist: '', pic: '', duration: duration };
}
return null;
}
function fetchNeteaseInfo(id, cb) {
const known = KNOWN_NETEASE[String(id)];
if (known) { cb({ name: known.name, artist: known.artist, pic: '' }); return; }
const songPageUrl = 'https://music.163.com/song?id=' + id;
const apis = [
{ url: 'https://api.injahow.cn/meting/?server=netease&type=song&id=' + encodeURIComponent(String(id)), isText: true, parse(t) {
let d; try { d = JSON.parse(t); } catch (e) { return null; }
const s = d && d[0];
return s && s.name ? { name: s.name, artist: s.artist || '', pic: s.pic || '' } : null; } },
{ url: 'https://proxy.cors.sh/' + songPageUrl, isText: true, parse(t) {
return parseNeteasePageTitle(t); } },
{ url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(songPageUrl), isText: true, parse(t) {
return parseNeteasePageTitle(t); } },
{ url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://music.163.com/api/song/detail/?ids=' + id), isText: true, parse(t) {
let d; try { d = typeof t === 'string' ? JSON.parse(t) : t; } catch(e) { return null; }
if (d && d.songs && d.songs[0]) {
const s = d.songs[0];
const artist = (s.artists || []).map(a => a.name).join('/');
return { name: s.name, artist: artist, pic: (s.album && s.album.picUrl) || '', duration: s.dt ? Math.round(s.dt / 1000) : 0 };
}
return null; } }
];
let idx = 0;
function tryNext() {
if (idx >= apis.length) { cb(null); return; }
const api = apis[idx++];
let controller;
try { controller = new AbortController(); } catch(e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch(e){} }, 8000);
fetch(api.url, controller ? { signal: controller.signal } : undefined)
.then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return api.isText ? r.text() : r.json(); })
.then(data => {
clearTimeout(timer);
try {
const res = api.parse(data);
if (res && res.name) cb(res); else tryNext();
} catch (e) { tryNext(); }
})
.catch(() => { clearTimeout(timer); tryNext(); });
}
tryNext();
}
function mochiSafeCancelBody(r) {
try {
var p = r && r.body && r.body.cancel && r.body.cancel();
if (p && typeof p.catch === 'function') p.catch(function () {});
} catch (e) {}
}
function normNeteaseCoverUrl(u) {
var s = String(u || '');
if (!/^https?:\/\/([^/]+\.)?music\.126\.net\//i.test(s)) return s;
return s.replace(/^http:\/\//i, 'https://').replace(/\?.*$/, '') + '?param=300y300';
}
function resolveCoverDirect(url, cb) {
var controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
var timer = setTimeout(function () { try { controller && controller.abort(); } catch (e) {} }, 8000);
fetch(url, controller ? { signal: controller.signal } : undefined)
.then(function (r) {
clearTimeout(timer);
var finalUrl = (r.ok || r.redirected) ? (r.url || '') : '';
setTimeout(function () {
try { controller && controller.abort(); } catch (e) {}
mochiSafeCancelBody(r); // #284：cancel() 拒绝安全（见函数头注释）
cb(finalUrl ? normNeteaseCoverUrl(finalUrl) : String(url));
}, 0);
})
.catch(function () { clearTimeout(timer); cb(String(url)); });
}
function fetchNeteaseCover(id, cb) {
let controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch (e) {} }, 8000);
fetch('https://api.injahow.cn/meting/?type=song&id=' + encodeURIComponent(String(id)), controller ? { signal: controller.signal } : undefined)
.then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
.then(txt => {
clearTimeout(timer);
try {
const j = JSON.parse(txt);
const pic = (j && j[0] && j[0].pic) || '';
if (pic) { resolveCoverDirect(String(pic), cb); return; }
} catch (e) {}
cb(null);
})
.catch(() => { clearTimeout(timer); fetchNeteaseCoverFallback(id, cb); });
}
function fetchNeteaseCoverFallback(id, cb) {
fetchNeteaseInfo(id, function (info) {
cb(info && info.pic ? normNeteaseCoverUrl(info.pic) : null);
});
}
function extractPlaylistId(line) {
if (!line || typeof line !== 'string') return '';
if (/\.mp3/i.test(line)) return '';
const m = line.match(/playlist[\/?#&!\s]*(?:id=)?(\d+)/i);
return m ? m[1] : '';
}
function extractNeteaseSongId(line) {
if (!line || typeof line !== 'string') return '';
const s = String(line).trim();
if (/^\d+$/.test(s)) return s;
let m = s.match(/[?&]id=(\d+)/);
if (m) return m[1];
m = s.match(/\/(?:song|playlist)\/(\d+)/i);
if (m) return m[1];
m = s.match(/\/(\d{5,})(?:\.mp3)?(?:\?|#|$)/);
if (m) return m[1];
return '';
}
function isNetShortLink(line) {
if (!line || typeof line !== 'string') return false;
return /(?:^|[\s/])163cn\.tv\/[\w-]+/i.test(String(line).trim());
}
function resolveNetShortLink(ln, cb) {
if (typeof cb !== 'function') return;
const target = String(ln).trim().replace(/^http:\/\//i, 'https://');
let called = false;
const done = (id) => {
if (called) return;
called = true;
clearTimeout(hardTimer);
cb(id || '');
};
const prox = [
{ p: 'https://proxy.cors.sh/', enc: false },
{ p: 'https://api.allorigins.win/raw?url=', enc: true }
];
let pending = prox.length;
const hardTimer = setTimeout(done, 8000);
prox.forEach((pr) => {
let controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch (e) {} }, 7000);
fetch(pr.p + (pr.enc ? encodeURIComponent(target) : target), controller ? { signal: controller.signal } : undefined)
.then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
.then(txt => {
clearTimeout(timer);
let m = String(txt || '').match(/music\.163\.com[^"'<>]*?\/song[^"'<>]*?(?:id=)?(\d{5,})/i);
if (!m) m = String(txt || '').match(/(?:song[\/?#]+id=|song\/)[^"'<>]{0,40}?(\d{5,})/i);
if (m && m[1]) { done(m[1]); }
else if (--pending <= 0) { done(''); }
})
.catch(() => { clearTimeout(timer); if (--pending <= 0) { done(''); } });
});
}
function canonicalMetingPicUrl(pic) {
const s = String(pic || '');
if (!s) return '';
const idm = /[?&]type=pic\b/i.test(s) && s.match(/[?&]id=(\d+)/);
if (idm) return 'https://api.injahow.cn/meting/?server=netease&type=pic&id=' + idm[1];
return s.replace(/^http:\/\//i, 'https://');
}
function parseMetingPlaylist(txt) {
let j; try { j = JSON.parse(txt); } catch (e) { return null; }
if (!Array.isArray(j) || !j.length) return null;
const list = [];
j.forEach(t => {
if (!t) return;
const mid = String(t.url || '').match(/type=url&id=(\d+)/);
const url = mid ? neteaseMetingUrl(mid[1]) : (t.url || '');
if (!url) return;
list.push({
neteaseId: mid ? mid[1] : '',
name: t.name || t.title || '',
artist: t.artist || t.author || '',
cover: canonicalMetingPicUrl(t.pic),
url: url,
duration: 0
});
});
return list.length ? { list: list } : null;
}
function parseOfficialPlaylist(txt) {
let j; try { j = JSON.parse(txt); } catch (e) { return null; }
const pl = j && j.playlist;
if (!pl || !Array.isArray(pl.tracks) || !pl.tracks.length) return null;
const list = [];
pl.tracks.forEach(s => {
if (!s || !s.id) return;
list.push({
neteaseId: String(s.id),
name: s.name || '',
artist: ((s.ar || []).map(a => a.name).filter(Boolean).join('/')),
cover: String((s.al && s.al.picUrl) || '').replace(/^http:\/\//i, 'https://'),
url: neteaseMetingUrl(s.id),
duration: s.dt ? Math.round(s.dt / 1000) : 0,
fee: s.fee
});
});
return list.length ? { list: list, total: parseInt(pl.trackCount, 10) || 0 } : null;
}
var NETEASE_TRACKS_TRUNC = 10;
function fetchNeteasePlaylist(id, cb) {
const apiUrl = 'https://music.163.com/api/v6/playlist/detail?id=' + encodeURIComponent(String(id)) + '&n=1000&s=8';
const pid = encodeURIComponent(String(id));
const sources = [
{ url: 'https://api.qijieya.cn/meting/?server=netease&type=playlist&id=' + pid, parse: parseMetingPlaylist },
{ url: 'https://api.injahow.cn/meting/?type=playlist&id=' + pid, parse: parseMetingPlaylist },
{ url: 'https://proxy.cors.sh/' + apiUrl, parse: parseOfficialPlaylist },
{ url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(apiUrl), parse: parseOfficialPlaylist }
];
const results = [];
let pending = sources.length, knownTotal = 0, settled = false, graceTimer = 0, hardTimer = 0;
function bestList() {
let best = null;
results.forEach(r => {
if (!best || r.list.length > best.list.length ||
(r.list.length === best.list.length && r.pri < best.pri)) best = r;
});
return best && best.list;
}
function finish() {
if (settled) return;
settled = true;
clearTimeout(hardTimer); clearTimeout(graceTimer);
const best = bestList();
cb(best && best.length ? best : null, knownTotal);
}
hardTimer = setTimeout(finish, 8000);
sources.forEach((src, pri) => {
let controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch (e) {} }, 7000);
let called = false;
const done = () => { if (called) return; called = true; clearTimeout(timer); if (--pending <= 0) finish(); };
fetch(src.url, controller ? { signal: controller.signal } : undefined)
.then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
.then(txt => {
let res = null;
try { res = src.parse(txt); } catch (e) { res = null; }
if (res && res.list && res.list.length) {
res.pri = pri;
results.push(res);
if (res.total) knownTotal = Math.max(knownTotal, res.total);
const n = bestList().length;
if (knownTotal && n >= knownTotal) { done(); finish(); return; }
if (n !== NETEASE_TRACKS_TRUNC && !graceTimer) graceTimer = setTimeout(finish, 1500);
}
done();
})
.catch(() => { done(); });
});
}
function importNeteasePlaylist(id, done, targetPl) {
fetchNeteasePlaylist(id, function (tracks, totalKnown) {
if (!tracks || !tracks.length) { done({ ok: false }); return; }
let added = 0, skipped = 0, vip = 0;
const now = Date.now();
const addedIds = [];
const plId = targetPl || 'default';
tracks.forEach((t, i) => {
if (t.neteaseId && library.some(m => m.neteaseId === t.neteaseId)) { skipped++; return; }
if (t.fee === 1 || t.fee === 4) { vip++; return; } // VIP 专属/需购买专辑：网页外链播不了
const nid = 'sm_pl_' + now + '_' + i + '_' + Math.random().toString(36).substr(2, 4);
library.push({ id: nid, neteaseId: t.neteaseId, name: t.name || '网易云音乐-' + (t.neteaseId || i), artist: t.artist || '', cover: t.cover || '', url: t.url, source: 'url', duration: t.duration || 0, playlistId: plId, addedAt: now });
addedIds.push(nid);
added++;
});
const miss = Math.max(0, (totalKnown || 0) - tracks.length);
done({ ok: true, added: added, skipped: skipped, vip: vip, miss: miss });
if (addedIds.length) enrichImportedDurations(id, addedIds);
});
}
function removeBatchVipSongs(tracks) {
if (!tracks || !tracks.length) return;
const vipIds = tracks.map(m => m.id);
library = library.filter(x => vipIds.indexOf(x.id) < 0);
if (currentId && vipIds.indexOf(currentId) >= 0) { teardownAudio(); currentId = null; updatePlayerBar(); renderLibrary(); }
saveLibrary();
renderPage();
toast('已自动移除 ' + tracks.length + ' 首 VIP/付费歌曲（网页外链无法播放）');
}
function confirmVipViaMeting(id, cb) {
let controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch (e) {} }, 8000);
fetch(neteaseMetingUrl(id), controller ? { signal: controller.signal } : undefined)
.then(function (r) {
clearTimeout(timer);
var ct = '';
try { ct = (r.headers && r.headers.get('content-type')) || ''; } catch (e) {}
var free = !!(r.redirected || /^audio\//i.test(ct));
setTimeout(function () {
try { controller && controller.abort(); } catch (e) {}
mochiSafeCancelBody(r);
}, 0);
cb(!free);
})
.catch(function () { clearTimeout(timer); cb(false); });
}
function enrichImportedDurations(id, trackIds) {
const missing = trackIds.map(findTrack).filter(m => m && m.neteaseId && !m.duration);
if (!missing.length) return;
fetchV6Durations(id, function (durMap, feeMap) {
if (durMap && Object.keys(durMap).length) {
let any = false;
missing.forEach(m => { if (durMap[m.neteaseId] && !m.duration) { m.duration = durMap[m.neteaseId]; any = true; } });
if (any) { saveLibrary(); renderPage(); }
}
if (feeMap && Object.keys(feeMap).length) {
const vipTracks = trackIds.map(findTrack).filter(m => m && m.neteaseId && (feeMap[m.neteaseId] === 1 || feeMap[m.neteaseId] === 4));
removeBatchVipSongs(vipTracks); // #709：移除逻辑收敛到共享助手（meting 探测兜底同口径）
}
missing.forEach(m => { if (!m.duration) enqueueDurProbe(m); });
});
}
function fetchV6Durations(id, cb) {
const apiUrl = 'https://music.163.com/api/v6/playlist/detail?id=' + encodeURIComponent(String(id)) + '&n=1000&s=8';
const prox = [
{ p: 'https://proxy.cors.sh/', enc: false },
{ p: 'https://api.allorigins.win/raw?url=', enc: true }
];
const out = {};
const fees = {}; // v3.10.x：顺带收集 fee（1=VIP 4=购买专辑）供导入后移除本批 VIP
let settled = false;
const finish = () => { if (settled) return; settled = true; cb(out, fees); };
prox.forEach(pr => {
let controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch (e) {} }, 6000);
fetch(pr.p + (pr.enc ? encodeURIComponent(apiUrl) : apiUrl), controller ? { signal: controller.signal } : undefined)
.then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
.then(txt => {
clearTimeout(timer);
try {
const j = JSON.parse(txt);
const pl = j && j.playlist;
if (pl && Array.isArray(pl.tracks) && pl.tracks.length) {
pl.tracks.forEach(s => {
if (!s || !s.id) return;
if (s.dt) out[String(s.id)] = Math.round(s.dt / 1000);
fees[String(s.id)] = s.fee;
});
finish();
}
} catch (e) {}
})
.catch(() => { clearTimeout(timer); });
});
setTimeout(finish, 7000);
}
function fetchNeteaseFees(ids, cb) {
if (!ids || !ids.length) { cb({}, false); return; }
const out = {};
const queue = ids.slice();
let settled = false;
let active = 0;
let probed = 0; // 拿到判定（可播/不可播）的歌数；0=一首都没探到=检测失败
const finish = (ok) => { if (settled) return; settled = true; cb(out, ok); };
function probeOneFee(id, done) {
let controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch (e) {} }, 8000);
fetch(neteaseMetingUrl(id), controller ? { signal: controller.signal } : undefined)
.then(function (r) {
clearTimeout(timer);
var ct = '';
try { ct = (r.headers && r.headers.get('content-type')) || ''; } catch (e) {}
var playable = !!(r.redirected || /^audio\//i.test(ct));
done(playable ? 0 : 1); // 0=免费可播；1=不可播（会员/付费/失效）——响应头即同步记账
setTimeout(function () {
try { controller && controller.abort(); } catch (e) {}
mochiSafeCancelBody(r); // #284：cancel() 拒绝安全（见函数头注释）
}, 0);
})
.catch(function () { clearTimeout(timer); done(null); }); // null=没探到，绝不冒充免费
}
function probeNext() {
while (!settled && active < 8 && queue.length) {
const id = queue.shift();
active++;
probeOneFee(id, function (fee) {
active--;
if (typeof fee === 'number') { out[id] = fee; probed++; }
if (!queue.length && active === 0) finish(probed > 0);
else probeNext();
});
}
if (settled && active === 0) finish(probed > 0);
}
probeNext();
setTimeout(function () { finish(probed > 0); }, 30000);
}
let vipCleanBusy = false; // #254 逐首探测在大库上可持续数十秒，防连点叠加多轮请求
function openVipClean() {
if (vipCleanBusy) { toast('正在探测中，请稍候…'); return; }
const candidates = library.filter(m => m && m.neteaseId && m.source === 'url');
if (!candidates.length) { toast('音乐库里没有网易云链接歌曲'); return; }
const uniqueIds = [];
candidates.forEach(m => { if (uniqueIds.indexOf(m.neteaseId) < 0) uniqueIds.push(m.neteaseId); });
vipCleanBusy = true;
toast('正在探测 ' + uniqueIds.length + ' 首歌曲的播放可用性…');
fetchNeteaseFees(uniqueIds, (fees, ok) => {
vipCleanBusy = false;
if (!ok || !Object.keys(fees).length) { toast('检测失败：播放探测服务暂不可用，请稍后重试'); return; }
const vip = candidates.filter(m => fees[m.neteaseId] === 1 || fees[m.neteaseId] === 4);
if (!vip.length) { toast('未发现会员/付费歌曲'); return; }
const shown = vip.slice(0, 30);
const more = vip.length - shown.length;
if (!window.openTCPanel) return;
window.openTCPanel('清理会员歌曲', '' +
'<div class="sm-fld-hint" style="margin-bottom:8px">以下 ' + vip.length + ' 首经播放探测不可用（会员/付费歌曲网页外链无法播放，或链接已失效），可移除出音乐库：</div>' +
shown.map(m => '<div class="sm-song" data-id="' + m.id + '">' + songIcoHtml(m) +
'<div class="sm-song-info"><div class="sm-song-name">' + esc(m.name || '未知歌曲') + '</div>' +
'<div class="sm-song-sub">' + esc(m.artist || '未知歌手') + '</div></div></div>').join('') +
(more > 0 ? '<div class="sm-fld-hint" style="margin-top:6px">…还有 ' + more + ' 首，一并移除</div>' : '') +
'<div class="mail-actions"><button class="cc-tool" id="sm-vip-cancel">取消</button><button class="cc-tool" id="sm-vip-ok">移除 ' + vip.length + ' 首</button></div>');
document.getElementById('sm-vip-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('sm-vip-ok').addEventListener('click', () => {
const vipIds = vip.map(m => m.id);
library = library.filter(m => vipIds.indexOf(m.id) < 0);
if (currentId && vipIds.indexOf(currentId) >= 0) { teardownAudio(); currentId = null; }
saveLibrary();
document.getElementById('tc-mask').hidden = true;
renderPage();
toast('已移除 ' + vip.length + ' 首会员/付费歌曲');
});
});
}
function updateDurUI(id, dur) {
if (!dur) return;
const txt = fmtDur(dur);
document.querySelectorAll('#music-lib-list .sm-song, #tc-body .sm-song').forEach(row => {
if (row.dataset.id === id) {
const el = row.querySelector('.sm-song-dur');
if (el) el.textContent = txt;
}
});
}
const durProbeQueue = [];
const DUR_PROBE_CONCURRENCY = 4;
let durProbeActive = 0;
function enqueueDurProbe(m) {
if (!m || !m.neteaseId || m.duration > 0) return;
if (durProbeQueue.some(x => x.id === m.id)) return;
durProbeQueue.push(m);
pumpDurProbe();
}
function pumpDurProbe() {
while (durProbeActive < DUR_PROBE_CONCURRENCY && durProbeQueue.length) {
const m = durProbeQueue.shift();
durProbeActive++;
probeOneDuration(m, function () { durProbeActive--; pumpDurProbe(); });
}
}
function probeOneDuration(m, done) {
let tmp = null;
let finished = false;
const timer = setTimeout(() => finish(0), 12000);
function finish(dur) {
if (finished) return;
finished = true;
clearTimeout(timer);
try { if (tmp) { tmp.onerror = null; tmp.onloadedmetadata = null; tmp.removeAttribute('src'); tmp.load(); } } catch (e) {}
if (dur > 0) {
const mm = findTrack(m.id);
if (mm && !mm.duration) {
mm.duration = dur;
saveLibrarySoon();
updateDurUI(m.id, dur);
}
}
done();
}
try {
tmp = new Audio();
try { tmp.referrerPolicy = 'no-referrer'; } catch (e) {}
tmp.preload = 'metadata';
tmp.onloadedmetadata = function () { finish(tmp.duration || 0); };
tmp.onerror = function () {
finish(0);
if (m && m.neteaseId && /^sm_pl_/.test(m.id) && !m._vipChecked && findTrack(m.id)) {
m._vipChecked = true;
confirmVipViaMeting(m.neteaseId, function (isVip) {
if (!isVip) return;
const mm = findTrack(m.id);
if (mm) removeBatchVipSongs([mm]);
});
}
};
tmp.src = neteaseMetingUrl(m.neteaseId);
} catch (e) { finish(0); }
}
function probeAllMissingDurations() {
libSongsFor(libFilter).slice(0, libRenderShown).forEach(m => { if (m && m.neteaseId && !m.duration) enqueueDurProbe(m); });
}
let coverQueueRunning = false;
const coverQueue = [];
const COVER_CONCURRENCY = 3;
function enqueueCoverFetch(m) {
if (!m || !m.neteaseId || m.cover || m._coverLoading) return;
if (coverQueue.some(x => x.id === m.id)) return;
m._coverLoading = true;
coverQueue.push(m);
if (coverQueue.length <= COVER_CONCURRENCY) runCoverQueue();
}
function runCoverQueue() {
if (coverQueueRunning) return;
coverQueueRunning = true;
const next = () => {
if (!coverQueue.length) { coverQueueRunning = false; return; }
const m = coverQueue.shift();
fetchNeteaseCover(m.neteaseId, (pic) => {
const mm = findTrack(m.id);
if (mm) {
mm._coverLoading = false;
if (pic && !mm.cover) {
mm.cover = pic;
saveLibrarySoon();
updateCoverUI(m.id);
if (mm.id === currentId) setWidgetCover(mm);
}
}
next();
});
};
for (let i = 0; i < COVER_CONCURRENCY; i++) next();
}
function ensureSongCover(m) { enqueueCoverFetch(m); }
function ensureMissingCovers() {
libSongsFor(libFilter).slice(0, libRenderShown).forEach(m => {
if (!m) return;
if (m.neteaseId && !m.cover) enqueueCoverFetch(m);
else if (m.cover && COVER_PROXY_RE.test(m.cover)) enqueueCovMig(m);
});
playlists.forEach(pl => { if (pl && pl.cover && COVER_PROXY_RE.test(pl.cover)) enqueueCovMig(pl); });
}
function updateCoverUI(id) {
const m = findTrack(id);
if (!m || !m.cover) return;
document.querySelectorAll('#music-lib-list .sm-song, #tc-body .sm-song').forEach(row => {
if (row.dataset.id === id) {
const ico = row.querySelector('.sm-song-ico');
if (ico) {
ico.className = 'sm-song-ico has-cov';
ico.style.backgroundImage = 'url(\'' + m.cover + '\')';
ico.innerHTML = '';
}
}
});
}
var COVER_PROXY_RE = /^https?:\/\/api\.injahow\.cn\/meting\/\?[^]*type=pic/i;
const covMigInflight = new Set();
let covMigBusy = false;
const covMigQueue = [];
function enqueueCovMig(m) {
if (!m || !m.cover || !COVER_PROXY_RE.test(m.cover) || covMigInflight.has(m.id)) return;
covMigInflight.add(m.id);
covMigQueue.push(m);
runCovMig();
}
function runCovMig() {
if (covMigBusy) return;
const m = covMigQueue.shift();
if (!m) return;
covMigBusy = true;
resolveCoverDirect(m.cover, function (direct) {
covMigInflight.delete(m.id);
covMigBusy = false;
if (direct && direct !== m.cover && !COVER_PROXY_RE.test(direct)) {
m.cover = direct;
if (String(m.id).indexOf('spl_') === 0) savePlaylists(); else saveLibrarySoon();
syncSnapshotCovers(m.id, direct);
if (findTrack(m.id)) {
updateCoverUI(m.id);
if (m.id === currentId) setWidgetCover(m);
}
}
if (covMigQueue.length) runCovMig();
});
}
function syncSnapshotCovers(sid, cov) {
let hch = false;
history.forEach(x => { if (x && x.trackId === sid && x.cover && COVER_PROXY_RE.test(x.cover)) { x.cover = cov; hch = true; } });
myHistory.forEach(x => { if (x && x.trackId === sid && x.cover && COVER_PROXY_RE.test(x.cover)) { x.cover = cov; hch = true; } });
if (hch) { saveHistory(); saveMyHistory(); }
let tch = false;
const tl = taFavList();
tl.forEach(x => { if (x && x.id === sid && x.cover && COVER_PROXY_RE.test(x.cover)) { x.cover = cov; tch = true; } });
if (tch) saveTaFavList(tl);
}
function importPlaylistIds(ids, cb, targetPl) {
let total = 0, plOk = 0, plFail = 0, skipped = 0, vip = 0, miss = 0;
const next = (i) => {
if (i >= ids.length) { cb({ total: total, plOk: plOk, plFail: plFail, skipped: skipped, vip: vip, miss: miss }); return; }
importNeteasePlaylist(ids[i], (res) => {
if (res.ok) { plOk++; total += res.added; skipped += res.skipped; vip += res.vip || 0; miss += res.miss || 0; }
else plFail++;
next(i + 1);
}, targetPl);
};
next(0);
}
const OTHER_APP_LINK_HINT = '<b>✕ 不支持其他 App 的分享链接：</b>QQ音乐 / 酷狗 / 酷我 / 咪咕 / B站 / YouTube / Spotify / Apple Music 等 App 的「分享」链接，点开是网页、不是音频文件，导进来也放不出声。要用这些歌，得先把音频文件拿到手机里（走「上传音乐」）。<br>';
const PLAYLIST_LINK_REMIND = '<b style="color:var(--danger-ink,#a32d2d)">⚠ 直接导入网易云歌单链接即可</b><br>';
function triggerUpload() {
if (!window.openTCPanel) { localPlId = 'default'; }
window.openTCPanel('添加本地音乐', '' +
'<div class="sm-form">' +
'<div class="sm-fld"><label>上传到播放列表</label><select class="tc-input" id="sm-local-pl">' + targetPlOptions() + '</select></div>' +
'<div class="sm-fld-hint">选择一首或多首本地音频（mp3 / m4a / aac / ogg / wav / flac）存放进上面的歌单；选「新建歌单」可先建一个歌单再上传。<br>整首音乐已经存在手机里（自己转换 / 无版权保护的下载 / 录音等）时用这里；如果歌还在别的 App 里（QQ音乐 / 酷狗 / B站 等），App 的「分享」链接不能直接导入。<br><span style="color:var(--danger-ink,#a32d2d)"><b>⚠ 文件必须是不加密的标准音频：</b>音乐 App 里下载 / 缓存的歌曲文件大多带了加密，即使扩展名是 .mp3 / .flac / .m4a 也放不出声；无损 .m4a（ALAC 编码）部分浏览器也不支持。举例：QQ音乐和网易云里下载的歌曲都是有加密的，不在QQ音乐和网易云音乐本体应用里播放是无法播放的，只能自己转格式破解后才能在别的应用和本地播放。上传后点一下播放试试，放不出来的建议转成 <b>mp3</b>（兼容性最好）再上传。</span></div>' +
'</div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-local-cancel">取消</button><button class="cc-tool" id="sm-local-ok">选择文件上传</button></div>');
document.getElementById('sm-local-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
try {
if (window.mochiFilePickDoor) window.mochiFilePickDoor(document.getElementById('sm-local-ok'), {
id: 'mochi-door-sm-local-ok', owner: 'mochi-music-local-pick',
accept: 'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac', multiple: true, veto: 1,
});
} catch (eD) {}
document.getElementById('sm-local-ok').addEventListener('click', () => {
resolveTargetPlSel('sm-local-pl', (pid) => {
localPlId = pid || 'default';
document.getElementById('tc-mask').hidden = true;
window.mochiFilePick({
id: 'mochi-music-local-pick', accept: 'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac', multiple: true,
onFiles: (files) => {
if (!files.length) { toast('没有取到音频文件，请再选一次'); return; }
uploadFiles(files);
}
});
});
});
}
function sniffAudioMime(buf) {
try {
if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) return '';
const u = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
const ascii = (a, b) => { let s = ''; for (let i = a; i < b && i < u.length; i++) s += String.fromCharCode(u[i]); return s; };
if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
if (ascii(0, 4) === 'fLaC') return 'audio/flac';
if (ascii(0, 4) === 'OggS') return 'audio/ogg';
if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
if (u[0] === 0xFF && (u[1] & 0xE0) === 0xE0) return ((u[1] & 0xF6) === 0xF0) ? 'audio/aac' : 'audio/mpeg';
} catch (e) {}
return '';
}
function mimeFromName(n) {
const e = ((/\.([a-z0-9]+)$/i.exec(String(n || '')) || [])[1] || '').toLowerCase();
return { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' }[e] || '';
}
function localFileMime(file, buf) {
return sniffAudioMime(buf) || file.type || mimeFromName(file.name) || 'audio/mpeg';
}
function uploadFiles(files) {
const list = Array.from(files);
if (!list.length) return;
toast('正在上传 ' + list.length + ' 首音乐…');
let idx = 0;
let probeBad = 0; // #700：导入时浏览器就解不动的文件数（加密格式/编码不支持）
const done = () => {
saveLibrary(); renderPage();
if (probeBad) toast('已上传 ' + list.length + ' 首音乐，其中 ' + probeBad + ' 首本机浏览器可能放不了（加密格式或编码不支持）——放不了的建议转成 mp3 再重新上传');
else toast('已上传 ' + list.length + ' 首音乐（点歌曲右侧 ⋯ 可设置封面）');
};
const readFile = (file, cb, failCb) => {
const r1 = new FileReader();
r1.onload = () => { if (r1.result instanceof ArrayBuffer) cb(r1.result, true); else cb(r1.result, false); };
r1.onerror = () => {
const r2 = new FileReader();
r2.onload = () => cb(r2.result, false);
r2.onerror = failCb;
try { r2.readAsDataURL(file); } catch (e) { failCb(); }
};
try { r1.readAsArrayBuffer(file); } catch (e) { failCb(); }
};
const storePayload = (id, file, buf) => {
const payload = buf instanceof ArrayBuffer ? new Blob([buf], { type: localFileMime(file, buf) }) : buf;
const key = MUSIC_PREFIX + ':music-file:' + id;
const toDataUrl = (cb) => {
const fr = new FileReader();
fr.onload = () => cb(fr.result);
fr.onerror = () => cb(null);
const src = payload instanceof Blob ? payload : new Blob([buf], { type: localFileMime(file, buf) });
try { fr.readAsDataURL(src); } catch (e) { cb(null); }
};
const saveToLocal = (dv) => {
if (!dv) { saveLibrarySoon(); return; }
try {
localStorage.setItem(key, dv);
} catch (e) {
try { toast('存储空间不足，部分音乐可能无法播放'); } catch (e2) {}
}
saveLibrarySoon();
};
const saveStrFallback = (dv) => {
if (!dv) { saveLibrarySoon(); return; }
if (window.idbSet) {
window.idbSet(key, dv).then(ok2 => { if (ok2) saveLibrarySoon(); else saveToLocal(dv); }).catch(() => saveToLocal(dv));
} else {
saveToLocal(dv);
}
};
if (!window.indexedDB || !window.idbSet) {
toDataUrl(saveToLocal);
return;
}
window.idbSet(key, payload).then(ok => {
if (ok) { saveLibrarySoon(); return; }
toDataUrl(saveStrFallback);
}).catch(() => {
toDataUrl(saveStrFallback);
});
};
const next = function () {
if (idx >= list.length) { done(); return; }
const file = list[idx++];
if (file.size > 50 * 1024 * 1024) { toast('「' + file.name + '」超过 50MB，已跳过'); next(); return; }
readFile(file, function (buf) {
const id = 'sm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
const name = file.name.replace(/\.[^.]+$/, '');
const item = { id: id, name: name, artist: '', url: '', source: 'local', duration: 0, playlistId: localPlId || 'default', addedAt: Date.now() };
library.push(item);
const payload = buf instanceof ArrayBuffer ? new Blob([buf], { type: localFileMime(file, buf) }) : buf;
localBlobCache[id] = payload; // v3.29.x 内存缓存：playTrack 同步读取保留用户手势
const tmp = document.createElement('audio');
tmp.preload = 'metadata';
let tmpUrl = null;
let metaTimer = null;
let settled = false;
const cleanupTmp = () => {
try { if (tmpUrl) URL.revokeObjectURL(tmpUrl); } catch(e) {}
try { tmp.src = ''; tmp.load(); } catch(e) {}
};
const finishMeta = () => {
if (settled) return;
settled = true;
if (metaTimer) clearTimeout(metaTimer);
cleanupTmp();
next();
};
tmp.onloadedmetadata = function () {
const m = findTrack(id);
if (m && tmp.duration) { m.duration = tmp.duration; }
finishMeta();
};
tmp.onerror = function () {
probeBad++;
const it = findTrack(id);
if (it) { try { it.probeFail = 1; } catch (e) {} }
finishMeta();
};
metaTimer = setTimeout(finishMeta, 3000);
if (payload instanceof Blob) {
tmpUrl = URL.createObjectURL(payload);
tmp.src = tmpUrl;
} else {
tmp.src = payload;
}
storePayload(id, file, buf);
}, function () { next(); });
};
next();
}
function readCeInput(id) {
const el = document.getElementById(id);
if (!el) return '';
try {
const v = el.value;
if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
} catch (e) {}
try {
const box = el.__ceBox || (el.parentNode && el.parentNode.querySelector('.ce-box[data-for="' + (el.id || '') + '"]'));
if (box) {
const t = (box.innerText !== undefined ? box.innerText : box.textContent) || '';
if (t.trim()) return t.trim();
}
} catch (e) {}
return '';
}
function targetPlOptions() {
return '<option value="default">我的音乐库</option>' +
playlists.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') +
'<option value="__new__">＋ 新建歌单…</option>';
}
function resolveTargetPlaylist(cb) {
const sel = document.getElementById('sm-target-pl');
if (!sel) { cb('default'); return; }
const pid = sel.value;
if (pid === '__new__') {
if (!window.openModal) { cb('default'); return; }
window.openModal('新建歌单', '', (name) => {
name = (name || '').trim();
if (!name) { toast('请输入歌单名称'); return; }
const newId = 'spl_' + Date.now();
playlists.push({ id: newId, name: name, createdAt: Date.now() });
savePlaylists();
cb(newId);
});
} else {
cb(pid);
}
}
function resolveTargetPlSel(selId, cb) {
const sel = document.getElementById(selId);
if (!sel) { cb('default'); return; }
const pid = sel.value;
if (pid === '__new__') {
if (!window.openModal) { cb('default'); return; }
window.openModal('新建歌单', '', (name) => {
name = (name || '').trim();
if (!name) { toast('请输入歌单名称'); return; }
const newId = 'spl_' + Date.now();
playlists.push({ id: newId, name: name, createdAt: Date.now() });
savePlaylists();
cb(newId);
});
} else {
cb(pid);
}
}
function openAddUrl() {
if (!window.openTCPanel) return;
window.openTCPanel('添加链接音乐', '' +
'<div class="sm-form">' +
'<div class="sm-fld"><label>歌曲名称</label><input class="tc-input" id="sm-url-name" placeholder="可留空，识别后自动补全"></div>' +
'<div class="sm-fld"><label>歌手</label><input class="tc-input" id="sm-url-artist" placeholder="可留空"></div>' +
'<div class="sm-fld"><label>网易云歌曲ID 或 链接 / 音乐直链</label><textarea class="tc-input" id="sm-url-link" rows="3" placeholder="如 2064961530&#10;或 https://music.163.com/#/song?id=xxx&#10;每行一个，支持批量"></textarea></div>' +
'<div class="sm-fld"><label>导入到歌单</label><select class="tc-input" id="sm-target-pl">' + targetPlOptions() + '</select></div>' +
'<div class="sm-fld-hint">' + PLAYLIST_LINK_REMIND + '<b>可填 3 类：</b>① 网易云歌曲数字 ID（如 2064961530）；② <b>完整网易云链接</b>（如 music.163.com/#/song?id=xxx、song/media/outer/url?id=xxx.mp3、分享短链 163cn.tv/xxx），都会自动识别导入，不用手动填 ID；③ <b>音频文件直链</b>（点开就是音频本身、以 .mp3 / .m4a 等结尾的 URL，需 https）。支持批量：每行一个 ID 或链接；批量时歌曲名/歌手自动识别，可不填。<br>粘贴歌单分享链接（music.163.com/playlist?id=xxx 或 #/playlist?id=xxx）自动导入整个歌单。<br>' + OTHER_APP_LINK_HINT + '<span style="opacity:.75">⚠ 链接上传的 VIP/付费歌曲无法播放（仅免费歌曲可播）；歌单导入受网络环境影响，失败可稍后重试</span></div>' +
'</div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-url-cancel">取消</button><button class="cc-tool" id="sm-url-ok">确认添加</button></div>');
document.getElementById('sm-url-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('sm-url-ok').addEventListener('click', () => {
let name = readCeInput('sm-url-name');
const artist = readCeInput('sm-url-artist');
const raw = readCeInput('sm-url-link');
if (!raw) { toast('请输入网易云ID或音乐链接'); return; }
resolveTargetPlaylist((targetPl) => {
const lines = raw.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
if (!lines.length) { toast('请输入网易云ID或音乐链接'); return; }
const isBatch = lines.length > 1;
const playlistIds = [];
const trackLines = [];
lines.forEach(ln => {
const plId = extractPlaylistId(ln);
if (plId) { if (playlistIds.indexOf(plId) < 0) playlistIds.push(plId); }
else trackLines.push(ln);
});
const addLinkLines = (lins, batchMode) => {
let added = 0;
lins.forEach((ln, li) => {
const neteaseId = extractNeteaseSongId(ln);
let url = ln;
let nm = batchMode ? '' : name;
if (neteaseId) {
url = neteaseMetingUrl(neteaseId);
if (!nm) nm = '网易云音乐-' + neteaseId;
}
if (!neteaseId && /^http:\/\//i.test(url)) url = url.replace(/^http:\/\//i, 'https://');
if (!/^(https?:\/\/|file:\/\/|data:|\/)/i.test(url)) return;
const id = 'sm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6) + '_' + li;
const item = { id: id, neteaseId: neteaseId || '', name: nm, artist: batchMode ? '' : artist, url: url, source: 'url', duration: 0, playlistId: targetPl || 'default', addedAt: Date.now() };
library.push(item);
added++;
if (neteaseId) {
enqueueDurProbe(item);
ensureSongCover(item);
fetchNeteaseInfo(neteaseId, info => {
const m = findTrack(id);
if (m && info && info.name) {
m.name = info.name;
if (info.artist) m.artist = info.artist;
if (info.duration && !m.duration) { m.duration = info.duration; updateDurUI(m.id, m.duration); }
saveLibrary();
renderPage();
if (!batchMode) toast('已识别：' + info.name + (info.artist ? ' - ' + info.artist : ''));
}
});
} else if (isNetShortLink(ln)) {
resolveNetShortLink(ln, rid => {
if (!rid) {
toast('网易云分享链接解析失败：先用浏览器打开这条链接，再把地址栏里 music.163.com/song?id=数字 的完整链接或数字粘贴导入');
return;
}
const m = findTrack(id);
if (m) {
m.neteaseId = rid;
m.url = neteaseMetingUrl(rid);
enqueueDurProbe(m);
ensureSongCover(m);
fetchNeteaseInfo(rid, info => {
const mm = findTrack(id);
if (mm && info && info.name) {
if (!mm.name || /^链接音乐$/.test(mm.name)) mm.name = info.name;
if (info.artist) mm.artist = info.artist;
if (info.duration && !mm.duration) mm.duration = info.duration;
saveLibrary();
renderPage();
if (!batchMode) toast('已识别：' + info.name + (info.artist ? ' - ' + info.artist : ''));
} else {
saveLibrary();
renderPage();
}
});
}
});
}
});
if (!added) return;
saveLibrary();
document.getElementById('tc-mask').hidden = true;
renderPage();
if (!playlistIds.length) toast(batchMode ? '已批量添加 ' + added + ' 首链接音乐' : '链接音乐已添加');
};
if (playlistIds.length) {
toast('正在导入 ' + playlistIds.length + ' 个歌单…');
importPlaylistIds(playlistIds, (res) => {
if (trackLines.length) addLinkLines(trackLines, isBatch);
else { saveLibrary(); document.getElementById('tc-mask').hidden = true; renderPage(); }
let msg = res.total
? '已导入 ' + res.plOk + ' 个歌单 / ' + res.total + ' 首' + (res.skipped ? '（跳过已有 ' + res.skipped + ' 首）' : '')
: '歌单导入失败';
if (res.vip) msg += '（VIP 歌曲 ' + res.vip + ' 首未导入）';
if (res.miss) msg += '（数据源受限，另有 ' + res.miss + ' 首未取到，稍后重导同一链接可补齐）';
if (res.plFail) {
if (!res.total) {
msg += '：可能为私密歌单、已失效或被浏览器拦截';
if (((window.mochiDevice || {}).env || {}).apiBlockedHint) msg += '（当前浏览器可能拦截了音乐 API，可换用 Safari 重试）';
else msg += '，可稍后重试';
} else {
msg += '；' + res.plFail + ' 个失败（可能私密/已失效/被浏览器拦截）';
}
}
toast(msg);
}, targetPl);
return;
}
addLinkLines(lines, isBatch);
});
});
}
function openBatch() {
if (!window.openTCPanel) return;
window.openTCPanel('批量导入音乐', '' +
'<div class="sm-fld-hint" style="margin-bottom:8px">' + PLAYLIST_LINK_REMIND + '<b>支持 3 种导入方式：</b><br>① <b>网易云歌单</b>：直接粘贴歌单分享链接（music.163.com/playlist?id=xxx 或 #/playlist?id=xxx），自动导入整个歌单；<br>② <b>网易云单曲</b>：每行一个歌曲数字 ID（如 2064961530），或<b>直接粘贴完整网易云链接</b>（如 music.163.com/#/song?id=xxx、song/media/outer/url?id=xxx.mp3），自动识别导入，不用手动填 ID；<br>③ <b>本地/直链</b>：按「歌曲名称 / 歌手 / 音乐直链URL」格式粘贴，每首歌空一行分隔（URL 栏同样支持直接贴网易云链接；直链要点开就是音频本身、以 .mp3 等结尾、需 https）。<br>' + OTHER_APP_LINK_HINT + '<br><span style="opacity:.75">⚠ 链接上传的 VIP/付费歌曲无法播放（仅免费歌曲可播）；歌单导入会自动移除 VIP/付费歌曲；歌单导入受网络环境影响（部分手机浏览器可能拦截），失败可稍后重试</span></div>' +
'<textarea id="sm-batch-input" class="tc-input" rows="8" placeholder="网易云歌单链接：https://music.163.com/playlist?id=3778678&#10;网易云单曲链接：https://music.163.com/#/song?id=27538343&#10;或纯数字 ID：27538343&#10;&#10;歌曲名称：Baby&#10;歌手：EXO-K&#10;音乐直链URL：http://music.163.com/song/media/outer/url?id=27538343.mp3"></textarea>' +
'<div class="sm-fld"><label>导入到歌单</label><select class="tc-input" id="sm-target-pl">' + targetPlOptions() + '</select></div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-batch-cancel">取消</button><button class="cc-tool" id="sm-batch-ok">开始导入</button></div>');
document.getElementById('sm-batch-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('sm-batch-ok').addEventListener('click', () => {
const raw = readCeInput('sm-batch-input');
if (!raw) { toast('请输入内容'); return; }
resolveTargetPlaylist((targetPl) => {
const rawLines = raw.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
const plIds = [];
rawLines.forEach(l => { const pid = extractPlaylistId(l); if (pid && plIds.indexOf(pid) < 0) plIds.push(pid); });
const isLabelLine = (l) => {
if (/^https?:\/\//i.test(l) || /^\/\//.test(l)) return false;
return /^[^:=：＝/]+?[:：＝=]\s*\S+/.test(l);
};
const hasLabels = rawLines.some(isLabelLine);
const units = hasLabels
? raw.split(/\n\s*\n/).map(b => ({ lines: b.split('\n').map(s => s.trim()).filter(Boolean), plain: false }))
: rawLines.filter(l => !extractPlaylistId(l)).map(l => ({ lines: [l], plain: true }));
let added = 0;
units.forEach((unit, ui) => {
let name = '', artist = '', url = '';
if (unit.plain) {
url = unit.lines[0];
} else {
unit.lines.forEach(line => {
const sepMatch = line.match(/^([^:=]+?)(?:[:：＝=])\s*(.+)$/);
if (!sepMatch) {
const t = line.trim();
if (/^\d+$/.test(t) || /^https?:\/\//i.test(t)) url = t;
return;
}
const key = sepMatch[1].replace(/\s+/g, '').toLowerCase();
const val = sepMatch[2].trim();
if (/^(歌曲名称|歌名|名称|name|歌曲)$/.test(key)) name = val;
else if (/^(歌手|艺术家|艺人|artist|演唱)$/.test(key)) artist = val;
else if (/^(音乐直链url|音乐直链|音乐链接|链接|直链|url|音乐url|link)$/.test(key)) url = val;
});
}
if (!url) return;
if (extractPlaylistId(url)) return; // 歌单链接单独走歌单导入，不当作单曲
const neteaseId = extractNeteaseSongId(url);
if (neteaseId) {
url = neteaseMetingUrl(neteaseId);
if (!name) name = '网易云音乐-' + neteaseId; // 只填数字时自动补默认名
}
if (!name) {
const fn = (url.match(/\/([^/?#]+?)(?:\.[^/.?#]+)?$/) || [])[1];
name = fn || '链接音乐';
}
if (!/^(https?:\/\/|file:\/\/|data:|\/)/i.test(url)) return;
if (!neteaseId && /^http:\/\//i.test(url)) url = url.replace(/^http:\/\//i, 'https://');
const nid = 'sm_batch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6) + '_' + ui;
const item = { id: nid, neteaseId: neteaseId || '', name: name, artist: artist, url: url, source: 'url', duration: 0, playlistId: targetPl || 'default', addedAt: Date.now() };
library.push(item);
added++;
if (neteaseId) {
enqueueDurProbe(item);
ensureSongCover(item);
fetchNeteaseInfo(neteaseId, info => {
const mm = library.find(x => x.id === nid);
if (mm && info && info.name) {
mm.name = info.name;
if (info.artist) mm.artist = info.artist;
if (info.duration && !mm.duration) { mm.duration = info.duration; updateDurUI(mm.id, mm.duration); }
saveLibrary();
renderPage();
}
});
} else if (isNetShortLink(url)) {
resolveNetShortLink(url, rid => {
if (!rid) return;
const bm = library.find(x => x.id === nid);
if (bm) {
bm.neteaseId = rid;
bm.url = neteaseMetingUrl(rid);
enqueueDurProbe(bm);
ensureSongCover(bm);
fetchNeteaseInfo(rid, info => {
const bm2 = library.find(x => x.id === nid);
if (bm2 && info && info.name) {
if (!bm2.name || /^链接音乐$/.test(bm2.name)) bm2.name = info.name;
if (info.artist) bm2.artist = info.artist;
if (info.duration && !bm2.duration) bm2.duration = info.duration;
saveLibrary();
renderPage();
} else {
saveLibrary();
renderPage();
}
});
}
});
}
});
if (!added && !plIds.length) { toast('没有识别到有效歌曲，请检查格式'); return; }
if (plIds.length) {
toast('正在导入 ' + plIds.length + ' 个歌单…');
importPlaylistIds(plIds, (res) => {
saveLibrary();
document.getElementById('tc-mask').hidden = true;
renderPage();
let msg = (added ? '已导入 ' + added + ' 首音乐 + ' : '已导入 ');
if (res.total) {
msg += res.plOk + ' 个歌单 / ' + res.total + ' 首';
} else {
msg += '0 首歌单（可能私密/已失效/被浏览器拦截';
if (((window.mochiDevice || {}).env || {}).apiBlockedHint) msg += '，当前浏览器可能拦截了音乐 API，可换用 Safari 重试';
else msg += '，可稍后重试';
msg += '）';
}
if (res.skipped) msg += '（跳过已有 ' + res.skipped + ' 首）';
if (res.vip) msg += '（VIP 歌曲 ' + res.vip + ' 首未导入）';
if (res.miss) msg += '（数据源受限，另有 ' + res.miss + ' 首未取到，稍后重导同一链接可补齐）';
if (res.plFail && res.total) msg += '；' + res.plFail + ' 个歌单失败（可能私密/已失效/被拦截）';
toast(msg);
}, targetPl);
return;
}
saveLibrary();
document.getElementById('tc-mask').hidden = true;
renderPage();
toast('已导入 ' + added + ' 首音乐');
});
});
}
function renderPlaylists() {
const el = document.getElementById('music-pl-list');
if (!el) return;
const pls = playlists.slice();
const libCount = library.filter(m => !m.playlistId || m.playlistId === 'default').length;
const libItem = '<div class="sm-pl sm-pl-lib" data-pid="default">' +
'<span class="sm-pl-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></span>' +
'<div class="sm-pl-info"><div class="sm-pl-name">我的音乐库</div><div class="sm-pl-sub">' + libCount + ' 首</div></div>' +
'</div>';
el.innerHTML = libItem + pls.map(p => {
const count = library.filter(m => m.playlistId === p.id).length;
const icoCls = p.cover ? 'sm-pl-ico has-cov' : 'sm-pl-ico';
const icoStyle = p.cover ? ' style="background-image:url(\'' + esc(p.cover) + '\')"' : '';
const icoInner = p.cover ? '' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
return '<div class="sm-pl" data-pid="' + p.id + '">' +
'<span class="' + icoCls + '"' + icoStyle + '>' + icoInner + '</span>' +
'<div class="sm-pl-info"><div class="sm-pl-name">' + esc(p.name) + '</div><div class="sm-pl-sub">' + count + ' 首</div></div>' +
'<button class="sm-pl-edit" data-pid="' + p.id + '" title="编辑歌单"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>' +
'<button class="sm-pl-del" data-pid="' + p.id + '" title="删除歌单"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/></svg></button>' +
'</div>';
}).join('');
el.querySelectorAll('.sm-pl').forEach(row => {
row.addEventListener('click', (e) => {
if (e.target.closest('.sm-pl-del') || e.target.closest('.sm-pl-edit')) return;
const pid = row.dataset.pid;
let pl, songs;
if (pid === 'default') {
pl = { name: '我的音乐库' };
songs = library.filter(m => !m.playlistId || m.playlistId === 'default');
} else {
pl = playlists.find(p => p.id === pid);
songs = library.filter(m => m.playlistId === pid);
}
if (!pl || !window.openTCPanel) return;
window.openTCPanel(esc(pl.name), songs.length
? songs.map(m => '<div class="sm-song" data-id="' + m.id + '">' +
songIcoHtml(m) +
'<div class="sm-song-info"><div class="sm-song-name">' + esc(m.name || '未知歌曲') + '</div>' +
'<div class="sm-song-sub">' + esc(m.artist || '未知歌手') + '</div></div>' +
'<span class="sm-song-dur">' + fmtDur(m.duration) + '</span></div>').join('')
: '<div class="ta-empty">这个歌单还没有歌曲</div>');
document.querySelectorAll('#tc-body .sm-song').forEach(s => {
s.addEventListener('click', () => playTrack(s.dataset.id));
});
});
});
el.querySelectorAll('.sm-pl-del').forEach(b => {
b.addEventListener('click', () => {
const pid = b.dataset.pid;
const pl = playlists.find(p => p.id === pid);
if (!pl) return;
if (pl.id === 'spl_default') { toast('默认歌单不能删除'); return; }
if (window.openModal) {
window.openModal('删除歌单「' + pl.name + '」？歌单里的歌曲不会删除', '', () => {
library.forEach(m => { if (m.playlistId === pid) m.playlistId = 'default'; });
playlists = playlists.filter(p => p.id !== pid);
saveLibrary(); savePlaylists(); renderPage();
}, { noInput: true });
}
});
});
el.querySelectorAll('.sm-pl-edit').forEach(b => {
b.addEventListener('click', (e) => { e.stopPropagation(); openPlaylistEditor(b.dataset.pid); });
});
}
function openPlaylistEditor(pid) {
const pl = playlists.find(p => p.id === pid);
if (!pl || !window.openTCPanel) return;
const isDefault = pl.id === 'spl_default';
window.openTCPanel('编辑歌单', '' +
'<div class="sm-fld"><label>歌单名称</label><input class="tc-input" id="sm-pe-name" value="' + String(pl.name || '').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"></div>' +
'<div class="sm-fld"><label>歌单封面</label>' +
'<div class="sm-cov-row">' +
'<div class="sm-cov-prev' + (pl.cover ? ' has-cov' : '') + '" id="sm-pe-cov-prev"' + (pl.cover ? ' style="background-image:url(\'' + esc(pl.cover) + '\')"' : '') + ' title="点击上传封面"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg></div>' +
'<div class="sm-cov-actions"><button class="cc-tool sm-cov-btn" id="sm-pe-cov-up">上传封面</button><button class="cc-tool sm-cov-btn" id="sm-pe-cov-clear"' + (pl.cover ? '' : ' hidden') + '>清除封面</button></div>' +
'</div></div>' +
'<div class="sm-set-hint">设置封面后，可在「音乐设置」切换桌面小组件显示歌单封面或歌曲封面</div>' +
'<div class="mail-actions">' + (isDefault ? '' : '<button class="cc-tool" id="sm-pe-del">删除歌单</button>') + '<button class="cc-tool" id="sm-pe-cancel">取消</button><button class="cc-tool" id="sm-pe-ok">保存</button></div>');
const covPrev = document.getElementById('sm-pe-cov-prev');
const covUp = document.getElementById('sm-pe-cov-up');
const covClear = document.getElementById('sm-pe-cov-clear');
const covPickOpts = {
id: 'mochi-pl-cover-pick', accept: 'image/*',
onFiles: function (files) {
const f = files && files[0];
if (!f) { toast('没有取到图片，请再选一次'); return; }
compressCover(f, function (dv) {
if (!dv) { toast('封面读取失败，请换一张图片'); return; }
pl.cover = dv;
savePlaylists(); renderPage();
covPrev.classList.add('has-cov');
covPrev.style.backgroundImage = 'url(\'' + dv + '\')';
covClear.hidden = false;
const cur = findTrack(currentId);
if (cur && cur.playlistId === pid && settings.widgetCoverMode === 'playlist') setWidgetCover(cur);
toast('歌单封面已设置');
});
}
};
window.mochiFilePick({ id: 'mochi-pl-cover-pick', accept: 'image/*', noClick: true, onFiles: covPickOpts.onFiles });
const pickCover = () => { try { window.mochiFilePick(covPickOpts); } catch (e) {} };
const onPickBtn = (btn) => {
if (!btn) return;
if (window.mochiFilePickLabel) window.mochiFilePickLabel(btn, document.getElementById('mochi-pl-cover-pick'));
btn.addEventListener('click', (e) => {
const _input = document.getElementById('mochi-pl-cover-pick');
if (_input && window.mochiFilePickGuard) window.mochiFilePickGuard(_input, pickCover);
else pickCover();
});
};
onPickBtn(covUp);
onPickBtn(covPrev);
if (covClear) covClear.addEventListener('click', () => {
pl.cover = '';
savePlaylists(); renderPage();
covPrev.classList.remove('has-cov');
covPrev.style.backgroundImage = '';
covClear.hidden = true;
const cur = findTrack(currentId);
if (cur && cur.playlistId === pid && settings.widgetCoverMode === 'playlist') setWidgetCover(cur);
toast('已清除歌单封面');
});
document.getElementById('sm-pe-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('sm-pe-ok').addEventListener('click', () => {
const name = (document.getElementById('sm-pe-name').value || '').trim();
if (name) pl.name = name;
savePlaylists();
document.getElementById('tc-mask').hidden = true;
renderPage();
toast('已保存');
});
const delBtn = document.getElementById('sm-pe-del');
if (delBtn) delBtn.addEventListener('click', () => {
if (!window.openModal) return;
window.openModal('删除歌单「' + pl.name + '」？歌单里的歌曲不会删除', '', () => {
library.forEach(m => { if (m.playlistId === pid) m.playlistId = 'default'; });
playlists = playlists.filter(p => p.id !== pid);
saveLibrary(); savePlaylists(); renderPage();
document.getElementById('tc-mask').hidden = true;
}, { noInput: true });
});
}
const plCreate = document.getElementById('music-pl-create');
if (plCreate) {
plCreate.addEventListener('click', () => {
if (!window.openTCPanel) return;
window.openTCPanel('新建歌单', '' +
'<div class="sm-fld"><label>歌单名称</label><input class="tc-input" id="sm-pl-name" placeholder="歌单名称"></div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-pl-cancel">取消</button><button class="cc-tool" id="sm-pl-ok">创建</button></div>');
document.getElementById('sm-pl-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('sm-pl-ok').addEventListener('click', () => {
const name = (document.getElementById('sm-pl-name').value || '').trim();
if (!name) { toast('请输入歌单名称'); return; }
playlists.push({ id: 'spl_' + Date.now(), name: name, createdAt: Date.now() });
savePlaylists();
document.getElementById('tc-mask').hidden = true;
renderPage();
toast('歌单已创建');
});
});
}
let musicBatch = false;
const batchSel = new Set();
let libFilter = 'all';
const LIB_RENDER_LIMIT = 300;
let libRenderShown = LIB_RENDER_LIMIT;
function libSongsFor(filter) {
if (filter === 'default') return library.filter(m => !m.playlistId || m.playlistId === 'default');
if (filter && filter !== 'all') return library.filter(m => m.playlistId === filter);
return library.slice();
}
function renderLibrary() {
const listEl = document.getElementById('music-lib-list');
const emptyEl = document.getElementById('music-lib-empty');
if (!listEl) return;
const songs = libSongsFor(libFilter);
if (emptyEl) {
emptyEl.hidden = songs.length > 0;
if (!songs.length) {
emptyEl.textContent = libFilter === 'all'
? '还没有音乐，上传本地音乐，建立属于你们的声音陪伴空间（只支持本机音频文件、网易云链接 / 歌单、音频直链；QQ音乐等其他 App 的分享链接不能导入）'
: (libFilter === 'default' ? '还没有未分类的音乐' : '这个歌单还没有歌曲');
}
}
const renderSongs = songs.slice(0, libRenderShown);
listEl.innerHTML = renderSongs.length
? renderSongs.map(m => {
const active = m.id === currentId;
const icon = active && audio && !audio.paused
? '<path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z"/>'
: '<path d="M8 5.5v13l11-6.5z"/>';
const badge = m.source === 'local'
? '<span class="sm-src sm-src-local">本地</span>' + (m.fileLost ? '<span class="sm-src sm-src-bad">文件丢失</span>' : m.probeFail ? '<span class="sm-src sm-src-bad">放不了</span>' : '')
: '<span class="sm-src">网络</span>';
const checked = musicBatch && batchSel.has(m.id) ? ' sel' : '';
const chk = musicBatch ? '<span class="sm-batch-chk"></span>' : '';
return '<div class="sm-song' + (active ? ' active' : '') + checked + '" data-id="' + m.id + '">' +
chk +
songIcoHtml(m, icon) +
'<div class="sm-song-info"><div class="sm-song-name">' + esc(m.name || '未知歌曲') + '</div>' +
'<div class="sm-song-sub">' + esc(m.artist || '未知歌手') + ' · ' + badge + '</div></div>' +
'<span class="sm-song-dur">' + fmtDur(m.duration) + '</span>' +
'<button class="sm-song-more" data-id="' + m.id + '" title="管理"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' +
'</div>';
}).join('')
: '';
if (songs.length > renderSongs.length) {
const more = document.createElement('div');
more.className = 'sm-load-more';
more.style.cssText = 'text-align:center;padding:14px;color:var(--accent,#e74c5e);font-size:14px;cursor:pointer;border-radius:8px;margin:6px 0;background:rgba(255,255,255,.06)';
more.textContent = '还有 ' + (songs.length - renderSongs.length) + ' 首，点击加载更多';
more.addEventListener('click', () => { libRenderShown += LIB_RENDER_LIMIT; renderLibrary(); });
listEl.appendChild(more);
}
listEl.querySelectorAll('.sm-song').forEach(row => {
row.addEventListener('click', (e) => {
if (musicBatch) {
const id = row.dataset.id;
if (batchSel.has(id)) batchSel.delete(id); else batchSel.add(id);
row.classList.toggle('sel', batchSel.has(id));
updateBatchCount();
return;
}
if (e.target.closest('.sm-song-more')) return;
playTrack(row.dataset.id);
});
});
listEl.querySelectorAll('.sm-song-more').forEach(b => {
b.addEventListener('click', () => openSongMenu(b.dataset.id));
});
}
function renderLibFilter() {
const wrap = document.getElementById('music-lib-filter');
if (!wrap) return;
const unclassified = library.filter(m => !m.playlistId || m.playlistId === 'default');
if (libFilter === 'default' && !unclassified.length) libFilter = 'all';
if (libFilter !== 'all' && libFilter !== 'default' && !playlists.some(p => p.id === libFilter)) libFilter = 'all';
wrap.hidden = !library.length;
const chip = (key, name, count) =>
'<button class="mlf-chip' + (libFilter === key ? ' sel' : '') + '" data-mlf="' + key + '">' +
'<span class="mlf-name">' + name + '</span><span class="mlf-cnt">' + count + '</span></button>';
let html = '<button class="mlf-chip mlf-queue" id="sm-lib-queue" title="查看播放队列">' +
'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h9"/></svg>' +
'<span class="mlf-name">播放列表</span>' + (playQueue.length ? '<span class="mlf-cnt">' + playQueue.length + '</span>' : '') + '</button>';
html += chip('all', '全部音乐', library.length);
if (unclassified.length) html += chip('default', '未分类音乐', unclassified.length);
html += playlists.map(p => chip(p.id, esc(p.name), library.filter(m => m.playlistId === p.id).length)).join('');
wrap.innerHTML = html;
const libQueue = document.getElementById('sm-lib-queue');
if (libQueue) libQueue.addEventListener('click', openQueuePanel);
wrap.querySelectorAll('.mlf-chip').forEach(b => {
b.addEventListener('click', () => {
if (!b.dataset.mlf) return;
if (libFilter === b.dataset.mlf) return;
libFilter = b.dataset.mlf;
libRenderShown = LIB_RENDER_LIMIT; // 切换分类时重置窗口化渲染计数
if (musicBatch) batchSel.clear();
renderLibFilter();
renderLibrary();
updateBatchCount();
});
});
}
function enterBatch() {
musicBatch = true;
batchSel.clear();
renderLibrary();
if (!document.getElementById('music-batch-bar')) {
const bar = document.createElement('div');
bar.id = 'music-batch-bar';
bar.className = 'music-batch-bar';
bar.innerHTML =
'<span class="music-batch-count" id="music-batch-count">已选 0 首</span>' +
'<button class="music-batch-btn" id="mb-all">全选</button>' +
'<button class="music-batch-btn" id="mb-to-pl">加入歌单</button>' +
'<button class="music-batch-btn music-batch-del" id="mb-del">删除</button>' +
'<button class="music-batch-btn" id="mb-exit">退出</button>';
document.body.appendChild(bar);
bar.querySelector('#mb-all').addEventListener('click', () => {
const ids = libSongsFor(libFilter).map(m => m.id);
if (batchSel.size === ids.length && ids.length) batchSel.clear();
else ids.forEach(id => batchSel.add(id));
renderLibrary();
updateBatchCount();
});
bar.querySelector('#mb-del').addEventListener('click', () => {
if (!batchSel.size) { toast('请先勾选歌曲'); return; }
if (window.openModal) {
window.openModal('删除选中的 ' + batchSel.size + ' 首音乐？', '', () => {
library = library.filter(m => !batchSel.has(m.id));
if (window.idbGetAllKeys) {
window.idbGetAllKeys().then(keys => {
keys.filter(k => { for (const id of batchSel) if (k === MUSIC_PREFIX + ':music-file:' + id) return true; return false; })
.forEach(k => { if (window.idbDelete) window.idbDelete(k); });
});
}
if (batchSel.has(currentId)) { teardownAudio(); currentId = null; }
batchSel.clear();
saveLibrary();
renderPage();
updateBatchCount();
toast('已删除');
}, { noInput: true });
}
});
bar.querySelector('#mb-to-pl').addEventListener('click', () => {
if (!batchSel.size) { toast('请先勾选歌曲'); return; }
if (!window.openTCPanel) return;
window.openTCPanel('加入歌单', '<div class="sm-fld"><label>选择歌单</label><select class="tc-input" id="mb-pl-select">' +
playlists.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') + '</select></div>' +
'<div class="mail-actions"><button class="cc-tool" id="mb-pl-cancel">取消</button><button class="cc-tool" id="mb-pl-ok">加入</button></div>');
document.getElementById('mb-pl-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('mb-pl-ok').addEventListener('click', () => {
const pid = document.getElementById('mb-pl-select').value;
library.forEach(m => { if (batchSel.has(m.id)) m.playlistId = pid; });
saveLibrary();
document.getElementById('tc-mask').hidden = true;
batchSel.clear();
renderPage();
updateBatchCount();
toast('已加入歌单');
});
});
bar.querySelector('#mb-exit').addEventListener('click', exitBatch);
}
document.getElementById('music-batch-bar').hidden = false;
const pb = document.getElementById('sm-player-bar');
if (pb) pb.hidden = true;
updateBatchCount();
}
function exitBatch() {
musicBatch = false;
batchSel.clear();
const bar = document.getElementById('music-batch-bar');
if (bar) bar.hidden = true;
const pb = document.getElementById('sm-player-bar');
if (pb) pb.hidden = !(currentId && audio) && !(window.mochiNeteaseSharedActive && window.mochiNeteaseSharedActive());
renderLibrary();
}
function updateBatchCount() {
const el = document.getElementById('music-batch-count');
if (el) el.textContent = '已选 ' + batchSel.size + ' 首';
}
function renderHistoryItem(x) {
const t = (!x.mode && x.trackId) ? findTrack(x.trackId) : null;
const cov = (!x.mode && (x.cover || (t && t.cover))) || '';
const ico = cov
? '<span class="sm-his-ico has-cov" style="background-image:url(\'' + esc(cov) + '\')"></span>'
: '<span class="sm-his-ico">' + (x.mode
? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>'
: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>') + '</span>';
return '<div class="sm-his">' + ico +
'<div class="sm-his-info"><div class="sm-his-name">' + (x.mode ? esc(window.taFit ? window.taFit(x.triggerType || '播放模式') : (x.triggerType || '播放模式')) : esc(x.trackName || '未知歌曲')) + '</div>' +
'<div class="sm-his-sub">' + fmtDT(x.ts) + (x.mode ? '' : (x.triggerType ? ' · ' + esc(window.taFit ? window.taFit(x.triggerType) : x.triggerType) : '')) + '</div></div></div>';
}
function renderHistory() {
const el = document.getElementById('music-his-list');
if (!el) return;
const subBar = '<div class="sm-his-subtabs">' +
'<button class="sm-his-subtab' + (hisSubTab === 'mine' ? ' sel' : '') + '" data-hissub="mine">我的听歌</button>' +
'<button class="sm-his-subtab' + (hisSubTab === 'ta' ? ' sel' : '') + '" data-hissub="ta">' + (window.taFit ? window.taFit('TA 邀请听歌') : 'TA 邀请听歌') + '</button>' +
'</div>';
if (hisSubTab === 'mine') {
const h = myHistory.slice().reverse();
el.innerHTML = subBar + (h.length
? h.map(renderHistoryItem).join('')
: '<div class="ta-empty">还没有听歌记录，你播放过的歌会记在这里</div>');
} else {
const h = history.slice().reverse();
el.innerHTML = subBar + (h.length
? h.map(renderHistoryItem).join('')
: '<div class="ta-empty">' + (window.taFit ? window.taFit('还没有梦角邀请听歌记录，TA 邀请你一起听歌的记录会出现在这里') : '还没有梦角邀请听歌记录，TA 邀请你一起听歌的记录会出现在这里') + '</div>');
}
el.querySelectorAll('.sm-his-subtab').forEach(btn => {
btn.addEventListener('click', () => {
const v = btn.dataset.hissub;
if (v === hisSubTab) return;
hisSubTab = v;
renderHistory();
});
});
}
function renderPage() {
renderLibFilter();
renderLibrary();
renderPlaylists();
renderFavList();
renderTaFavList();
syncTaFavTab();
renderHistory();
updatePlayerBar();
syncFloatToggle();
}
let curObjectUrl = null;
function revokeObjectUrl() {
if (curObjectUrl) { try { URL.revokeObjectURL(curObjectUrl); } catch (e) {} curObjectUrl = null; }
}
function dataUrlToBlob(dataUrl) {
const manual = () => new Promise((resolve, reject) => {
try {
const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
if (!m) { reject(new Error('bad data url')); return; }
const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
const bytes = new Uint8Array(raw.length);
for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
resolve(new Blob([bytes], { type: m[1] || 'audio/mpeg' }));
} catch (e) { reject(e); }
});
if (typeof fetch === 'function') {
return fetch(dataUrl).then(r => r.blob()).catch(() => manual());
}
return manual();
}
function blobToDataUrl(blob) {
return new Promise((resolve) => {
const fr = new FileReader();
fr.onload = () => resolve(fr.result || '');
fr.onerror = () => resolve('');
try { fr.readAsDataURL(blob); } catch (e) { resolve(''); }
});
}
function playLocal(m, v) {
if (currentId !== m.id) return;
if (!(v instanceof Blob) && !validAudioSrc(v)) {
toast('播放失败：音频数据无效'); wantPlay = false; clearBgResume(); currentId = null; updatePlayerBar(); renderLibrary();
return;
}
let failoverUsed = false; // 防止 blob:↔dataURL 之间无限切换
let lastErrCode = 0;
const failMsg = () => lastErrCode === 4
? '放不了这个文件：编码不被本机浏览器支持（常见于加密格式或无损 m4a）——建议转成 mp3 再重新上传'
: '播放失败：浏览器无法加载音频';
function startWithSrc(src, isBlob) {
if (currentId !== m.id) return;
lastErrCode = 0;
if (isBlob) { revokeObjectUrl(); curObjectUrl = src; }
audio = createAudio();;
try { audio.addEventListener('error', function () { lastErrCode = (audio && audio.error) ? audio.error.code : 0; }); } catch (e) {}
audio.src = src;
startPlayback(m);
let wd = setTimeout(() => {
wd = null;
if (currentId !== m.id || !audio) return; // 已切歌/已 teardown
if (audio.currentTime > 0) return; // 已在播，blob:/dataURL 成功
if (lastErrCode === 4) { // #700：编码解不动＝重试徒劳，直接精确报错
toast(failMsg());
try { audio.pause(); } catch (e) {}
try { syncPlayIcons(false); } catch (e) {}
return;
}
if (failoverUsed) { // 两种 src 都失败
toast(failMsg());
try { audio.pause(); } catch (e) {}
try { syncPlayIcons(false); } catch (e) {}
return;
}
failoverUsed = true;
teardownAudio();
if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
if (isBlob) {
const dataUrlP = (v instanceof Blob) ? blobToDataUrl(v) : Promise.resolve(v);
dataUrlP.then(dataUrl => {
if (currentId !== m.id) return;
if (!dataUrl) { toast('播放失败：浏览器无法加载音频'); currentId = null; updatePlayerBar(); renderLibrary(); return; }
startWithSrc(dataUrl, false);
});
} else {
const blobP = (v instanceof Blob) ? Promise.resolve(v) : dataUrlToBlob(v);
blobP.then(blob => {
if (currentId !== m.id) return;
try { startWithSrc(URL.createObjectURL(blob), true); } catch (e) { toast('播放失败：浏览器无法加载音频'); }
}).catch(() => { toast('播放失败：浏览器无法加载音频'); currentId = null; updatePlayerBar(); renderLibrary(); });
}
}, 4000);
if (audio) audio.addEventListener('play', () => { if (wd) { clearTimeout(wd); wd = null; } }, { once: true });
}
if (v instanceof Blob) {
try { startWithSrc(URL.createObjectURL(v), true); } catch (e) { toast('播放失败：浏览器无法加载音频'); }
} else {
startWithSrc(v, false);
}
}
let liveAudioEls = [];
function killAudioEl(a) {
try { a.onended = null; a.onerror = null; a.onloadedmetadata = null; a.onplay = null; a.onpause = null; a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {}
try { if (a.parentNode) a.parentNode.removeChild(a); } catch (e) {}
}
function createAudio() {
liveAudioEls.forEach(killAudioEl);
liveAudioEls = [];
const a = new Audio();
try { a.style.display = 'none'; document.body.appendChild(a); } catch (e) {}
liveAudioEls.push(a);
try { window.__mochiMusic = { el: a, want: function () { return !!wantPlay; } }; } catch (e) {}
return a;
}
function validAudioSrc(v) {
return typeof v === 'string' &&
(/^https?:\/\//i.test(v) || /^blob:/i.test(v) || /^data:/i.test(v));
}
function plausibleLocalValue(v) {
if (v instanceof Blob) return true;
if (typeof v === 'string') return v.length >= 10;
return false;
}
function purgeLocalFile(m) {
try { if (localBlobCache) delete localBlobCache[m.id]; } catch (e) {}
try { store.remove('music-file:' + m.id); } catch (e) {} // 内存缓存+LS+IDB(default 前缀)
try { localStorage.removeItem('xy-home-v2:music-file:' + m.id); } catch (e) {} // 旧 uid 前缀
try { if (window.idbDelete) window.idbDelete('xy-home-v2:music-file:' + m.id); } catch (e) {}
}
function teardownAudio() {
if (audio) { killAudioEl(audio); audio = null; }
liveAudioEls.forEach(killAudioEl);
liveAudioEls = [];
revokeObjectUrl();
playRejected = false;
endedHandled = false;
bufferLatchEl = null; // #795：缓冲锁是「这个元素」的属性，换曲不得继承
disarmAutoResume();
clearBgResume();
clearStallGuard();
bgBrokeAudio = false; // v3.29.x：切歌/停止清后台断流标记
clearTaFavTimer();
cancelTaPause();
if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
setTimeout(function () {
if (!audio && !currentId) {
try { if (navigator.mediaSession) navigator.mediaSession.playbackState = 'none'; } catch (e) {}
try { document.dispatchEvent(new Event('music-media-release')); } catch (e) {}
}
}, 0);
}
function seedIdxOf(m) {
const seedId = m ? String(m.neteaseId || '') : '';
if (seedId === '2613048732') return 0;
if (seedId === '27538343') return 1;
return -1;
}
let demoFallbackBusy = false; // 防止外链失败 → demo 失败 → 再走 demo 的递归
function playDemoFor(m, seedIdx) {
genDemoAudio(seedIdx).then(d => {
if (!d) { failExpectedPlayback(m.id); toast('播放失败：网络链接可能已失效，或该歌曲为VIP付费歌曲'); demoFallbackBusy = false; wantPlay = false; clearBgResume(); return; }
try { window.idbSet(MUSIC_PREFIX + ':music-file:' + m.id, d); } catch (e) {}
demoFallbackBusy = false;
if (currentId !== m.id) return;
teardownAudio();
if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
playLocal(m, d);
});
}
function startPlayback(m) {
if (!audio) return;
const el = audio; // #795：本条链路的所有异步回调只认这个元素（切歌后旧元素的拒绝回调不得动新歌）
el.preload = 'auto';
setupHandlers(m);
if (callHoldPending) { try { syncPlayIcons(false); } catch (e) {} return; }
taActive = true;
wantPlay = true; // v3.10.x：用户点播/切歌＝意图播放（外部打断时自动续播的依据）
const resumeOnMetadata = !!(accountResumeSeek && m && accountResumeSeek.id === m.id &&
accountResumeSeek.serial === accountPlaySerial);
const p = resumeOnMetadata ? new Promise((resolve, reject) => {
const begin = () => {
if (el !== audio || currentId !== m.id || !wantPlay) { resolve(); return; }
try { Promise.resolve(el.play()).then(resolve, reject); } catch (e) { reject(e); }
};
if (el.readyState >= 1) {
if (accountResumeSeek && accountResumeSeek.id === m.id && accountResumeSeek.serial === accountPlaySerial) {
try { el.currentTime = accountResumeSeek.at; accountResumeSeek = null; } catch (e) {}
}
begin();
}
else {
el.addEventListener('loadedmetadata', begin, { once: true });
try { el.load(); } catch (e) { reject(e); }
}
}) : el.play();
if (p && p.catch) {
p.catch((err) => {
if (!audio || el !== audio) return;
if (err && err.name !== 'NotAllowedError') {
if (err.name === 'AbortError' && el.paused && wantPlay &&
Date.now() < inviteResumeGuardUntil) {
armInvitePlayCheck();
return;
}
if (httpsRetrying || demoFallbackBusy) return;
if (m && m.neteaseAccount) { accountPlaybackFailed(m.id); return; }
if (document.hidden) {
bgBrokeAudio = true;
playRejected = true;
scheduleBgResume();
return;
}
if (m && m.neteaseId && !m._httpsRetried) {
if (retryWithHttpsUrl(m)) return;
}
demoFallbackOrError(m);
return;
}
try { el.muted = true; } catch (e) {}
const p2 = el.play();
if (p2 && p2.then) {
p2.then(() => {
if (el === audio) el.muted = false; // 静音解锁成功 → 恢复出声（过期元素不动）
playRejected = false;
clearStallGuard();
disarmAutoResume();
try { syncPlayIcons(true); } catch (e) {}
}).catch((e2) => {
if (el === audio) { try { el.muted = false; } catch (e) {} }
handlePlayReject(e2);
});
} else {
handlePlayReject(err);
}
});
}
armStallGuard(m);
updatePlayerBar();
renderLibrary();
startProgress();
addMyRecord(m.id);
scheduleTaFavCheck(m);
scheduleTaPauseIfLucky();
updateMediaSession(true);
}
let autoResumeArmed = false;
function armAutoResume() {
if (autoResumeArmed) return;
autoResumeArmed = true;
const retry = function () {
disarmAutoResume();
if (!currentId) return;
if (httpsRetrying || demoFallbackBusy) return;
const m = findTrack(currentId);
if (!m) return;
if (m.neteaseAccount) {
const el = audio;
const at = Math.max(el && Number.isFinite(el.currentTime) ? el.currentTime : 0,
accountLastPosition && accountLastPosition.id === m.id ? accountLastPosition.at : 0);
if (el && !accountStreamStale) {
try {
const p = el.play();
if (p && p.catch) p.catch(() => {
if (audio !== el || currentId !== m.id) return;
accountLastPosition = { id: m.id, at };
accountRecoveryAttempted = false;
recoverAccountStream(m);
});
return;
} catch (e) {}
}
accountLastPosition = { id: m.id, at };
accountRecoveryAttempted = false;
recoverAccountStream(m);
return;
}
if (m.source === 'local' || (!m.url && m.source !== 'url')) {
try { playTrack(currentId); } catch (e) {}
return;
}
try { if (audio) { audio.pause(); audio.onended = null; audio.onerror = null; audio.onloadedmetadata = null; audio.onplay = null; audio.onpause = null; if (audio.parentNode) audio.parentNode.removeChild(audio); } } catch (e) {}
audio = createAudio();
try { audio.referrerPolicy = 'no-referrer'; } catch (e) {}
audio.preload = 'auto';
setupHandlers(m);
audio.src = m.url;
const p2 = audio.play();
if (p2 && p2.catch) p2.catch(function () { armAutoResume(); });
};
document.addEventListener('pointerdown', retry, true);
document.addEventListener('touchend', retry, true);
document.addEventListener('click', retry, true);
document._mochiAutoResume = retry;
}
function disarmAutoResume() {
autoResumeArmed = false;
const retry = document._mochiAutoResume;
if (!retry) return;
document._mochiAutoResume = null;
document.removeEventListener('pointerdown', retry, true);
document.removeEventListener('touchend', retry, true);
document.removeEventListener('click', retry, true);
}
let wantPlay = false;
let bgBrokeAudio = false;
try {
Object.defineProperty(window, '__musicWantPlay', {
configurable: true,
get: function () { return wantPlay; }
});
} catch (e) {}
let bgResumeTimers = [];
let bgResumeFails = 0; // 连续补播失败计数（死链/持续拦截时封顶，防止看门狗无限拉取）
let bgResumeFailAt = 0; // 最近一次补播失败时刻；封顶后冷却 60s 清零重试一轮，后台不永久放弃
function clearBgResume() {
bgResumeTimers.forEach(clearTimeout);
bgResumeTimers = [];
}
function keepBgResumeAlive() {
if (!wantPlay || callHoldPending) return;
scheduleBgResume();
}
function scheduleBgResume() {
clearBgResume();
[300, 1500, 5000, 12000].forEach(function (d) {
bgResumeTimers.push(setTimeout(function () { tryResumePlayback(); }, d));
});
bgResumeTimers.push(setTimeout(keepBgResumeAlive,12000));
}
function tryResumePlayback() {
if (!wantPlay || callHoldPending) return;
if (bgResumeFails >= 6) {
if (Date.now() - bgResumeFailAt < 60000) return;
bgResumeFails = 0;
}
if (taPauseActive) return;
if (httpsRetrying || demoFallbackBusy) return;
const m = findTrack(currentId);
if (!m) { wantPlay = false; return; }
if (!audio || audio.ended) {
rebuildAndPlay(m);
return;
}
if (!audio.paused) return;
const el = audio; // #795：补播链路同样只认发起时的元素
const p = el.play();
if (p && p.then) {
p.then(function () { bgResumeFails = 0; }).catch(function () {
if (!audio || el !== audio) return; // v3.28.x：回调异步期间可能已 teardown（换源/切歌/停止）；#795 收紧成元素身份
try { el.muted = true; } catch (e) {}
const p2 = el.play();
if (p2 && p2.then) {
p2.then(function () { try { if (el === audio) el.muted = false; } catch (e) {} bgResumeFails = 0; })
.catch(function () { bgResumeFails++; bgResumeFailAt = Date.now(); rebuildAndPlay(m); });
} else { bgResumeFails++; bgResumeFailAt = Date.now(); rebuildAndPlay(m); }
});
}
}
function recoverAccountStream(m) {
if (!m || !m.neteaseAccount || currentId !== m.id || accountRecoveryAttempted) return false;
const liveAt = audio && Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
const at = Math.max(liveAt, accountLastPosition && accountLastPosition.id === m.id ? accountLastPosition.at : 0);
accountRecoveryAttempted = true;
accountRecoveryAt = Date.now();
accountStreamStale = false;
playTrack(m.id, false, !!(onlineAttempt && onlineAttempt.trackId === m.id), null, null, at);
return true;
}
function rebuildAndPlay(m) {
if (!wantPlay || !currentId || currentId !== m.id) return;
if (m.neteaseAccount) {
if (!accountRecoveryAttempted) recoverAccountStream(m);
else accountPlaybackFailed(m.id);
return;
}
if (!(m.source === 'url' && m.url)) return; // 本地 Blob 歌只走原元素续播
try { if (audio) { audio.onended = null; audio.onerror = null; audio.onloadedmetadata = null; audio.onplay = null; audio.onpause = null; audio.pause(); if (audio.parentNode) audio.parentNode.removeChild(audio); } } catch (e) {}
audio = createAudio();
try { audio.referrerPolicy = 'no-referrer'; } catch (e) {}
audio.preload = 'auto';
setupHandlers(m);
audio.src = m.url;
const p = audio.play();
if (p && p.catch) p.catch(function () { bgResumeFails++; bgResumeFailAt = Date.now(); });
}
function resumeOnForeground() {
if (bgBrokeAudio && wantPlay && currentId && !callHoldPending && !taPauseActive && !httpsRetrying && !demoFallbackBusy) {
bgBrokeAudio = false;
try {
const m = findTrack(currentId);
if (m && m.neteaseAccount) recoverAccountStream(m);
else playTrack(currentId);
} catch (e) {}
return;
}
bgBrokeAudio = false;
try { tryResumePlayback(); } catch (e) {}
}
['visibilitychange', 'focus'].forEach(function (ev) {
document.addEventListener(ev, function () {
if (document.visibilityState !== 'visible') return;
failMap = {}; bgResumeFails = 0; // v3.x：从别的应用切回浏览器时，后台停滞触发的播放失败不算连续失败，避免误报"会员/移出"；v3.26.x：补播失败封顶一并清零，回前台才真正发起续播
setTimeout(resumeOnForeground, 200);
});
});
window.addEventListener('pageshow', function () {
failMap = {}; bgResumeFails = 0; // v3.26.x：见 visibilitychange 同款——回前台重置补播失败封顶
setTimeout(resumeOnForeground, 200);
});
setInterval(function () {
try { if (document.hidden) tryResumePlayback(); } catch (e) {}
}, 10000);
let lastGestureAt = 0;
['pointerdown', 'touchend', 'keydown', 'mousedown'].forEach(function (ev) {
document.addEventListener(ev, function () { lastGestureAt = Date.now(); }, { capture: true, passive: true });
});
function recentUserGesture() { return Date.now() - lastGestureAt < 4000; }
function handlePlayReject(err) {
playRejected = true;
if (httpsRetrying || demoFallbackBusy) return;
const blocked = !err ||
err.name === 'NotAllowedError' ||
/NotAllowedError/i.test(String(err.message || ''));
if (recentUserGesture()) {
if (blocked) {
toast('点击播放被浏览器拦截，请再点一下屏幕继续播放');
} else {
const cm = findTrack(currentId);
toast(cm && cm.source === 'url' && cm.url
? '在线歌曲加载失败：可能为会员歌曲、链接失效，或网络无法访问音乐源；可换一首或切换网络试试'
: '播放失败，请再点一下屏幕重试');
}
armAutoResume();
} else {
armAutoResume();        // 用户下次任意触摸即恢复（不弹提示）
scheduleBgResume();     // 定时补播先试，多数自动切歌场景直接救回
}
}
let stallTimer = null;
let playRejected = false;
function mediaStillLoading(a) {
if (!a) return false;
try {
return a.readyState > 0 || (a.buffered && a.buffered.length > 0) || a.networkState === 2;
} catch (e) { return false; }
}
let bufferLatchEl = null;
function musicBuffering() {
if (!audio || audio.paused) return false;
if (bufferLatchEl === audio) return true;
try {
return !(audio.readyState >= 3 || (audio.buffered && audio.buffered.length > 0));
} catch (e) { return false; }
}
function clearStallGuard() {
if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
}
function armStallGuard(m) {
clearStallGuard();
if (!m || (m.source !== 'url' && !m.url)) return;
const armedEl = audio; // #795：守卫认元素身份——同一首歌换源重建后，旧定时器不得再动新元素
stallTimer = setTimeout(function () {
stallTimer = null;
try {
if (!audio || armedEl !== audio) return;
if (currentId !== m.id) return;
if (audio.currentTime > 0) return;
if (playRejected) return; // 等手势恢复播放，不误判外链失败
if (audio.paused) return; // 用户主动暂停，不兜底
try {
if (mediaStillLoading(audio)) {
syncPlayIcons(true); // 补一次刷新：让守卫与界面每次都回到同一口径
armStallGuard(m);
return;
}
} catch (e) {}
if (m.id === temporaryOnlineId) { offerRemoveDamagedSong(m); return; }
if (m && m.neteaseId && !httpsRetrying) {
if (retryWithHttpsUrl(m)) return;
}
const idx = seedIdxOf(m);
if (idx >= 0 && !demoFallbackBusy) {
demoFallbackBusy = true;
toast('外链播放失败，已改用内置示例旋律');
playDemoFor(m, idx);
} else if (idx < 0) {
offerRemoveDamagedSong(m);
}
} catch (e) {}
}, 12000);
}
function neteaseMetingUrl(id) {
return 'https://api.injahow.cn/meting/?type=url&id=' + encodeURIComponent(String(id));
}
function resolveNeteaseDirectUrl(m, cb) {
try {
let controller;
try { controller = new AbortController(); } catch (e) { controller = null; }
const timer = setTimeout(() => { try { controller && controller.abort(); } catch (e) {} }, 8000);
fetch(neteaseMetingUrl(m.neteaseId), controller ? { signal: controller.signal } : undefined)
.then(function (r) {
clearTimeout(timer);
var ct = '';
try { ct = (r.headers && r.headers.get('content-type')) || ''; } catch (e) {}
var ok = !!(r.redirected || /^audio\//i.test(ct));
var finalUrl = ok ? ((r.url || '').replace(/^http:/i, 'https:')) : null;
setTimeout(function () {
try { controller && controller.abort(); } catch (e) {}
mochiSafeCancelBody(r); // #284：cancel() 拒绝安全（见函数头注释）
cb(finalUrl);
}, 0);
})
.catch(function () { clearTimeout(timer); cb(null); });
} catch (e) { cb(null); }
}
let httpsRetrying = false;
function neteaseOuterUrl(id) {
return 'https://music.163.com/song/media/outer/url?id=' + encodeURIComponent(String(id));
}
function retryWithHttpsUrl(m) {
if (httpsRetrying || !m || m.id === temporaryOnlineId || !m.neteaseId || m._httpsRetried) return false;
m._httpsRetried = true;
httpsRetrying = true;
toast('正在获取完整版直链…');
try {
if (audio) { audio.onerror = null; audio.onended = null; audio.onloadedmetadata = null; }
} catch (e) {}
teardownAudio();
resolveNeteaseDirectUrl(m, function (directUrl) {
httpsRetrying = false;
if (currentId !== m.id) { demoFallbackOrError(m); return; }
if (!wantPlay || callHoldPending) { teardownAudio(); try { syncPlayIcons(false); } catch (e) {} return; }
audio = createAudio();
try { audio.referrerPolicy = 'no-referrer'; } catch (e) {}
if (directUrl) {
audio.src = directUrl;
} else {
audio.src = neteaseOuterUrl(m.neteaseId);
}
startPlayback(m);
});
return true;
}
function offerRemoveDamagedSong(m) {
if (!m) return;
if (m.id === temporaryOnlineId) {
if (expectedPlayback && expectedPlayback.id === m.id) failExpectedPlayback(m.id);
else finishTemporaryOnlineFailure(m.id, temporaryOnlinePrompt);
return;
}
if (document.hidden) { bgBrokeAudio = true; return; } // v3.26.x：后台冻结/断流误触发 onerror，不弹「移出」窗不计数；v3.29.x：标记后台断流，切回前台重建
const watched = !!(expectedPlayback && expectedPlayback.id === m.id);
wantPlay = false; clearBgResume(); // v3.10.x：真失败＝停止意图，不再自动续播
try { if (audio) audio.pause(); } catch (e) {}
try { syncPlayIcons(false); } catch (e) {}
if (watched) { failExpectedPlayback(m.id); return; }
const cnt = (failMap[m.id] || 0) + 1;
failMap[m.id] = cnt;
if (cnt < 2) {
try { toast('播放失败（可能为会员/失效歌曲），可以在播放列表换一首歌试试'); } catch (e) {}
return;
}
if (!window.openModal) return;
try {
window.openModal('「' + (m.name || '这首歌') + '」播放失败', '', () => {
library = library.filter(function (x) { return x.id !== m.id; });
if (currentId === m.id) { teardownAudio(); currentId = null; }
saveLibrary();
renderPage();
toast('已移出音乐库');
}, { noInput: true, staticText: '连续播放失败，可能是会员/付费歌曲或链接已失效。可以在播放列表换一首歌点击播放恢复播放，或把它移出音乐库。' });
} catch (e) {}
}
function demoFallbackOrError(m) {
if (m && m.id === temporaryOnlineId) { offerRemoveDamagedSong(m); return; }
const idx = seedIdxOf(m);
if (idx >= 0 && !demoFallbackBusy) {
demoFallbackBusy = true;
toast('外链播放失败，已改用内置示例旋律');
playDemoFor(m, idx);
return;
}
if (idx >= 0) return; // 兜底合成/播放进行中，静默等待结果
offerRemoveDamagedSong(m);
}
let endedHandled = false;
function playNextLocalAfterReservation(id) {
const list = playableList(id);
if (!list.length) return;
const index = list.findIndex(track => track.id === id);
const nextId = mode === 'single' && index >= 0 ? id
: mode === 'shuffle' ? list[Math.floor(Math.random() * list.length)].id
: list[(index + 1) % list.length].id;
playTrack(nextId);
}
function finishTaReservation(id) {
if (recommendationSession) { if (playQueue.length) next(); else nextRecommendation(true); return; }
const fallback = () => playNextLocalAfterReservation(id);
if (window.mochiNeteaseResumeAfterReservation && window.mochiNeteaseResumeAfterReservation(fallback)) return;
fallback();
}
function handleEnded() {
if (endedHandled) return;
endedHandled = true;
revokeObjectUrl();
const endedReservationId = currentId === currentTaReservationId ? currentId : null;
const endedInviteId = currentId === inviteReturnTrackId ? currentId : null;
const endedOnlineInvite = currentId === temporaryOnlineId && onlineAttempt &&
onlineAttempt.trackId === currentId && !onlineAttempt.reservation &&
onlineAttempt.recordType === '接受了 TA 的在线听歌邀请';
const styleAttempt = onlineAttempt && onlineAttempt.styleStream &&
onlineAttempt.trackId === currentId ? onlineAttempt : null;
currentTaReservationId = null;
inviteReturnTrackId = null;
if (currentId === temporaryOnlineId) {
if (onlineAttempt && onlineAttempt.trackId === currentId && !styleAttempt) onlineAttempt = null;
temporaryOnlineId = null;
temporaryOnlineCreatedId = null;
temporaryOnlinePrompt = '';
temporaryOnlineBackup = null;
if (styleAttempt) {
styleAttempt.failureStreak = 0;
styleAttempt.lastTrackId = currentId;
styleAttempt.trackId = null;
void tryNextOnlineCandidate(styleAttempt);
return;
}
if (endedReservationId || endedOnlineInvite) { finishTaReservation(currentId); return; }
if (recommendationSession) { next(); return; }
if (window.mochiNeteaseResumeAfterLocal && window.mochiNeteaseResumeAfterLocal()) return;
if (playQueue.length) { next(); return; }
}
if (endedReservationId || endedInviteId) { finishTaReservation(currentId); return; }
if (playQueue.length) { next(); return; }
if (recommendationSession && !recommendationSession.ids.includes(currentId)) { nextRecommendation(true); return; }
if (!recommendationSession && window.mochiNeteaseResumeAfterLocal && window.mochiNeteaseResumeAfterLocal()) return;
let handled = false;
try { handled = maybeTAAutoAction(); } catch(e) {}
if (!handled) next();
}
function checkAutoEnd() {
if (!audio || endedHandled || audio.paused) return;
if (audio.ended) { handleEnded(); return; }
const d = audio.duration;
if (!d || !isFinite(d)) return;
if (audio.currentTime > 0 && audio.currentTime >= d - 0.15) handleEnded();
}
function updateMediaSession(playing) {
try {
if (!('mediaSession' in navigator) || !navigator.mediaSession) return;
const m = findTrack(currentId);
if (!m) return;
if (window.MediaMetadata) {
const artwork = m.cover ? [{ src: m.cover, sizes: '512x512', type: 'image/jpeg' }] : [];
navigator.mediaSession.metadata = new window.MediaMetadata({
title: m.name || '未知歌曲',
artist: m.artist || '未知歌手',
album: 'CiCi 音乐',
artwork: artwork
});
}
try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) {}
try {
navigator.mediaSession.setActionHandler('play', function () { try { toggle(); } catch (e) {} });
navigator.mediaSession.setActionHandler('pause', function () { try { toggle(); } catch (e) {} });
navigator.mediaSession.setActionHandler('nexttrack', function () { try { next(); } catch (e) {} });
navigator.mediaSession.setActionHandler('previoustrack', function () { try { prev(); } catch (e) {} });
} catch (e) {}
try {
navigator.mediaSession.setActionHandler('seekbackward', function (d) { try { if (audio) audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); } catch (e) {} });
navigator.mediaSession.setActionHandler('seekforward', function (d) { try { if (audio) audio.currentTime = Math.min(isFinite(audio.duration) ? audio.duration : Infinity, audio.currentTime + ((d && d.seekOffset) || 10)); } catch (e) {} });
navigator.mediaSession.setActionHandler('seekto', function (d) { try { if (audio && d && isFinite(d.seekTime)) audio.currentTime = Math.max(0, Math.min(isFinite(audio.duration) ? audio.duration : Infinity, d.seekTime)); } catch (e) {} });
navigator.mediaSession.setActionHandler('stop', function () { try { stopFromMediaSession(); } catch (e) {} });
} catch (e) {}
try { syncMediaPosition(); } catch (e) {}
try { window.__musicPlaying = playing; } catch (e) {}
} catch (e) {}
}
function syncMediaPosition() {
try {
if (!('mediaSession' in navigator) || !navigator.mediaSession || !navigator.mediaSession.setPositionState) return;
if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return;
navigator.mediaSession.setPositionState({
duration: audio.duration,
playbackRate: audio.playbackRate > 0 ? audio.playbackRate : 1,
position: Math.min(Math.max(audio.currentTime, 0), audio.duration)
});
} catch (e) {}
}
function stopFromMediaSession(keepTogether = false) {
if (onlineAttempt) { onlineAttempt = null; onlineSearchSerial++; }
temporaryOnlineId = null;
temporaryOnlineCreatedId = null;
temporaryOnlinePrompt = '';
temporaryOnlineBackup = null;
currentTaReservationId = null;
inviteReturnTrackId = null;
clearExpectedPlayback();
wantPlay = false;
try { window.__musicPlaying = false; } catch (e) {}
clearBgResume();
teardownAudio();
currentId = null;
const temporaryIds = new Set(sessionTracks.keys());
playQueue = playQueue.filter(id => !temporaryIds.has(id));
recommendationSession = null;
sessionTracks.clear();
if (!keepTogether) pauseTogetherSession();
updatePlayerBar();
renderLibrary();
}
window.mochiMusicStopForRemote = () => stopFromMediaSession(true);
window.mochiMusicHasLocalPlayback = function () { return !!currentId; };
window.mochiMusicLocalPlaybackSnapshot = function () {
const track = findTrack(currentId);
return track ? {
title: String(track.name || '未知歌曲'), artist: String(track.artist || ''),
cover: String(track.cover || ''), playing: !!(audio && !audio.paused), loading: !audio
} : null;
};
window.mochiMusicControlLocal = function (action) {
if (!currentId) return false;
if (action === 'toggle' && !audio) return false;
if (action === 'previous') prev();
else if (action === 'next') next();
else if (action === 'toggle') toggle();
else return false;
return true;
};
window.mochiMusicRemoteFloatAllowed = function () { return !!(settings.floatEn && !floatClosed && !floatOwnSurfaceShown()); };
window.mochiMusicRestoreLocalUI = function () {
updatePlayerBar();
renderFloat();
if (currentId) return;
const song = document.getElementById('mw-song');
const artist = document.getElementById('mw-artist');
if (song) song.textContent = '未在播放';
if (artist) artist.textContent = '音乐';
setWidgetCover(null);
syncPlayIcons(false);
['mw-cur', 'mw-dur'].forEach(function (id) {
const node = document.getElementById(id);
if (node) node.textContent = '0:00';
});
const fill = document.getElementById('mw-fill');
const knob = document.getElementById('mw-knob');
if (fill) fill.style.width = '0%';
if (knob) knob.style.left = '0%';
};
function setupHandlers(m) {
const el = audio;
el.onended = function () { if (el !== audio) return; handleEnded(); };
el.onerror = function () {
if (el !== audio) return;
if (m && m.neteaseAccount) {
accountStreamStale = true;
if (wantPlay) {
if (!accountRecoveryAttempted) recoverAccountStream(m);
else accountPlaybackFailed(m.id);
}
return;
}
if (document.hidden) bgBrokeAudio = true;
if (m && m.neteaseId && !httpsRetrying) {
if (retryWithHttpsUrl(m)) return;
}
if (httpsRetrying) return; // 正在拉直链，等结果
demoFallbackOrError(m);
};
el.onloadedmetadata = function () {
if (el !== audio) return;
const dur = el.duration || 0;
if (m && m.neteaseAccount && Number(m.duration) >= 90 &&
Number.isFinite(dur) && dur > 0 && dur <= 65 && dur < Number(m.duration) * 0.6) {
accountPlaybackFailed(m.id);
return;
}
if (m && m.id === temporaryOnlineId && Number(m.duration) >= 90 &&
Number.isFinite(dur) && dur > 0 && dur <= 65 && dur < Number(m.duration) * 0.6) {
finishTemporaryOnlineFailure(m.id);
return;
}
if (accountResumeSeek && accountResumeSeek.id === m.id &&
accountResumeSeek.serial === accountPlaySerial && el === audio) {
const at = accountResumeSeek.at;
try {
el.currentTime = Number.isFinite(dur) && dur > 0 ? Math.min(at, Math.max(0, dur - 1)) : at;
accountResumeSeek = null;
} catch (e) { /* canplay 再试 */ }
}
const el2 = document.getElementById('sm-pb-dur');
if (el2) el2.textContent = fmtDur(dur);
if (m && dur) { m.duration = dur; saveLibrary(); updateDurUI(m.id, dur); }
if (playRejected && currentId === m.id) {
playRejected = false;
try { el.muted = true; } catch (e) {}
const p2 = el.play();
if (p2 && p2.then) {
p2.then(() => { if (el === audio) el.muted = false; }).catch(() => {
playRejected = true;
try { syncPlayIcons(false); } catch (e) {}
armAutoResume();
});
} else { armAutoResume(); }
}
};
el.ontimeupdate = function () {
if (el !== audio) return;
if (m && m.neteaseAccount && Number.isFinite(el.currentTime))
accountLastPosition = { id: m.id, at: Math.max(0, el.currentTime) };
if (m && m.neteaseAccount && !el.paused && accountRecoveryAttempted && Date.now() - accountRecoveryAt > 5000)
accountRecoveryAttempted = false;
try { syncMediaPosition(); } catch (e) {}
};
el.onseeked = function () {
if (el === audio && m && m.neteaseAccount && Number.isFinite(el.currentTime))
accountLastPosition = { id: m.id, at: Math.max(0, el.currentTime) };
};
el.addEventListener('waiting', function () { if (el !== audio) return; bufferLatchEl = el; syncPlayIcons(!el.paused); });
el.addEventListener('stalled', function () { if (el !== audio) return; bufferLatchEl = el; syncPlayIcons(!el.paused); });
el.addEventListener('playing', function () { if (el !== audio) return; bufferLatchEl = null; syncPlayIcons(true); if (m && m.neteaseAccount && recommendationSession) recommendationSession.failures = 0; if (expectedPlayback && expectedPlayback.id === m.id) clearExpectedPlayback(); if (onlineAttempt && onlineAttempt.trackId === m.id && !onlineAttempt.recorded) { onlineAttempt.recorded = true; addRecord(m.id, onlineAttempt.recordType); } if (inviteFlow && (inviteFlow.localTrackId === m.id || (onlineAttempt && onlineAttempt.flow === inviteFlow && onlineAttempt.trackId === m.id) || inviteFlow.waiting)) finishMusicInviteFlow(inviteFlow); });
el.addEventListener('canplay', function () {
if (el !== audio) return;
if (accountResumeSeek && accountResumeSeek.id === m.id && accountResumeSeek.serial === accountPlaySerial) {
try {
const dur = el.duration;
el.currentTime = Number.isFinite(dur) && dur > 0
? Math.min(accountResumeSeek.at, Math.max(0, dur - 1)) : accountResumeSeek.at;
accountResumeSeek = null;
} catch (e) {}
}
bufferLatchEl = null; syncPlayIcons(!el.paused);
});
el.onplay = function () { if (el !== audio) return; accountStreamStale = false; playRejected = false; bgResumeFails = 0; bufferLatchEl = null; clearStallGuard(); disarmAutoResume(); clearBgResume(); bgBrokeAudio = false; wantPlay = true; syncPlayIcons(true); if (m) failMap[m.id] = 0; try { if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; } catch (e) {} try { window.__musicPlaying = true; } catch (e) {} // #700：真播出来＝导入时的「放不了」探测是误报，自愈清除
if (m && m.probeFail) { try { delete m.probeFail; saveLibrary(); renderLibrary(); } catch (e) {} }; // v3.28.x：每次真正出声都重新绑定歌曲媒体条——后台短暂打断被 bg-keep 接管媒体会话（元数据换成「CiCi 后台保活」）后，恢复播放时若不重设歌曲元数据，通知栏媒体条会停在保活条或直接消失
try { updateMediaSession(true); } catch (e) {} };
el.onpause = function () { if (el !== audio) return; syncPlayIcons(false); try { if (navigator.mediaSession) navigator.mediaSession.playbackState = (wantPlay && !callHoldPending) ? 'playing' : 'paused'; } catch (e) {} try { window.__musicPlaying = false; } catch (e) {} // v3.28.x：外部打断（还想播）保持 playbackState='playing'，避免 Chrome 把页面当闲置标签冻结、通知栏媒体条消失；仅用户主动暂停才标 'paused'。v3.10.x：非用户暂停（后台省电/音频焦点抢占/系统打断）→ 定时补播反击
if (wantPlay && !callHoldPending && Date.now() < inviteResumeGuardUntil) armInvitePlayCheck();
if (wantPlay && !callHoldPending && !taPauseActive) scheduleBgResume(); };
}
function playTrack(id, fromWidget, fromUnifiedQueue, accountStreamUrl, streamSource, resumeAt) {
const m = findTrack(id);
if (!m) return;
if (window.mochiNeteaseUseLocal) window.mochiNeteaseUseLocal(fromUnifiedQueue === true);
const previousId = currentId;
const playSerial = ++accountPlaySerial;
if (!accountStreamUrl && resumeAt == null) accountRecoveryAttempted = false;
if (id !== previousId || (!accountStreamUrl && resumeAt == null)) accountLastPosition = null;
accountStreamStale = false;
accountResumeSeek = m.neteaseAccount && Number.isFinite(resumeAt) && resumeAt > 0
? { id, serial: playSerial, at: resumeAt } : null;
accountFailureSerial = -1;
accountPlaybackSource = accountStreamUrl ? String(streamSource || 'netease') : '';
if (recommendationSession) {
if (fromUnifiedQueue && !recommendationSession.ids.includes(id)) {
recommendationSession.ids.splice(recommendationSession.index + 1, 0, id);
}
const recommendationIndex = recommendationSession.ids.indexOf(id);
if (recommendationIndex >= 0) recommendationSession.index = recommendationIndex;
else if (!fromUnifiedQueue && id !== previousId) recommendationSession = null;
}
inviteReturnTrackId = null;
if (currentTaReservationId && currentTaReservationId !== id) currentTaReservationId = null;
if (inviteFlow && !inviteFlow.waiting && inviteFlow.localTrackId !== id &&
!(onlineAttempt && onlineAttempt.flow === inviteFlow && onlineAttempt.trackId === id)) finishMusicInviteFlow(inviteFlow);
if (onlineAttempt && (id !== onlineAttempt.trackId || fromUnifiedQueue !== true)) {
onlineAttempt = null;
onlineSearchSerial++;
}
if (temporaryOnlineId && (id !== temporaryOnlineId || fromUnifiedQueue !== true)) {
temporaryOnlineId = null;
temporaryOnlineCreatedId = null;
temporaryOnlinePrompt = '';
temporaryOnlineBackup = null;
}
failedPlaybackId = null;
if (expectedPlayback && expectedPlayback.id !== id) clearExpectedPlayback();
markFloatSource(fromWidget);
cancelTaPause();
if (m) m._httpsRetried = false;
currentId = id;
if (m && m.cover) { if (COVER_PROXY_RE.test(m.cover)) enqueueCovMig(m); }
else ensureSongCover(m);
teardownAudio();
if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
updatePlayerBar();
if (m.neteaseAccount && !accountStreamUrl) {
const api = window.ciciNeteaseEnhanced;
if (!api) { accountPlaybackFailed(id); return; }
api.resolveTrack(m)
.then(result => {
if (playSerial !== accountPlaySerial || currentId !== id) return;
if (result.songId && m.neteaseId !== result.songId) m.neteaseId = result.songId;
if (result.metadata) {
if (!m.duration && result.metadata.duration) m.duration = Number(result.metadata.duration) / 1000;
if (!m.cover && result.metadata.picUrl) m.cover = result.metadata.picUrl;
}
saveLibrary();
playTrack(id, fromWidget, fromUnifiedQueue, result.url, result.source, resumeAt);
})
.catch(() => { if (playSerial === accountPlaySerial && currentId === id) accountPlaybackFailed(id); });
return;
}
if (!m.neteaseAccount && (m.source === 'local' || (!m.url && m.source !== 'url'))) {
const key = MUSIC_PREFIX + ':music-file:' + m.id;
const markFileLost = () => { try { if (!m.fileLost) { m.fileLost = 1; saveLibrary(); } } catch (e) {} };
const loadLocal = (v) => {
if (currentId !== m.id) return;
if (plausibleLocalValue(v)) {
if (m.fileLost) { m.fileLost = 0; try { saveLibrary(); } catch (e) {} }
playLocal(m, v);
return;
}
if (v !== undefined && v !== null && v !== '') purgeLocalFile(m);
const idx = seedIdxOf(m);
if (idx >= 0) {
playDemoFor(m, idx);
return;
}
failExpectedPlayback(m.id);
markFileLost();
toast('音乐文件加载失败，可能已被清理');
if (currentId === m.id) { wantPlay = false; clearBgResume(); currentId = null; updatePlayerBar(); }
renderLibrary();
};
{
const cached = localBlobCache[m.id];
if (cached) { loadLocal(cached); return; }
const lsSync = store.get('music-file:' + m.id);
if (lsSync && !plausibleLocalValue(lsSync)) {
try { localStorage.removeItem(MUSIC_PREFIX + ':music-file:' + m.id); } catch (e) {}
try { localStorage.removeItem('xy-home-v2:music-file:' + m.id); } catch (e) {}
}
if (plausibleLocalValue(lsSync)) { localBlobCache[m.id] = lsSync; loadLocal(lsSync); return; }
}
if (window.idbGet) {
window.idbGet(key).then(v => {
if (currentId !== m.id) return; // 已切歌
if (v === undefined || v === null) {
const lsV = store.get('music-file:' + m.id);
if (lsV) { loadLocal(lsV); return; }
const legacyKey = 'xy-home-v2:music-file:' + m.id;
const legacyFallback = (v2) => {
if (currentId !== m.id) return;
if (v2 !== undefined && v2 !== null && v2 !== '') loadLocal(v2);
else failLocal();
};
const failLocal = () => { failExpectedPlayback(m.id); markFileLost(); toast('音乐文件加载失败，可能已被清理'); if (currentId === m.id) { wantPlay = false; clearBgResume(); currentId = null; updatePlayerBar(); } renderLibrary(); };
const oldLs = localStorage.getItem(legacyKey);
if (oldLs) { legacyFallback(oldLs); return; }
if (MUSIC_PREFIX !== 'xy-home-v2') {
window.idbGet(legacyKey).then(legacyFallback).catch(() => legacyFallback(null));
return;
}
setTimeout(() => {
if (currentId !== m.id) return; // 已切歌
window.idbGet(key).then(v2 => {
if (currentId !== m.id) return; // 已切歌
if (v2 !== undefined && v2 !== null) loadLocal(v2);
else failLocal();
});
}, 600);
} else { localBlobCache[m.id] = v; loadLocal(v); }
});
} else {
loadLocal(store.get('music-file:' + m.id));
}
return;
}
if (isNetShortLink(String(m.url || '')) && !m.neteaseId && !m._netShortDirty) {
m._netShortDirty = true; // 内存标记，避免每次点播都反复试（解析失败也不死循环）
resolveNetShortLink(m.url, rid => {
const cur = findTrack(currentId);
if (!cur || currentId !== m.id) return; // 已切歌
if (rid) {
cur.neteaseId = rid;
cur.url = neteaseMetingUrl(rid);
cur._netShortDirty = false;
saveLibrary();
renderLibrary();
playTrack(m.id, fromWidget);
return;
}
cur._netShortDirty = false;
toast('分享链接解析失败（解析服务受限）：可用浏览器打开这条链接，把地址栏里 music.163.com/song?id=数字 的完整链接或数字粘贴导入');
});
return;
}
audio = createAudio();
if (!validAudioSrc(accountStreamUrl || m.url)) {
if (m.neteaseAccount) { accountPlaybackFailed(id); return; }
offerRemoveDamagedSong(m);
return;
}
try { audio.referrerPolicy = 'no-referrer'; } catch (e) {}
audio.src = accountStreamUrl || m.url;
startPlayback(m);
}
function startProgress() {
if (progressTimer) clearInterval(progressTimer);
progressTimer = setInterval(() => {
if (!audio) return;
checkAutoEnd();
if (musicBuffering()) { syncPlayIcons(true); return; } // #795：缓冲期时间本该冻住，别用它盖掉「缓冲中」
if (!audio || !audio.duration) return;
if (audio.currentTime > 0) clearStallGuard();
const cur = document.getElementById('sm-pb-cur');
if (cur) cur.textContent = fmtDur(audio.currentTime);
const fill = document.getElementById('sm-f-fill');
if (fill) fill.style.width = Math.min(100, audio.currentTime / audio.duration * 100) + '%';
const fCur = document.getElementById('sm-f-cur');
if (fCur) fCur.textContent = fmtDur(audio.currentTime);
const fDur = document.getElementById('sm-f-dur');
if (fDur) fDur.textContent = fmtDur(audio.duration);
}, 500);
}
function toggle(fromWidget) {
markFloatSource(fromWidget);
if (!audio || !currentId) {
const songs = library.filter(m => !m.playlistId || m.playlistId === 'default');
if (songs.length) { playTrack(songs[0].id, fromWidget); return; }
toast('音乐库还没有歌曲');
return;
}
if (audio.paused) {
const el = audio; // #795：手势链异步回调期间可能已切歌，只认点击时那个元素
cancelTaPause();
if (accountStreamStale && findTrack(currentId) && findTrack(currentId).neteaseAccount) {
accountRecoveryAttempted = false;
recoverAccountStream(findTrack(currentId));
return;
}
const p = el.play();
if (p && p.catch) p.catch((err) => {
if (!audio || el !== audio) return; // v3.28.x：判空防 null.play()；#795 收紧成「还是不是我这个元素」
if (err && err.name !== 'NotAllowedError') {
if (httpsRetrying || demoFallbackBusy) return;
const tm = currentId ? findTrack(currentId) : null;
if (tm && tm.neteaseAccount) {
if (!accountRecoveryAttempted) recoverAccountStream(tm);
else accountPlaybackFailed(tm.id);
return;
}
if (tm && tm.neteaseId && !tm._httpsRetried) {
if (retryWithHttpsUrl(tm)) return;
}
if (tm) { demoFallbackOrError(tm); return; }
}
playRejected = true;
try { el.muted = true; } catch (e) {}
const p2 = el.play();
if (p2 && p2.then) {
p2.then(() => { if (el === audio) el.muted = false; playRejected = false; try { syncPlayIcons(true); } catch (e) {} })
.catch(() => {
if (el === audio) { try { el.muted = false; } catch (e) {} }
try { syncPlayIcons(false); } catch (e) {}
toast('点击播放被浏览器拦截，请再点一下屏幕继续播放');
armAutoResume();
});
} else { armAutoResume(); }
});
}
else { if (onlineAttempt && currentId === temporaryOnlineId) { onlineAttempt = null; clearExpectedPlayback(); } wantPlay = false; accountRecoveryAttempted = false; clearBgResume(); cancelTaPause(); pauseTogetherSession(); audio.pause(); } // 用户暂停仅隐藏陪听，保留 TA 当前在场状态和随机计时。
}
let callHoldPlaying = false;
let callHoldFloatShown = false;
let callHoldPending = false;
window.musicHoldForCall = function (hold) {
try {
const el = document.getElementById('sm-float');
if (hold) {
callHoldPlaying = !!(audio && !audio.paused);
callHoldFloatShown = !!(el && !el.hidden);
callHoldPending = !audio && !!currentId;
cancelTaPause();
if (audio && !audio.paused) { wantPlay = false; clearBgResume(); audio.pause(); } // v3.10.x：来电 hold＝清除意图，通话期间不自动续播
if (el) el.hidden = true;
} else {
if (audio && currentId && (callHoldPlaying || callHoldPending)) {
const p = audio.play();
if (p && p.catch) p.catch(() => {
playRejected = true;
if (!audio) return; // v3.28.x：判空防 null.play()（回调异步期间可能已 teardown）
try { audio.muted = true; } catch (e) {}
const p2 = audio.play();
if (p2 && p2.then) {
p2.then(() => { if (audio) audio.muted = false; playRejected = false; try { syncPlayIcons(true); } catch (e) {} })
.catch(() => { try { if (audio) audio.muted = false; } catch (e) {} try { syncPlayIcons(false); } catch (e) {} armAutoResume(); try { toast('点一下屏幕即可恢复音乐播放'); } catch (e) {} });
} else { armAutoResume(); }
});
}
callHoldPlaying = false;
callHoldPending = false;
if (callHoldFloatShown || (audio && currentId)) {
updatePlayerBar();
}
callHoldFloatShown = false;
}
} catch (e) {}
};
function playableList(trackId = currentId) {
if (recommendationSession && recommendationSession.ids.includes(trackId))
return recommendationSession.ids.map(findTrack).filter(Boolean);
const m = findTrack(trackId);
const pid = m ? m.playlistId : 'default';
let list = library.filter(x => x.playlistId === pid);
if (!list.length) list = library.slice();
const order = loadPlayOrder(pid);
if (order && order.length) {
const byId = {};
list.forEach(x => { byId[x.id] = x; });
const seen = {};
const sorted = [];
order.forEach(id => { if (byId[id] && !seen[id]) { sorted.push(byId[id]); seen[id] = true; } });
list.forEach(x => { if (!seen[x.id]) sorted.push(x); });
list = sorted;
}
return list;
}
function loadPlayOrder(pid) {
try { const o = JSON.parse(store.get('music-playorder') || '{}'); return (o && Array.isArray(o[pid])) ? o[pid] : null; } catch (e) { return null; }
}
function sessionPlayListId() {
if (recommendationSession) return recommendationSession.pid;
const m = findTrack(currentId);
return (m && (m.playlistId || 'default')) || 'default';
}
function naturalPlayOrder() {
if (recommendationSession) return recommendationSession.ids.slice();
const pid = sessionPlayListId();
let list = library.filter(x => x.playlistId === pid);
if (!list.length) list = library.slice();
return list.map(x => x.id);
}
function setPlayOrderView(newView) {
const pid = sessionPlayListId();
const queued = {};
playQueue.forEach(id => { queued[id] = true; });
let full = recommendationSession ? recommendationSession.ids.slice() : loadPlayOrder(pid) || naturalPlayOrder();
const newFull = [];
let vi = 0;
for (let o = 0; o < full.length; o++) {
const id = full[o];
if (queued[id]) newFull.push(id);
else { if (vi < newView.length) newFull.push(newView[vi]); vi++; }
}
for (; vi < newView.length; vi++) newFull.push(newView[vi]);
if (recommendationSession) {
recommendationSession.ids = newFull;
const currentIndex = newFull.indexOf(currentId);
if (currentIndex >= 0) recommendationSession.index = currentIndex;
return;
}
try {
const o = JSON.parse(store.get('music-playorder') || '{}');
o[pid] = newFull;
store.set('music-playorder', JSON.stringify(o));
} catch (e) {}
}
function addToQueue(id) {
const m = findTrack(id);
if (!m) return;
if (playQueue.indexOf(id) >= 0) { toast('这首歌已在播放队列'); return; }
if (currentId === id) { toast('这就是正在播放的歌'); return; }
playQueue.push(id);
renderQueueBadge();
}
function queuedTrack(id) { return findTrack(id) || onlineReservations.get(id) || null; }
function cancelOnlineReservation(id) {
const reservation = onlineReservations.get(id);
if (reservation) { reservation.cancelled = true; onlineReservations.delete(id); }
taReservedIds.delete(id);
}
function clearOnlineReservations() {
onlineReservations.forEach(item => { item.cancelled = true; });
onlineReservations.clear();
}
function onlineCandidates(songs, query, style) {
if (!Array.isArray(songs)) return [];
return songs.filter(song => song && song.id && song.name).sort((a, b) => {
const rank = song => {
const exact = style || String(song.name).trim().toLocaleLowerCase() === String(query).trim().toLocaleLowerCase();
const fee = Number(song.fee);
const free = song.fee != null && (fee === 0 || fee === 8);
return (exact ? 0 : 2) + (free ? 0 : 1);
};
return rank(a) - rank(b);
}).slice(0, style ? 30 : 3);
}
function onlinePreviewOnly(song, address) {
const data = address && address.data && address.data[0];
if (!data) return false;
if (data.freeTrialInfo && typeof data.freeTrialInfo === 'object') return true;
const fullMs = Number(song && song.duration);
const streamMs = Number(data.time || 0);
return fullMs >= 90000 && streamMs > 0 && streamMs <= 65000 && streamMs < fullMs * 0.6;
}
async function prepareOnlineReservation(reservation) {
const failureText = 'TA想听' + reservation.wantedText + '，需要你帮忙播放哦';
try {
const search = await onlineSongJson(reservation.style ? 'style' : 'search', reservation.query, reservation.endpoint);
if (reservation.cancelled || (window.__activeCid || 'default') !== reservation.cid) return false;
reservation.candidates = onlineCandidates(search.data && search.data.songs, reservation.query, reservation.style);
for (let i = 0; i < reservation.candidates.length && i < 3; i++) {
const song = reservation.candidates[i];
if (!song || !song.id || !song.name) continue;
let address;
try { address = await onlineSongJson('url', song, reservation.endpoint); }
catch (e) { continue; }
if (reservation.cancelled || (window.__activeCid || 'default') !== reservation.cid) return false;
const url = address.data && address.data[0] && address.data[0].url;
if (!validAudioSrc(url) || onlinePreviewOnly(song, address)) continue;
let lrc = '';
try {
const lyric = await onlineSongJson('lyric', String(song.id), reservation.endpoint);
lrc = lyric.data ? String(lyric.data.lrc || '') : '';
} catch (e) {}
if (reservation.cancelled || (window.__activeCid || 'default') !== reservation.cid) return false;
const neteaseId = String(song.id);
let track = library.find(item => item.playlistId === 'spl_default' && String(item.neteaseId || '') === neteaseId);
const created = !track;
reservation.original = track ? { url: track.url, source: track.source, lrc: track.lrc, hasLrc: Object.prototype.hasOwnProperty.call(track, 'lrc') } : null;
if (!track) {
track = {
id: 'sm_online_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
neteaseId, name: String(song.name), artist: String(song.artists || ''),
cover: String(song.picUrl || '').replace(/^http:/i, 'https:'),
url, source: 'url', neteaseAccount: !!(window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn()), duration: Number(song.duration || 0) / 1000,
lrc, playlistId: 'spl_default', addedAt: Date.now()
};
library.push(track);
} else {
track.url = url;
track.source = 'url';
track.neteaseAccount = !!(window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn());
if (lrc) track.lrc = lrc;
}
reservation.first = { song, url, lrc, index: i, trackId: track.id, created };
reservation.initialFailures = i;
saveLibrary();
renderPage();
if (!reservation.consumed) {
const index = playQueue.indexOf(reservation.id);
if (index >= 0) {
playQueue[index] = track.id;
onlineReservations.delete(reservation.id);
onlineReservations.set(track.id, reservation);
taReservedIds.delete(reservation.id);
taReservedIds.add(track.id);
renderQueueBadge();
}
}
return true;
}
} catch (e) {}
if (!reservation.cancelled && (window.__activeCid || 'default') === reservation.cid) {
playQueue = playQueue.filter(id => id !== reservation.id);
onlineReservations.delete(reservation.id);
taReservedIds.delete(reservation.id);
renderQueueBadge();
playbackPrompt(failureText);
}
return false;
}
function reserveOnlineSong(candidate) {
const keyword = candidate.source === 'musicKeyword' ? String(candidate.keyword || '').trim() : '';
const name = keyword ? keyword + '类型的歌' : String(candidate.name || candidate.title || '').trim();
if (!name) return false;
const reservation = {
id: 'sm_reserve_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
name, artist: String(candidate.artist || ''), cid: window.__activeCid || 'default',
query: keyword || name, wantedText: keyword ? name : '《' + name + '》',
endpoint: String(settings.onlineApiUrl || '').trim(), style: !!keyword, candidates: [], first: null,
consumed: false, cancelled: false, original: null, preparePromise: null
};
onlineReservations.set(reservation.id, reservation);
playQueue.push(reservation.id);
taReservedIds.add(reservation.id);
renderQueueBadge();
reservation.preparePromise = prepareOnlineReservation(reservation);
return true;
}
function playOnlineReservation(id, fallbackToNext) {
const reservation = onlineReservations.get(id);
if (!reservation) return false;
const startingTrackId = currentId;
reservation.consumed = true;
void reservation.preparePromise.then(ready => {
if (reservation.cancelled || (ready && onlineReservations.get(id) !== reservation)) return;
if ((window.__activeCid || 'default') !== reservation.cid) {
cancelOnlineReservation(id);
return;
}
if (ready && (document.hidden || currentId !== startingTrackId)) {
reservation.consumed = false;
if (!playQueue.includes(id)) playQueue.unshift(id);
renderQueueBadge();
return;
}
onlineReservations.delete(id);
taReservedIds.delete(id);
if (ready) searchAndPlayOnlineSong(reservation.query, reservation.wantedText, 'TA 预订了下一首', reservation, !!fallbackToNext);
else if (fallbackToNext && !document.hidden && !(window.mochiNeteaseSharedActive && window.mochiNeteaseSharedActive())) next();
});
return true;
}
window.mochiMusicQueuedTracks = function () {
return playQueue.map(queuedTrack).filter(Boolean).map(m => ({ id: m.id, title: m.name || '未知歌曲', artist: m.artist || '' }));
};
window.mochiMusicRemoveQueuedTrack = function (id) {
const found = playQueue.indexOf(id) >= 0;
if (found) { playQueue = playQueue.filter(x => x !== id); cancelOnlineReservation(id); renderQueueBadge(); }
return found;
};
window.mochiMusicPlayQueuedTrack = function (id, failureMessage) {
if (!queuedTrack(id) || playQueue.indexOf(id) < 0) return false;
if (onlineReservations.has(id)) {
playQueue = playQueue.filter(x => x !== id);
renderQueueBadge();
return playOnlineReservation(id, false);
}
const reserved = taReservedIds.has(id);
window.mochiMusicRemoveQueuedTrack(id);
if (reserved) currentTaReservationId = id;
expectPlayback(id, failureMessage || '需要手动播放哦');
playTrack(id, false, true);
return true;
};
window.mochiMusicPlayNextQueued = function (failureMessage) {
while (playQueue.length) {
const id = playQueue.shift();
if (playOnlineReservation(id, true)) { renderQueueBadge(); return true; }
if (findTrack(id)) { if (taReservedIds.has(id)) currentTaReservationId = id; taReservedIds.delete(id); renderQueueBadge(); expectPlayback(id, failureMessage || '需要手动播放哦'); playTrack(id, false, true); return true; }
}
renderQueueBadge();
return false;
};
function renderQueueBadge() {}
const qd = { active: null, timer: null, dragging: false, section: null, sx: 0, sy: 0, notMoved: false, bound: false, suppressClick: false };
function qdBindGlobals() {
if (qd.bound) return; qd.bound = true;
document.addEventListener('touchmove', qdOnMove, { passive: false });
document.addEventListener('mousemove', qdOnMove);
document.addEventListener('touchend', qdOnEnd);
document.addEventListener('touchcancel', qdOnEnd);
document.addEventListener('mouseup', qdOnEnd);
}
function qdPoint(e) { return (e.touches && e.touches[0]) || e; }
function qdOnMove(e) {
if (!qd.dragging) {
if (qd.notMoved && qd.active) {
const p = qdPoint(e);
if (Math.abs(p.clientX - qd.sx) > 10 || Math.abs(p.clientY - qd.sy) > 10) {
qd.notMoved = false;
if (qd.timer) { clearTimeout(qd.timer); qd.timer = null; }
}
}
return;
}
e.preventDefault();
const sec = qd.section;
if (!sec || !qd.active) return;
const p = qdPoint(e);
const rows = sec.querySelectorAll('.sm-song[data-qid]');
for (const r of rows) {
if (r === qd.active) continue;
const b = r.getBoundingClientRect();
if (p.clientY >= b.top && p.clientY <= b.bottom) { qdSwap(qd.active, r); break; }
}
}
function qdSwap(a, b) {
const pa = a.parentNode;
if (!pa) return;
const children = Array.from(pa.children);
const ai = children.indexOf(a), bi = children.indexOf(b);
if (ai < 0 || bi < 0) return;
if (ai < bi) pa.insertBefore(b, a); else pa.insertBefore(a, b);
}
function qdOnEnd() {
if (qd.timer) { clearTimeout(qd.timer); qd.timer = null; }
if (qd.dragging && qd.active) {
qd.active.classList.remove('dragging');
try { document.removeAttribute('aria-grabbed'); } catch (e) {}
const sec = qd.section;
if (sec) {
const view = Array.from(sec.querySelectorAll('.sm-song[data-qid]')).map(r => r.dataset.qid);
setPlayOrderView(view);
}
qd.suppressClick = true;
}
qd.dragging = false; qd.active = null; qd.notMoved = false;
document.body.style.userSelect = '';
}
function qdStart(e, row) {
if (e.target.closest('[data-qrm]')) return;
const p = qdPoint(e);
qd.sx = p.clientX; qd.sy = p.clientY; qd.notMoved = true;
qd.active = row;
if (qd.timer) clearTimeout(qd.timer);
qd.timer = setTimeout(function () {
qd.dragging = true;
try { document.setAttribute('aria-grabbed', 'true'); } catch (err) {}
row.classList.add('dragging');
document.body.style.userSelect = 'none';
}, 320);
}
function setupQueueDrag() {
const sec = document.getElementById('td-qlist');
if (!sec) return;
qd.suppressClick = false;
qd.section = sec;
sec.querySelectorAll('.sm-song[data-qid]').forEach(function (row) {
row.classList.add('draggable');
row.addEventListener('touchstart', function (e) { qdStart(e, row); }, { passive: true });
row.addEventListener('mousedown', function (e) { qdStart(e, row); });
});
}
function scrollToCurrentSong() {
const tcb = document.getElementById('tc-body');
if (!tcb) return;
const act = tcb.querySelector('.sm-song.active');
if (!act) return;
const tr = tcb.getBoundingClientRect(), ar = act.getBoundingClientRect();
const top = (ar.top - tr.top) - tcb.clientHeight / 2 + ar.height / 2;
tcb.scrollTop = Math.max(0, Math.min(top, tcb.scrollHeight - tcb.clientHeight));
}
function openQueuePanel() {
if (!window.openTCPanel) return;
const rowFor = (m, extra, withRm) => '<div class="sm-song' + (extra || '') + '" data-qid="' + m.id + '">' + songIcoHtml(m) +
'<div class="sm-song-info"><div class="sm-song-name">' + esc(m.name || '未知歌曲') + '</div>' +
'<div class="sm-song-sub">' + esc(m.artist || '未知歌手') + '</div></div>' +
(withRm ? '<button class="sm-song-more" data-qrm="' + m.id + '" title="移出队列"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg></button>' : '') + '</div>';
let html = '';
html += '<div class="sm-req-hint" style="padding:2px 0;font-weight:700">待播队列</div>';
if (playQueue.length) {
html += playQueue.map(id => { const m = queuedTrack(id); return m ? rowFor(m, '', true) : ''; }).join('');
} else {
html += '<div class="sm-req-hint" style="padding:4px 0 2px">还没有排队的歌——在歌曲上点「⋯」选「下一首播放」即可加入</div>';
}
const queuedId = {};
playQueue.forEach(id => { queuedId[id] = true; });
let list = playableList();
if (playQueue.length) list = list.filter(m => !queuedId[m.id]);
html += '<div class="sm-req-hint" style="padding:10px 0 2px;font-weight:700;display:flex;align-items:center;gap:4px">当前播放列表<span class="sm-q-drag-hint"></span></div>';
if (!list.length && !currentId) {
html += '<div class="sm-req-hint" style="padding:4px 0 2px">音乐库暂无歌曲</div>';
} else if (!list.length) {
html += '<div class="sm-req-hint" style="padding:4px 0 2px">当前正在播放《' + esc(findTrack(currentId) ? findTrack(currentId).name : '') + '》，其余歌曲正在其他歌单</div>';
} else {
html += '<div id="td-qlist">' + list.map(m => rowFor(m, m.id === currentId ? ' active' : '', false)).join('') + '</div>';
}
window.openTCPanel('音乐播放列表', html +
'<div class="mail-actions">' +
(playQueue.length ? '<button class="cc-tool" id="sm-q-clear">清空队列</button>' : '') +
'<button class="cc-tool" id="sm-q-close">关闭</button></div>');
qdBindGlobals();
setupQueueDrag();
scrollToCurrentSong();
document.getElementById('sm-q-close').addEventListener('click', function () { document.getElementById('tc-mask').hidden = true; });
const clr = document.getElementById('sm-q-clear');
if (clr) clr.addEventListener('click', function () { clearOnlineReservations(); playQueue = []; renderQueueBadge(); toast('已清空播放队列'); openQueuePanel(); });
document.querySelectorAll('#tc-body .sm-song[data-qid]').forEach(function (row) {
row.addEventListener('click', function (e) {
if (qd.suppressClick) { qd.suppressClick = false; return; }
if (e.target.closest('[data-qrm]')) return;
const id = row.dataset.qid;
const wasQueued = playQueue.includes(id);
playQueue = playQueue.filter(function (x) { return x !== id; });
renderQueueBadge();
document.getElementById('tc-mask').hidden = true;
if (playOnlineReservation(id, false)) return;
if (taReservedIds.has(id)) { taReservedIds.delete(id); currentTaReservationId = id; }
playTrack(id, false, wasQueued);
});
});
document.querySelectorAll('#tc-body [data-qrm]').forEach(function (btn) {
btn.addEventListener('click', function () {
playQueue = playQueue.filter(function (x) { return x !== btn.dataset.qrm; });
cancelOnlineReservation(btn.dataset.qrm);
renderQueueBadge();
openQueuePanel();
});
});
}
window.mochiMusicOpenQueue = openQueuePanel;
function nextRecommendation(forceAdvance = false, fromWidget = false) {
const s = recommendationSession;
if (!s || !s.ids.length) return false;
let index;
if (!forceAdvance && mode === 'single' && s.index >= 0) index = s.index;
else if (!forceAdvance && mode === 'shuffle' && s.ids.length > 1) {
index = Math.floor(Math.random() * (s.ids.length - 1));
if (index >= s.index) index++;
} else index = (s.index + 1) % s.ids.length;
s.index = index;
playTrack(s.ids[index], fromWidget);
return true;
}
function accountPlaybackFailed(id) {
if (currentId !== id || accountFailureSerial === accountPlaySerial) return;
const failedSerial = accountPlaySerial;
const failedTrack = findTrack(id);
const liveAt = audio && Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
const resumeAt = accountResumeSeek && accountResumeSeek.serial === failedSerial
? accountResumeSeek.at : Math.max(liveAt, accountLastPosition && accountLastPosition.id === id ? accountLastPosition.at : 0);
if (accountPlaybackSource === 'netease' && failedTrack &&
!(onlineAttempt && onlineAttempt.trackId === id && onlineAttempt.fallbackTried) &&
window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn()) {
accountPlaybackSource = 'fallback-pending';
if (onlineAttempt && onlineAttempt.trackId === id) onlineAttempt.fallbackTried = true;
teardownAudio();
window.ciciNeteaseEnhanced.fallbackTrack(failedTrack).then(result => {
if (currentId !== id || accountPlaySerial !== failedSerial) return;
if (onlineAttempt && onlineAttempt.trackId === id) onlineAttempt.playbackSource = String(result.source || 'fallback');
playTrack(id, false, !!(onlineAttempt && onlineAttempt.trackId === id), result.url, result.source || 'fallback', resumeAt);
}).catch(() => { if (currentId === id && accountPlaySerial === failedSerial) accountPlaybackFailed(id); });
return;
}
if (id === temporaryOnlineId && onlineAttempt && onlineAttempt.trackId === id) {
finishTemporaryOnlineFailure(id);
return;
}
accountFailureSerial = accountPlaySerial;
++accountPlaySerial; // 丢弃还没完成的旧取流结果
removeFailedRecommendationInsert(id);
clearExpectedPlayback();
wantPlay = false;
teardownAudio();
currentId = null;
updatePlayerBar();
const s = recommendationSession;
if (!s) { playbackPrompt('这首网易云歌曲无法完整播放'); return; }
s.failures = (s.failures || 0) + 1;
if (s.failures >= 3) {
recommendationSession = null;
playbackPrompt('连续三首无法完整播放，请在网易云音乐中播放');
return;
}
nextRecommendation(true);
}
let recommendationLoading = false;
function storeRecommendationSongs(modeName, songs) {
const pid = modeName === 'daily' ? 'cici_netease_daily' : 'cici_netease_heart';
const label = modeName === 'daily' ? '网易云每日推荐' : '网易云心动模式';
const ids = [];
for (const song of songs) {
let track = [...sessionTracks.values()].find(item => item.playlistId === pid && String(item.neteaseId || '') === song.id);
if (!track) {
track = { id: 'cici_net_' + modeName + '_' + song.id, playlistId: pid,
neteaseId: song.id, source: 'netease-account', url: '', addedAt: Date.now() };
sessionTracks.set(track.id, track);
}
track.name = song.name;
track.artist = song.artists;
track.cover = String(song.picUrl || '').replace(/^http:/i, 'https:');
track.duration = Number(song.duration || 0) / 1000;
track.neteaseAccount = true;
track.source = 'netease-account';
track.url = ''; // 签名音源短时效；每次起播前重新获取
if (!ids.includes(track.id)) ids.push(track.id);
}
return { pid, label, ids };
}
let recommendationRefreshRunning = false;
window.mochiMusicRefreshRecommendation = async function () {
const session = recommendationSession;
const api = window.ciciNeteaseEnhanced;
if (recommendationRefreshRunning || recommendationLoading || !session ||
(session.mode !== 'daily' && session.mode !== 'heart') || !api || !api.loggedIn() || document.hidden) return false;
recommendationRefreshRunning = true;
try {
const current = findTrack(currentId);
const songs = await api.recommendations(session.mode, { songId: current && current.neteaseId || '',
playlistId: session.heartPlaylistId || '' });
if (recommendationSession !== session || !songs.length) return false;
const fresh = storeRecommendationSongs(session.mode, songs);
const currentIndex = Math.max(0, session.ids.indexOf(currentId), session.index);
const played = session.ids.slice(0, currentIndex + 1);
const oldCatalog = new Set(session.catalogIds || session.ids);
const inserted = session.ids.slice(currentIndex + 1).filter(id => !oldCatalog.has(id));
session.ids = [...new Set([...played, ...inserted, ...fresh.ids])];
session.index = session.ids.indexOf(currentId);
if (session.index < 0) session.index = Math.min(currentIndex, session.ids.length - 1);
session.catalogIds = fresh.ids.slice();
if (session.mode === 'heart' && songs.playlistId) session.heartPlaylistId = songs.playlistId;
renderPage();
return true;
} catch (error) { return false; }
finally { recommendationRefreshRunning = false; }
};
async function startRecommendation(modeName) {
if (recommendationLoading) return;
const api = window.ciciNeteaseEnhanced;
if (!api) { playbackPrompt('请在安卓 App 中使用网易云推荐'); return; }
recommendationLoading = true;
try {
await api.refresh();
const current = findTrack(currentId);
const songs = await api.recommendations(modeName, { songId: current && current.neteaseId || '' });
if (!songs.length) throw new Error('网易云没有返回可播放的推荐歌曲');
const oldIds = new Set(sessionTracks.keys());
sessionTracks.clear();
playQueue = playQueue.filter(id => !oldIds.has(id));
const { pid, label, ids } = storeRecommendationSongs(modeName, songs);
recommendationSession = { mode: modeName, pid, ids, catalogIds: ids.slice(), index: 0,
heartPlaylistId: modeName === 'heart' ? String(songs.playlistId || '') : '', failures: 0 };
if (window.mochiNeteaseUseLocal) window.mochiNeteaseUseLocal(false);
renderPage();
playbackPrompt('已加载' + label + '，正在播放');
playTrack(ids[0]);
} catch (error) { playbackPrompt(error && error.message || '网易云推荐加载失败'); }
finally { recommendationLoading = false; }
}
function next(fromWidget) {
markFloatSource(fromWidget);
while (playQueue.length) {
const qid = playQueue.shift();
if (playOnlineReservation(qid, true)) { renderQueueBadge(); return; }
if (findTrack(qid)) { if (taReservedIds.has(qid)) { taReservedIds.delete(qid); currentTaReservationId = qid; expectPlayback(qid, '需要手动播放哦'); } playTrack(qid, fromWidget, true); return; }
if (taReservedIds.has(qid)) { taReservedIds.delete(qid); playbackPrompt('需要手动播放哦'); }
}
renderQueueBadge();
if (recommendationSession) { nextRecommendation(false, fromWidget); return; }
if (window.mochiNeteaseResumeAfterLocal && window.mochiNeteaseResumeAfterLocal()) return;
const list = playableList();
if (!list.length) return;
let idx = list.findIndex(x => x.id === currentId);
let nid;
if (mode === 'single') nid = currentId;
else if (mode === 'shuffle') nid = list[Math.floor(Math.random() * list.length)].id;
else {
idx = idx < 0 ? -1 : idx;
nid = list[(idx + 1) % list.length].id;
}
playTrack(nid, fromWidget);
}
function prev(fromWidget) {
markFloatSource(fromWidget);
if (recommendationSession && recommendationSession.ids.length) {
const s = recommendationSession;
const index = (s.index - 1 + s.ids.length) % s.ids.length;
s.index = index;
playTrack(s.ids[index], fromWidget);
return;
}
const list = playableList();
if (!list.length) return;
const idx = list.findIndex(x => x.id === currentId);
if (idx < 0) { playTrack(list[list.length - 1].id, fromWidget); return; }
playTrack(list[(idx - 1 + list.length) % list.length].id, fromWidget);
}
function cycleMode() {
const order = ['list', 'shuffle', 'single'];
mode = order[(order.indexOf(mode) + 1) % order.length];
const label = { list: '顺序播放', shuffle: '随机播放', single: '单曲循环' }[mode];
toast(label);
updateModeIcon();
saveSettings();
}
function updateModeIcon() {
const paths = {
list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
shuffle: '<path d="M2 11a5 5 0 0 1 5-5h13"/><path d="m16 3 4 3-4 3"/><path d="M22 13a5 5 0 0 1-5 5H4"/><path d="m8 21-4-3 4-3"/>',
single: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M9.5 8.5h5"/>'
};
document.querySelectorAll('#sm-mode-ico, #sm-f-mode-ico, #mw-mode-ico').forEach(el => { el.innerHTML = paths[mode] || paths.list; });
}
let togetherState = { key: '', decided: false, shown: false, playing: false };
window.mochiMusicTogetherVisible = function () { return !!(togetherState.playing && togetherState.shown); };
let togetherAcknowledged = false;
let togetherStopTimer = null;
const TOGETHER_TRACK_GAP_MS = 8000;
const TOGETHER_JOIN_RETRY_MS = 60000;
const TOGETHER_PHASE_MIN_MS = 15 * 60000;
const TOGETHER_PHASE_MAX_MS = 30 * 60000;
let togetherJoinTimer = null;
let togetherPhaseTimer = null;
let togetherDeparted = false;
let togetherPending = null;
let weekendComment = null;
const WEEKEND_COMMENT_CHANCE = 20;
const WEEKEND_COMMENT_RETRY_MS = 60000;
const weekendCommentDuration = () => (30 + Math.floor(Math.random() * 131)) * 1000;
const WEEKEND_COMMENT_FALLBACK = ['这首歌的旋律，我想和你一起听完', '我在听，下一段也别跳过', '这一句唱得真好，想再听一遍'];
function resetWeekendComment() {
if (weekendComment && weekendComment.timer) clearTimeout(weekendComment.timer);
weekendComment = null;
const box = document.getElementById('weekend-box');
const text = document.getElementById('weekend-music-comment');
if (box) box.classList.remove('music-comment-active');
if (text) { text.hidden = true; text.textContent = ''; }
}
function musicWeekendCommentPool() {
let pool = window.getLibPool ? window.getLibPool('music', 'TA 陪听评论', WEEKEND_COMMENT_FALLBACK) : WEEKEND_COMMENT_FALLBACK;
if (!Array.isArray(pool)) pool = [];
if (window.isDefaultCardOff) pool = pool.filter(line => !window.isDefaultCardOff('music', line));
return pool.filter(line => typeof line === 'string' && line.trim());
}
function chatWeekendCommentPool() {
try {
const pool = window.getPool && window.getPool();
return pool && Array.isArray(pool.text) ? pool.text.filter(line => typeof line === 'string' && line.trim()) : [];
} catch (e) { return []; }
}
function pickWeekendComment(previous) {
const chatShare = window.dcfMusicChatShare ? window.dcfMusicChatShare() : 20;
const useChat = Math.random() * 100 < chatShare;
let pool = useChat ? chatWeekendCommentPool() : musicWeekendCommentPool();
if (!pool.length) pool = useChat ? musicWeekendCommentPool() : chatWeekendCommentPool();
if (!pool.length) return null;
const others = pool.filter(line => line !== previous);
const raw = (others.length ? others : pool)[Math.floor(Math.random() * (others.length || pool.length))];
return { raw, text: window.taFit ? window.taFit(raw) : raw };
}
function advanceWeekendComment() {
const current = weekendComment;
if (!current || !togetherState.playing || document.hidden) return false;
const next = pickWeekendComment(current.raw);
if (!next) return false;
current.raw = next.raw;
current.text = next.text;
const duration = weekendCommentDuration();
current.nextAt = Date.now() + duration;
if (current.timer) clearTimeout(current.timer);
current.timer = setTimeout(() => {
current.timer = null;
if (weekendComment === current && togetherState.playing && !document.hidden) tryWeekendComment();
}, duration);
renderWeekendComment();
return true;
}
function scheduleWeekendCommentRetry() {
const current = weekendComment;
if (!current) return;
if (current.timer) clearTimeout(current.timer);
current.nextAt = Date.now() + WEEKEND_COMMENT_RETRY_MS;
current.timer = setTimeout(() => {
current.timer = null;
if (weekendComment === current && togetherState.playing && !document.hidden) tryWeekendComment();
}, WEEKEND_COMMENT_RETRY_MS);
}
function tryWeekendComment() {
const current = weekendComment;
if (!current || !togetherState.playing || document.hidden) return;
current.text = '';
current.nextAt = 0;
if (Math.random() * 100 < WEEKEND_COMMENT_CHANCE && advanceWeekendComment()) return;
scheduleWeekendCommentRetry();
renderWeekendComment();
}
function renderWeekendComment() {
const box = document.getElementById('weekend-box');
const text = document.getElementById('weekend-music-comment');
if (!box || !text) return;
const active = !!(weekendComment && togetherState.playing && togetherState.shown && togetherAcknowledged && !document.hidden);
if (active && weekendComment.nextAt && Date.now() >= weekendComment.nextAt) {
tryWeekendComment();
}
box.classList.toggle('music-comment-active', active);
text.hidden = !active || !weekendComment.text;
if (active && weekendComment.text) text.textContent = weekendComment.text;
else if (active) text.textContent = '';
}
function renderTogether() {
const row = document.getElementById('mw-together');
const button = document.getElementById('mw-together-ok');
const widget = document.getElementById('music-widget');
if (!row || !widget) return;
const visible = togetherState.playing && togetherState.shown;
row.hidden = !visible;
if (button) button.hidden = !visible || togetherAcknowledged;
widget.classList.toggle('has-together', visible);
renderWeekendComment();
}
function clearTogetherTiming() {
if (togetherJoinTimer) clearTimeout(togetherJoinTimer);
if (togetherPhaseTimer) clearTimeout(togetherPhaseTimer);
togetherJoinTimer = null;
togetherPhaseTimer = null;
}
function togetherPhaseDelay() {
return TOGETHER_PHASE_MIN_MS + Math.floor(Math.random() * (TOGETHER_PHASE_MAX_MS - TOGETHER_PHASE_MIN_MS + 1));
}
function scheduleTogetherPhase() {
if (togetherPhaseTimer || !togetherState.decided) return;
togetherPhaseTimer = setTimeout(() => {
togetherPhaseTimer = null;
if (togetherState.shown) {
if (Math.random() * 100 < probOf(settings.togetherLeaveProb, 20)) {
togetherState.shown = false;
togetherDeparted = true;
resetWeekendComment();
renderTogether();
}
} else if (togetherDeparted && Math.random() * 100 < probOf(settings.togetherProb, 50)) {
showTogetherForSession();
renderTogether();
return;
}
scheduleTogetherPhase();
}, togetherPhaseDelay());
}
function showTogetherForSession() {
togetherState.decided = true;
togetherState.shown = true;
togetherDeparted = false;
if (togetherJoinTimer) { clearTimeout(togetherJoinTimer); togetherJoinTimer = null; }
if (togetherPhaseTimer) { clearTimeout(togetherPhaseTimer); togetherPhaseTimer = null; }
scheduleTogetherPhase();
if (togetherAcknowledged && !weekendComment) {
weekendComment = { raw: '', text: '', nextAt: 0, timer: null };
if (togetherState.playing) tryWeekendComment();
}
}
function scheduleTogetherJoinRetry() {
if (togetherJoinTimer || togetherState.shown || togetherDeparted || !togetherState.playing) return;
togetherJoinTimer = setTimeout(() => {
togetherJoinTimer = null;
if (!togetherState.playing || togetherState.shown || togetherDeparted) return;
if (!document.hidden && Math.random() * 100 < probOf(settings.togetherProb, 50)) {
showTogetherForSession();
renderTogether();
} else scheduleTogetherJoinRetry();
}, TOGETHER_JOIN_RETRY_MS);
}
function pauseTogetherSession() {
if (togetherStopTimer) { clearTimeout(togetherStopTimer); togetherStopTimer = null; }
if (togetherJoinTimer) { clearTimeout(togetherJoinTimer); togetherJoinTimer = null; }
togetherState.playing = false;
myInviteListening = false;
myInviteAwaitingUntil = 0;
togetherPending = null;
renderTogether();
}
window.mochiMusicTogetherPause = pauseTogetherSession;
function endTogetherSession() {
if (togetherStopTimer) clearTimeout(togetherStopTimer);
togetherStopTimer = null;
clearTogetherTiming();
togetherDeparted = false;
togetherAcknowledged = false;
togetherPending = null;
myInviteListening = false;
myInviteAwaitingUntil = 0;
togetherState = { key: '', decided: false, shown: false, playing: false };
resetWeekendComment();
renderTogether();
}
window.mochiMusicTogetherStop = endTogetherSession;
function scheduleTogetherSessionEnd() {
if (togetherStopTimer) return;
togetherStopTimer = setTimeout(() => {
togetherStopTimer = null;
if (togetherState.playing) return;
if (myInviteListening && myInviteAwaitingUntil > Date.now()) { scheduleTogetherSessionEnd(); return; }
myInviteListening = false;
myInviteAwaitingUntil = 0;
if (togetherJoinTimer) { clearTimeout(togetherJoinTimer); togetherJoinTimer = null; }
}, TOGETHER_TRACK_GAP_MS);
}
window.mochiMusicTogetherUpdate = function (source, trackKey, playing) {
if (!source || !trackKey || !playing) {
togetherState.playing = false;
scheduleTogetherSessionEnd();
renderTogether();
return;
}
if (togetherStopTimer) { clearTimeout(togetherStopTimer); togetherStopTimer = null; }
const key = source + ':' + trackKey;
if (source === 'netease' && officialInvitePending && Date.now() < officialInvitePending.expires &&
officialInvitePending.cid === (window.__activeCid || 'default')) {
const snapshot = window.mochiNeteasePlaybackSnapshot && window.mochiNeteasePlaybackSnapshot();
if (snapshot && String(snapshot.title || '').trim().toLocaleLowerCase() === officialInvitePending.title.toLocaleLowerCase()) {
myInviteListening = true;
officialInvitePending = null;
}
}
togetherState.key = key;
togetherState.playing = !!playing;
if (playing) myInviteAwaitingUntil = 0;
if (playing && !togetherState.decided) {
togetherState.decided = true;
if (myInviteListening || inviteFlow || Math.random() * 100 < probOf(settings.togetherProb, 50))
showTogetherForSession();
else scheduleTogetherJoinRetry();
}
if (playing && !togetherState.shown && !togetherDeparted) scheduleTogetherJoinRetry();
if (playing && togetherPending) {
const pending = togetherPending;
if (Date.now() > pending.expires) togetherPending = null;
else if (source === pending.source &&
(pending.target ? trackKey === pending.target || trackKey.startsWith(pending.target + ':')
: key !== pending.afterKey)) {
showTogetherForSession();
togetherPending = null;
}
}
if (playing && togetherState.shown && togetherAcknowledged && weekendComment &&
!weekendComment.timer && !weekendComment.nextAt) tryWeekendComment();
renderTogether();
};
window.mochiMusicTogetherForce = function (source, target, afterKey) {
const key = source + ':' + target;
if (target && togetherState.playing &&
(togetherState.key === key || togetherState.key.startsWith(key + ':'))) {
showTogetherForSession();
renderTogether();
return;
}
togetherPending = { source, target: target || '', afterKey: afterKey || togetherState.key, expires: Date.now() + 15000 };
};
const togetherOk = document.getElementById('mw-together-ok');
if (togetherOk) togetherOk.addEventListener('click', () => {
if (!togetherState.playing || !togetherState.shown || togetherAcknowledged) return;
togetherAcknowledged = true;
resetWeekendComment();
weekendComment = { raw: '', text: '', nextAt: 0, timer: null };
tryWeekendComment();
renderTogether();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderTogether(); else renderWeekendComment(); });
function syncPlayIcons(playing) {
const buffering = playing && musicBuffering();
const playPath = playing
? '<path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z"/>'
: '<path d="M8 5.5v13l11-6.5z"/>';
['sm-play-ico', 'sm-f-play-ico', 'sm-f-mini-play-ico'].forEach(id => {
const el = document.getElementById(id);
if (el) el.innerHTML = playPath;
});
const wi = document.getElementById('mw-play-ico');
if (wi) wi.innerHTML = playing
? '<path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z"/>'
: '<path d="M8 5.5v13l11-6.5z"/>';
const bars = document.getElementById('mw-bars');
if (bars) {
bars.classList.toggle('playing', playing);
bars.classList.toggle('buffering', buffering);
}
if (!(window.mochiNeteaseSharedActive && window.mochiNeteaseSharedActive()))
window.mochiMusicTogetherUpdate('mochi', currentId, !!(playing && audio && !audio.paused));
if (playing) {
const t = buffering ? '缓冲中' : (audio && audio.currentTime ? fmtDur(audio.currentTime) : '00:00');
['sm-pb-cur', 'sm-f-cur', 'mw-cur'].forEach(id => {
const e = document.getElementById(id);
if (e) e.textContent = t;
});
}
if (window.mochiNeteaseRenderLocalControlPanel) window.mochiNeteaseRenderLocalControlPanel();
}
function updatePlayerBar() {
if (window.mochiNeteaseSharedActive && window.mochiNeteaseSharedActive()) {
if (window.mochiNeteaseRenderShared) window.mochiNeteaseRenderShared();
return;
}
const bar = document.getElementById('sm-player-bar');
const m = findTrack(currentId);
if (!bar) return;
bar.hidden = !m;
if (!m) return;
document.getElementById('sm-pb-name').textContent = m.name || '未知歌曲';
document.getElementById('sm-pb-artist').textContent = m.artist || '';
document.getElementById('sm-pb-dur').textContent = fmtDur(m.duration);
document.getElementById('sm-pb-cur').textContent = '00:00';
syncPlayIcons(audio && !audio.paused);
updateModeIcon();
renderQueueBadge();
const wSong = document.getElementById('mw-song');
const wArtist = document.getElementById('mw-artist');
if (wSong) wSong.textContent = m.name || '未知歌曲';
if (wArtist) wArtist.textContent = m.artist || '';
setWidgetCover(m);
renderFloat();
}
function setWidgetCover(m) {
const cover = document.getElementById('mw-cover');
if (!cover) return;
let coverUrl = '';
if (m) {
if (settings.widgetCoverMode === 'playlist') {
const pl = playlists.find(p => p.id === m.playlistId);
if (pl && pl.cover) coverUrl = pl.cover;
else if (m.cover) coverUrl = m.cover;
} else if (m.cover) {
coverUrl = m.cover;
}
}
if (coverUrl) {
cover.style.backgroundImage = 'url("' + coverUrl + '")';
cover.style.backgroundSize = 'cover';
cover.style.backgroundPosition = 'center';
cover.classList.add('has-cover');
} else {
cover.style.backgroundImage = '';
cover.style.backgroundSize = '';
cover.style.backgroundPosition = '';
cover.classList.remove('has-cover');
}
if (m && m.neteaseId && !m.cover) ensureSongCover(m);
else if (m && m.cover && COVER_PROXY_RE.test(m.cover)) enqueueCovMig(m);
}
function isFloatOn() { return settings.floatEn && !floatClosed && currentId && audio; }
function markFloatSource(fromWidget) {
floatHideByWidget = !!fromWidget;
}
function applyFloatMin() {
const el = document.getElementById('sm-float');
if (el) el.classList.toggle('min', floatMin);
}
function toggleFloatMin() {
floatMin = !floatMin;
applyFloatMin();
syncPlayIcons(audio && !audio.paused);
}
function floatOwnSurfaceShown() {
try {
const musicPage = document.getElementById('page-music');
if (musicPage && !musicPage.hidden) return true;
const phonePage = document.getElementById('page-phone');
if (!phonePage || phonePage.hidden) return false;
const w = document.getElementById('music-widget');
return !!(w && w.offsetParent !== null);
} catch (e) { return false; }
}
let floatClampSig = '';
function clampFloatPos() {
try {
const el = document.getElementById('sm-float');
if (!el || el.hidden) return; // 隐藏时量不到尺寸，等可见那一次再钳
const sig = window.innerWidth + 'x' + window.innerHeight;
if (floatClampSig === sig) return;
floatClampSig = sig;
const w = el.offsetWidth, h = el.offsetHeight;
if (!w || !h) return;
const r = el.getBoundingClientRect();
const maxX = Math.max(4, window.innerWidth - w - 4);
const maxY = Math.max(4, window.innerHeight - h - 4);
let x = r.left, y = r.top;
if (x < 4) x = 4; else if (x > maxX) x = maxX;
if (y < 4) y = 4; else if (y > maxY) y = maxY;
if (Math.abs(x - r.left) < 1 && Math.abs(y - r.top) < 1) return;
el.style.left = x + 'px';
el.style.top = y + 'px';
store.set('music-float-pos', JSON.stringify({ left: el.style.left, top: el.style.top }));
} catch (e) {}
}
function renderFloat() {
if (window.mochiNeteaseSharedActive && window.mochiNeteaseSharedActive()) {
if (window.mochiNeteaseRenderShared) window.mochiNeteaseRenderShared();
return;
}
const el = document.getElementById('sm-float');
if (!el) return;
const m = findTrack(currentId);
el.hidden = !(settings.floatEn && !floatClosed && currentId && audio && m) || floatHideByWidget || floatOwnSurfaceShown();
if (!el.hidden) clampFloatPos(); // #994：可见这一次确保位置在当前视口内
applyFloatMin();
if (!m) return;
document.getElementById('sm-f-name').textContent = m.name || '未知歌曲';
const miniName = document.getElementById('sm-f-mini-name');
if (miniName) miniName.textContent = m.name || '未知歌曲';
const fArtist = document.getElementById('sm-f-artist');
if (fArtist) fArtist.textContent = m.artist || '';
const fDur = document.getElementById('sm-f-dur');
if (fDur) fDur.textContent = fmtDur(m.duration || (audio && audio.duration) || 0);
const fCur = document.getElementById('sm-f-cur');
if (fCur) fCur.textContent = '00:00';
syncPlayIcons(audio && !audio.paused);
syncHeartIcons();
}
['page-phone', 'page-music'].forEach(function (id) {
const p = document.getElementById(id);
if (!p || typeof MutationObserver === 'undefined') return;
try {
new MutationObserver(function () { renderFloat(); })
.observe(p, { attributes: true, attributeFilter: ['hidden'] });
} catch (e) {}
});
window.musicFloatGet = function () { return !!settings.floatEn; };
window.musicFloatSet = function (en) {
settings.floatEn = !!en;
floatClosed = false;
floatHideByWidget = false; // 用户显式操作悬浮小窗开关 → 清除小组件抑制
saveSettings();
syncFloatToggle();
renderFloat();
};
function favIds() {
try { return JSON.parse(store.get('music-favs') || '[]'); } catch (e) { return []; }
}
function saveFavIds(list) { store.set('music-favs', JSON.stringify(list)); }
function isFav(id) { return favIds().indexOf(id) >= 0; }
function toggleFav(id) {
const list = favIds();
const i = list.indexOf(id);
if (i >= 0) list.splice(i, 1); else list.unshift(id);
saveFavIds(list);
syncHeartIcons();
renderFavList();
return i < 0;
}
function syncHeartIcons() {
const m = findTrack(currentId);
const liked = m ? isFav(m.id) : false;
const hb = document.getElementById('mw-heart');
if (hb) hb.classList.toggle('liked', liked);
const fh = document.getElementById('sm-f-heart');
if (fh) fh.classList.toggle('liked', liked);
const pb = document.getElementById('sm-pb-heart');
if (pb) pb.classList.toggle('liked', liked);
}
function renderFavList() {
const el = document.getElementById('music-fav-list');
if (!el) return;
const ids = favIds();
const songs = ids.map(id => findTrack(id)).filter(Boolean);
el.innerHTML = songs.length
? songs.map(m => {
const active = m.id === currentId;
return '<div class="sm-song' + (active ? ' active' : '') + '" data-id="' + m.id + '">' +
songIcoHtml(m) +
'<div class="sm-song-info"><div class="sm-song-name">' + esc(m.name || '未知歌曲') + '</div>' +
'<div class="sm-song-sub">' + esc(m.artist || '未知歌手') + '</div></div>' +
'<button class="sm-song-more" data-id="' + m.id + '" title="取消收藏"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5S4.5 15.2 4.5 9.9A4.9 4.9 0 0112 7.1a4.9 4.9 0 017.5 2.8c0 5.3-7.5 10.6-7.5 10.6z"/></svg></button>' +
'</div>';
}).join('')
: '<div class="ta-empty">还没有收藏歌曲，播放时点击爱心收藏</div>';
el.querySelectorAll('.sm-song').forEach(row => {
row.addEventListener('click', (e) => {
if (e.target.closest('.sm-song-more')) return;
playTrack(row.dataset.id);
});
});
el.querySelectorAll('.sm-song-more').forEach(b => {
b.addEventListener('click', () => {
toggleFav(b.dataset.id);
toast('已取消收藏');
});
});
}
function syncFloatToggle() {
const cb = document.getElementById('music-float-en');
if (cb) cb.checked = settings.floatEn;
}
function taMusicSys(text, byUser) { try { if (window.chatAddSystem) window.chatAddSystem(text, { silent: true, rateAllow: byUser === true, nightAllow: true }); } catch (e) {} }
function taMusicSay(text) { try { if (window.chatAddIn) window.chatAddIn(text, { silent: true }); } catch (e) {} }
function taFavList() {
try {
const v = JSON.parse(store.get('music-favs-ta') || '[]');
if (!Array.isArray(v)) return [];
return v.map(x => (typeof x === 'string') ? { id: x } : x).filter(x => x && x.id);
} catch (e) { return []; }
}
function taFavIds() { return taFavList().map(x => x.id); }
function saveTaFavList(list) { store.set('music-favs-ta', JSON.stringify(list)); }
function isTaFav(id) { return taFavIds().indexOf(id) >= 0; }
function addTaFav(id) {
if (isTaFav(id)) return false;
const m = findTrack(id);
if (!m) return false; // 歌已不在库里，无法留快照（scheduleTaFavCheck 已先判 findTrack，理论到不了）
const list = taFavList();
list.unshift({ id: m.id, name: m.name || '', artist: m.artist || '', neteaseId: m.neteaseId || '', url: m.url || '', cover: m.cover || '', duration: m.duration || 0, favAt: Date.now() });
saveTaFavList(list);
renderTaFavList();
return true;
}
window.mochiMusicHasRemoteTaFavorite = function (remoteKey) {
return taFavList().some(x => x.remote === true && x.remoteKey === remoteKey);
};
window.mochiMusicAddRemoteTaFavorite = function (track) {
if (!track || !track.key || !track.title || window.mochiMusicHasRemoteTaFavorite(track.key)) return false;
const list = taFavList();
list.unshift({
id: 'netease_remote_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
remote: true, remoteKey: track.key, name: track.title, artist: track.artist || '',
cover: /^https:\/\//.test(track.cover || '') ? track.cover : '',
duration: track.duration || 0, favAt: Date.now()
});
saveTaFavList(list);
renderTaFavList();
const name = partnerName();
taMusicSys(name + ' 收藏了歌曲《' + track.title + '》');
toast(name + ' 收藏了《' + track.title + '》');
return true;
};
function removeTaFav(id) {
const list = taFavList();
const i = list.findIndex(x => x.id === id);
if (i < 0) return false;
list.splice(i, 1);
saveTaFavList(list);
renderTaFavList();
return true;
}
let taFavTimer = null;
let taSongFavAt = 0;
window.mochiMusicTaFavCooldownRemaining = function () { return Math.max(0, 90000 - (Date.now() - taSongFavAt)); };
window.mochiMusicNoteTaFav = function () { taSongFavAt = Date.now(); };
function clearTaFavTimer() {
if (taFavTimer) { clearTimeout(taFavTimer); taFavTimer = null; }
}
function scheduleTaFavCheck(m) {
clearTaFavTimer();
const prob = probOf(settings.taFavProb, 20);
if (!prob || !m || !m.id) return;
if (isTaFav(m.id)) return;
if (Date.now() - taSongFavAt < 90000) return;
const trackId = m.id;
taFavTimer = setTimeout(function () {
taFavTimer = null;
if (currentId !== trackId) return;
if (!audio || audio.paused) return;
if (Math.random() * 100 >= probOf(settings.taFavProb, 20)) return;
const mm = findTrack(trackId);
if (!mm) return;
if (addTaFav(trackId)) {
taSongFavAt = Date.now();
const name = partnerName();
const trackName = mm.name || '未知歌曲';
try { toast(window.taFit ? window.taFit(name + ' 收藏了这首歌') : (name + ' 收藏了《' + trackName + '》')); } catch (e) {}
taMusicSys(name + ' 收藏了歌曲《' + trackName + '》');
}
}, 10000 + Math.floor(Math.random() * 15000));
}
function taFavRestorable(x) { return !!(x && (x.neteaseId || validAudioSrc(x.url))); }
function restoreTaFavSong(x) {
const url = x.neteaseId ? neteaseMetingUrl(x.neteaseId) : (validAudioSrc(x.url) ? x.url : '');
if (!url) { toast('该歌曲文件已删除，无法播放'); return; }
const nid = 'sm_fav_' + Date.now() + '_' + Math.floor(Math.random() * 1e4).toString(36);
library.push({ id: nid, neteaseId: x.neteaseId || '', name: x.name || (x.neteaseId ? '网易云音乐-' + x.neteaseId : '未知歌曲'), artist: x.artist || '', cover: x.cover || '', url: url, source: 'url', duration: x.duration || 0, playlistId: 'default', addedAt: Date.now() });
const list = taFavList();
const it = list.find(t => t.id === x.id);
if (it) { it.id = nid; it.url = url; saveTaFavList(list); } // 快照指向新库条目，列表行恢复可播
saveLibrary();
renderPage();
renderTaFavList();
playTrack(nid);
toast('已重新加入音乐库并播放');
}
function renderTaFavList() {
const el = document.getElementById('music-fav-ta-list');
if (!el) return;
const nm = partnerName();
const list = taFavList();
let healed = false;
list.forEach(x => {
if (x.name) return; // 已有快照信息
const m = findTrack(x.id);
if (m) { // 旧纯 id 数据：歌还在库 → 回补快照
x.name = m.name || ''; x.artist = m.artist || ''; x.neteaseId = m.neteaseId || '';
x.url = m.url || ''; x.cover = m.cover || ''; x.duration = m.duration || 0;
healed = true;
}
});
if (healed) saveTaFavList(list);
const rows = list.map(x => {
const m = findTrack(x.id);
const gone = !m && !x.remote;
const name = (m && m.name) || x.name || '未知歌曲';
const artist = (m && m.artist) || x.artist || '';
const active = m && m.id === currentId;
return '<div class="sm-song' + (active ? ' active' : '') + (gone ? ' ta-fav-gone' : '') + '" data-id="' + x.id + '">' +
songIcoHtml(m || x) +
'<div class="sm-song-info"><div class="sm-song-name">' + esc(name) + (gone ? '<span class="sm-fav-gone-tag">已删除</span>' : '') + '</div>' +
'<div class="sm-song-sub">' + esc(artist || '未知歌手') + (x.remote ? ' · 网易云播放' : gone ? ' · ' + (taFavRestorable(x) ? '点击重新加入并播放' : '文件已不在，无法播放') : '') + '</div></div>' +
'<button class="sm-song-more" data-id="' + x.id + '" title="取消收藏"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5S4.5 15.2 4.5 9.9A4.9 4.9 0 0112 7.1a4.9 4.9 0 017.5 2.8c0 5.3-7.5 10.6-7.5 10.6z"/></svg></button>' +
'</div>';
}).join('');
el.innerHTML = rows || '<div class="ta-empty">' + esc(nm) + ' 还没有收藏歌曲，播放时 ' + esc(nm) + ' 有概率把喜欢的歌收进来</div>';
el.querySelectorAll('.sm-song').forEach(row => {
row.addEventListener('click', (e) => {
if (e.target.closest('.sm-song-more')) return;
const id = row.dataset.id;
const x = taFavList().find(t => t.id === id);
if (x && x.remote) { toast('这首歌由网易云播放，请到网易云音乐中打开'); return; }
if (findTrack(id)) { playTrack(id); return; }
if (x && taFavRestorable(x)) { restoreTaFavSong(x); return; }
toast('该歌曲已删除，无法播放');
});
});
el.querySelectorAll('.sm-song-more').forEach(b => {
b.addEventListener('click', () => {
removeTaFav(b.dataset.id);
toast('已取消收藏');
});
});
}
function syncTaFavTab() {
const tab = document.querySelector('#page-music .fav-tab[data-mtab="favta"]');
if (tab) tab.textContent = partnerName() + '的收藏';
}
function setupFloatDrag() {
const el = document.getElementById('sm-float');
if (!el) return;
let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
el.addEventListener('mousedown', (e) => {
if (e.target.closest('button')) return;
dragging = true;
sx = e.clientX; sy = e.clientY;
const r = el.getBoundingClientRect();
ox = r.left; oy = r.top;
document.body.style.cursor = 'move';
const onMove = (ev) => {
if (!dragging) return;
ev.preventDefault();
let x = ox + (ev.clientX - sx), y = oy + (ev.clientY - sy);
x = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, x));
y = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, y));
el.style.left = x + 'px';
el.style.top = y + 'px';
};
const onUp = () => {
dragging = false;
document.body.style.cursor = '';
document.removeEventListener('mousemove', onMove);
document.removeEventListener('mouseup', onUp);
store.set('music-float-pos', JSON.stringify({ left: el.style.left, top: el.style.top }));
};
document.addEventListener('mousemove', onMove);
document.addEventListener('mouseup', onUp);
});
el.addEventListener('touchstart', (e) => {
if (e.target.closest('button')) return;
const t = e.touches[0];
dragging = true;
sx = t.clientX; sy = t.clientY;
const r = el.getBoundingClientRect();
ox = r.left; oy = r.top;
const onMove = (ev) => {
if (!dragging) return;
ev.preventDefault();
const t2 = ev.touches[0];
let x = ox + (t2.clientX - sx), y = oy + (t2.clientY - sy);
x = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, x));
y = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, y));
el.style.left = x + 'px';
el.style.top = y + 'px';
};
const onUp = () => {
dragging = false;
el.removeEventListener('touchmove', onMove);
document.removeEventListener('touchend', onUp);
store.set('music-float-pos', JSON.stringify({ left: el.style.left, top: el.style.top }));
};
el.addEventListener('touchmove', onMove, { passive: false });
document.addEventListener('touchend', onUp);
}, { passive: true });
try {
const pos = JSON.parse(store.get('music-float-pos') || 'null');
if (pos && pos.left && pos.top) { el.style.left = pos.left; el.style.top = pos.top; }
} catch(e) {}
let _fpClampT = null;
window.addEventListener('resize', function () {
if (_fpClampT) clearTimeout(_fpClampT);
_fpClampT = setTimeout(function () { _fpClampT = null; floatClampSig = ''; clampFloatPos(); }, 300);
});
}
function addRecord(trackId, triggerType) {
const m = findTrack(trackId);
history.push({ id: 'smh_' + Date.now(), trackId: trackId, trackName: m ? (m.name || '未知歌曲') : '未知歌曲', cover: m ? (m.cover || '') : '', triggerType: triggerType, ts: Date.now() });
if (history.length > 500) history = history.slice(-500);
saveHistory();
renderHistory();
}
function addModeRecord(modeLabel) {
history.push({ id: 'smh_' + Date.now(), trackId: '', trackName: '', triggerType: 'TA 把播放模式换成' + modeLabel, mode: true, ts: Date.now() });
if (history.length > 500) history = history.slice(-500);
saveHistory();
renderHistory();
}
function addMyRecord(trackId) {
const m = findTrack(trackId);
myHistory.push({ id: 'smymh_' + Date.now(), trackId: trackId, trackName: m ? (m.name || '未知歌曲') : '未知歌曲', cover: m ? (m.cover || '') : '', ts: Date.now() });
if (myHistory.length > 500) myHistory = myHistory.slice(-500);
saveMyHistory();
if (curTab === 'his' && hisSubTab === 'mine') renderHistory();
}
function openSongMenu(id) {
const m = findTrack(id);
if (!m) return;
if (!window.openTCPanel) return;
const plOpts = playlists.map(p => '<option value="' + p.id + '"' + (m.playlistId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
window.openTCPanel('管理音乐', '' +
'<div class="sm-fld"><label>快捷操作</label><div class="sm-quick-actions">' +
'<button class="cc-tool" id="sm-e-qnext">下一首播放</button>' +
'<button class="cc-tool" id="sm-e-qpl">加入播放列表</button>' +
'<button class="cc-tool" id="sm-e-ta-ask">邀请 TA 一起听</button>' +
'<button class="cc-tool" id="sm-e-ta-inv">让 TA 邀我听这首</button>' +
'</div></div>' +
'<div class="sm-fld"><label>歌曲名称</label><input class="tc-input" id="sm-e-name" value="' + String(m.name || '').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"></div>' +
'<div class="sm-fld"><label>歌手</label><input class="tc-input" id="sm-e-artist" value="' + String(m.artist || '').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"></div>' +
'<div class="sm-fld"><label>所属歌单</label><select class="tc-input" id="sm-e-pl"><option value="default">我的音乐库</option>' + plOpts + '</select></div>' +
'<div class="sm-fld"><label>歌曲封面</label>' +
'<div class="sm-cov-row">' +
'<div class="sm-cov-prev' + (m.cover ? ' has-cov' : '') + '" id="sm-e-cov-prev"' + (m.cover ? ' style="background-image:url(\'' + esc(m.cover) + '\')"' : '') + ' title="点击上传封面"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg></div>' +
'<div class="sm-cov-actions"><button class="cc-tool sm-cov-btn" id="sm-e-cov-up">上传封面</button><button class="cc-tool sm-cov-btn" id="sm-e-cov-clear"' + (m.cover ? '' : ' hidden') + '>清除封面</button></div>' +
'</div></div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-e-del">删除</button><button class="cc-tool" id="sm-e-cancel">取消</button><button class="cc-tool" id="sm-e-ok">保存</button></div>');
const covPrev = document.getElementById('sm-e-cov-prev');
const covUp = document.getElementById('sm-e-cov-up');
const covClear = document.getElementById('sm-e-cov-clear');
const covPickOpts = {
id: 'mochi-track-cover-pick', accept: 'image/*',
onFiles: function (files) {
const f = files && files[0];
if (!f) { toast('没有取到图片，请再选一次'); return; }
compressCover(f, function (dv) {
if (!dv) { toast('封面读取失败，请换一张图片'); return; }
m.cover = dv;
saveLibrary();
renderPage();
covPrev.classList.add('has-cov');
covPrev.style.backgroundImage = 'url(\'' + dv + '\')';
covClear.hidden = false;
toast('封面已设置');
});
}
};
window.mochiFilePick({ id: 'mochi-track-cover-pick', accept: 'image/*', noClick: true, onFiles: covPickOpts.onFiles });
const pickCover = () => { try { window.mochiFilePick(covPickOpts); } catch (e) {} };
const onPickBtn = (btn) => {
if (!btn) return;
if (window.mochiFilePickLabel) window.mochiFilePickLabel(btn, document.getElementById('mochi-track-cover-pick'));
btn.addEventListener('click', (e) => {
const _input = document.getElementById('mochi-track-cover-pick');
if (_input && window.mochiFilePickGuard) window.mochiFilePickGuard(_input, pickCover);
else pickCover();
});
};
onPickBtn(covUp);
onPickBtn(covPrev);
if (covClear) covClear.addEventListener('click', () => {
m.cover = '';
saveLibrary();
renderPage();
covPrev.classList.remove('has-cov');
covPrev.style.backgroundImage = '';
covClear.hidden = true;
toast('已清除封面');
});
document.getElementById('sm-e-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
const qnext = document.getElementById('sm-e-qnext');
if (qnext) qnext.addEventListener('click', () => {
addToQueue(id);
document.getElementById('tc-mask').hidden = true;
toast('已加入播放队列，播完当前将播放');
});
const qpl = document.getElementById('sm-e-qpl');
if (qpl) qpl.addEventListener('click', () => {
if (!window.openTCPanel) return;
const opts = playlists.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('');
window.openTCPanel('加入播放列表', '<div class="sm-fld"><label>选择歌单</label><select class="tc-input" id="sm-qpl-sel"><option value="default">我的音乐库</option>' + opts + '</select></div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-qpl-cancel">取消</button><button class="cc-tool" id="sm-qpl-ok">加入</button></div>');
document.getElementById('sm-qpl-cancel').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('sm-qpl-ok').addEventListener('click', () => {
m.playlistId = document.getElementById('sm-qpl-sel').value;
saveLibrary();
document.getElementById('tc-mask').hidden = true;
renderPage();
toast('已加入播放列表');
});
});
const taAsk = document.getElementById('sm-e-ta-ask');
if (taAsk) taAsk.addEventListener('click', () => {
document.getElementById('tc-mask').hidden = true;
inviteTaToListen(id);
});
const taInv = document.getElementById('sm-e-ta-inv');
if (taInv) taInv.addEventListener('click', () => { forceTaInviteFor(id); });
document.getElementById('sm-e-ok').addEventListener('click', () => {
m.name = (document.getElementById('sm-e-name').value || '').trim() || m.name;
m.artist = (document.getElementById('sm-e-artist').value || '').trim();
m.playlistId = document.getElementById('sm-e-pl').value;
saveLibrary();
document.getElementById('tc-mask').hidden = true;
renderPage();
toast('已保存');
});
document.getElementById('sm-e-del').addEventListener('click', () => {
if (window.openModal) {
window.openModal('删除这首音乐？', '', () => {
library = library.filter(x => x.id !== id);
if (window.idbGetAllKeys) {
window.idbGetAllKeys().then(keys => {
keys.filter(k => k === MUSIC_PREFIX + ':music-file:' + id).forEach(k => {
if (window.idbDelete) window.idbDelete(k);
});
});
}
if (currentId === id) { teardownAudio(); currentId = null; }
saveLibrary();
document.getElementById('tc-mask').hidden = true;
renderPage();
toast('已删除');
}, { noInput: true });
}
});
}
let invitePlayCheckTimer = null;
let inviteCheckStage = 0;
function armInvitePlayCheck() {
try {
if (invitePlayCheckTimer) clearTimeout(invitePlayCheckTimer);
inviteCheckStage = 0;
invitePlayCheckTimer = setTimeout(invitePlayCheckStep, 4000);
} catch (e) {}
}
function invitePlayCheckStep() {
invitePlayCheckTimer = null;
try {
if (!currentId) return; // 曲目加载失败等路径已有各自的 toast，不重复打扰
if (failedPlaybackId === currentId) return; // 确认播放失败后，不让邀请兜底再次拉起坏链
if (!audio) {
if (inviteCheckStage === 0) { inviteCheckStage = 1; invitePlayCheckTimer = setTimeout(invitePlayCheckStep, 5000); return; }
if (inviteCheckStage === 1) {
inviteCheckStage = 2;
const retryId = currentId;
try { toast('本地音乐读取较慢，正在重试…'); } catch (e) {}
try { playTrack(retryId); } catch (e) {}
invitePlayCheckTimer = setTimeout(invitePlayCheckStep, 5000);
return;
}
try { armAutoResume(); toast('音乐没能播放出来：点一下屏幕任意位置再试，或在播放列表换一首'); } catch (e) {}
return;
}
if (!audio.paused) return;        // 在播或在缓冲＝健康，交给停滞守卫盯
const p = audio.play();
if (p && p.catch) p.catch(function () {
if (!audio) return;
try { audio.muted = true; } catch (e) {}
const p2 = audio.play();
if (p2 && p2.then) p2.then(
function () { try { if (audio) audio.muted = false; } catch (e) {} },
function () { try { if (audio) audio.muted = false; } catch (e) {} armAutoResume(); try { toast('音乐没能自动播出来，点一下屏幕任意位置即可开始'); } catch (e) {} }
);
});
} catch (e) {}
}
function inviteStaleToast(name) {
reqData = null;
try { toast('已切换联系人，这份听歌邀请已失效，可以让 ' + name + ' 再邀一次'); } catch (e) {}
}
function prewarmLocalAudio(id) {
try {
const m = findTrack(id);
if (!m || !(m.source === 'local' || (!m.url && m.source !== 'url'))) return;
if (localBlobCache[id]) return;
const lsV = store.get('music-file:' + id);
if (plausibleLocalValue(lsV)) { localBlobCache[id] = lsV; return; }
if (!window.idbGet) return;
window.idbGet(MUSIC_PREFIX + ':music-file:' + id).then(function (v) {
if (plausibleLocalValue(v) && !localBlobCache[id]) localBlobCache[id] = v;
});
} catch (e) {}
}
function musicInviteCopy(name, trackName, namedInvite) {
const card = window.taInvitePickKind ? window.taInvitePickKind('music') : null;
if (!card || !String(card.text || '').trim()) return null;
const raw = String(card.text).trim();
const song = '《' + trackName + '》';
const hasSongSlot = raw.includes('{歌名}');
const phrase = raw.replace(/\{歌名\}/g, namedInvite ? '这首歌' : song);
const detail = (namedInvite ? '现在就想要一起听' + song + '。' : '') +
phrase + (!namedInvite && !hasSongSlot ? '（' + song + '）' : '');
return { message: name + '对你发送了听歌邀请~', detail };
}
function sendMusicInviteLine(message) {
try { if (window.chatAddIn) window.chatAddIn(message, { special: 'poke', initiative: true, silent: true }); } catch (e) {}
}
function sendNamedSongCard(track, label) {
if (!track || !window.chatAddIn) return;
const title = String(track.name || track.title || '').trim();
if (!title) return;
const artist = String(track.artist || '').trim();
const cover = String(track.cover || track.picUrl || track.pic || '');
try { window.chatAddIn(title + (artist ? ' · ' + artist : ''), {
special: 'music-song', quote: label, img: cover, initiative: true,
nightAllow: true, rateAllow: true, silent: true
}); } catch (e) {}
}
function openMusicInvitePanel(trackId, switching) {
return openMusicInvitePanelWithCopy(trackId, switching, false, false);
}
function openDefaultQueueMusicInvitePanel(trackId, switching) {
return openMusicInvitePanelWithCopy(trackId, switching, false, true);
}
function openMusicInvitePanelWithCopy(trackId, switching, namedInvite, defaultQueueInvite, onlineFallbackName) {
const track = findTrack(trackId) || (onlineFallbackName ? { name: onlineFallbackName } : null);
if (!track) return false;
const myCid = window.__activeCid || 'default'; // 多桌面：弹窗期间切换联系人后点按钮不得写到新桌面
const name = partnerName();
const trackName = track.name || '未知歌曲';
const inviteCopy = musicInviteCopy(name, trackName, namedInvite);
if (!inviteCopy) return false;
reqData = { trackId: trackId, switching: !!switching };
taActive = true;
if (!window.openTCPanel) return false;
window.openTCPanel('音乐', '' +
'<div class="sm-req">' +
'<div class="sm-req-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>' +
'<div class="sm-req-hint">' + esc(name + '对你发送了听歌邀请~') + '</div>' +
'<div class="sm-req-name">《' + esc(trackName) + '》</div>' +
'<div class="sm-req-detail">' + esc(inviteCopy.detail) + '</div>' +
'</div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-req-no">稍后</button><button class="cc-tool" id="sm-req-yes">' + (switching ? '切过去' : '一起听') + '</button></div>');
const noBtn = document.getElementById('sm-req-no');
const yesBtn = document.getElementById('sm-req-yes');
if (!noBtn || !yesBtn) return false;
sendMusicInviteLine(inviteCopy.message);
if (namedInvite) sendNamedSongCard(track, 'TA 邀请你听这首歌');
noBtn.addEventListener('click', () => {
document.getElementById('tc-mask').hidden = true;
if ((window.__activeCid || 'default') !== myCid) { inviteStaleToast(name); return; }
reqData = null;
history.push({ id: 'smh_' + Date.now(), trackId: '', trackName: '', triggerType: '拒绝了 TA 的听歌邀请《' + esc(trackName) + '》', rejected: true, ts: Date.now() });
if (history.length > 500) history = history.slice(-500);
saveHistory(); renderHistory();
taMusicSys('你拒绝了 ' + name + ' 的听歌邀请', true);
if (window.chatInviteDecline) window.chatInviteDecline('music');
});
yesBtn.addEventListener('click', () => {
document.getElementById('tc-mask').hidden = true;
if ((window.__activeCid || 'default') !== myCid) { inviteStaleToast(name); return; }
if (!reqData) return; // 连点两次只认第一次
const switchNow = !!reqData.switching;
reqData = null;
if (onlineFallbackName) {
taMusicSys('你接受了 ' + name + ' 的听歌邀请，正在找《' + trackName + '》', true);
searchAndPlayOnlineSong(onlineFallbackName, '《' + trackName + '》', '接受了 TA 的在线听歌邀请');
return;
}
const remoteAbsent = defaultQueueInvite && !(window.mochiNeteaseSessionAvailable && window.mochiNeteaseSessionAvailable());
if (remoteAbsent) {
const queued = window.mochiMusicQueuedTracks ? window.mochiMusicQueuedTracks() : [];
const first = queued.find(item => item.id === trackId) || queued[0];
if (!first || !window.mochiMusicPlayQueuedTrack(first.id, '要打开网易云哦')) { playbackPrompt('要打开网易云哦'); return; }
window.mochiMusicTogetherForce('mochi', first.id);
addRecord(first.id, '接受了 TA 的听歌邀请');
taMusicSys('你接受了 ' + name + ' 的听歌邀请，一起听《' + first.title + '》', true);
renderFloat();
return;
}
if (!findTrack(trackId)) {
playbackPrompt(remoteAbsent ? '要打开网易云哦' : '需要手动播放哦');
return;
}
callHoldPlaying = false; callHoldPending = false; // #904a
expectPlayback(trackId, remoteAbsent ? '要打开网易云哦' : '需要手动播放哦');
window.mochiMusicTogetherForce('mochi', trackId);
playTrack(trackId, false, true);
inviteReturnTrackId = trackId;
addRecord(trackId, '接受了 TA 的听歌邀请');
taMusicSys(switchNow
? '你接受了邀请，已切换到《' + trackName + '》'
: '你接受了 ' + name + ' 的听歌邀请，一起听《' + trackName + '》', true);
armInvitePlayCheck(); // #904b
renderFloat(); // #904a：hold 藏起的小框随新播放意图立刻恢复（本地歌异步起播由 onplay 再刷新）
});
return true;
}
function openRemoteMusicInvitePanel(track, switching, namedInvite) {
if (!track || !track.id || !window.openTCPanel || !window.mochiNeteasePlayQueueItem) return false;
const myCid = window.__activeCid || 'default';
const name = partnerName();
const title = track.title || '未知歌曲';
const inviteCopy = musicInviteCopy(name, title, namedInvite);
if (!inviteCopy) return false;
reqData = { trackId: 'netease:' + track.id, switching: !!switching };
window.openTCPanel('音乐', '<div class="sm-req">' +
'<div class="sm-req-hint">' + esc(name + '对你发送了听歌邀请~') + '</div>' +
'<div class="sm-req-name">《' + esc(title) + '》</div><div class="sm-req-detail">' + esc(inviteCopy.detail) + '</div><div class="sm-req-hint">由网易云音乐播放</div></div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-req-no">稍后</button><button class="cc-tool" id="sm-req-yes">' + (switching ? '切过去' : '一起听') + '</button></div>');
const noBtn = document.getElementById('sm-req-no');
const yesBtn = document.getElementById('sm-req-yes');
if (!noBtn || !yesBtn) { reqData = null; return false; }
sendMusicInviteLine(inviteCopy.message);
noBtn.addEventListener('click', () => {
document.getElementById('tc-mask').hidden = true;
if ((window.__activeCid || 'default') !== myCid) { inviteStaleToast(name); return; }
reqData = null;
history.push({ id: 'smh_' + Date.now(), trackId: '', trackName: title, triggerType: '拒绝了 TA 的网易云听歌邀请', rejected: true, ts: Date.now() });
if (history.length > 500) history = history.slice(-500);
saveHistory(); renderHistory();
taMusicSys('你拒绝了 ' + name + ' 的听歌邀请', true);
if (window.chatInviteDecline) window.chatInviteDecline('music');
});
yesBtn.addEventListener('click', () => {
document.getElementById('tc-mask').hidden = true;
if ((window.__activeCid || 'default') !== myCid) { inviteStaleToast(name); return; }
if (!reqData) return;
reqData = null;
if (!window.mochiNeteasePlayQueueItem(track.id)) return;
window.mochiMusicTogetherForce('netease', String(track.id));
history.push({ id: 'smh_' + Date.now(), trackId: '', trackName: title, triggerType: '接受了 TA 的网易云听歌邀请', ts: Date.now() });
if (history.length > 500) history = history.slice(-500);
saveHistory(); renderHistory();
taMusicSys('你接受了 ' + name + ' 的听歌邀请，已请求网易云播放《' + title + '》', true);
});
return true;
}
let myInvitePending = false; // 在飞一条＝不再收第二条（回应最远 4s 落地，落定了随时能再邀＝不是掐表不许试）
function pendingInviteOnScreen() {
const m = document.getElementById('tc-mask');
return !!(reqData && m && !m.hidden && document.getElementById('sm-req-yes'));
}
function inviteTaToListen(trackId) {
const track = findTrack(trackId);
if (!track) { toast('这首已不在音乐库里'); return; }
if (reqData && !pendingInviteOnScreen()) reqData = null; // 被别的面板顶掉的旧邀请：交还，不拿它锁门
if (pendingInviteOnScreen()) { toast('已经有一条听歌邀请等你确认了'); return; }
if (myInvitePending) { toast('刚才那条还在等 TA 回，先看这一条'); return; }
myInvitePending = true;
const myCid = window.__activeCid || 'default'; // 多桌面：回应落地时不得写到新桌面（同 #994 面板口径）
const name = partnerName();
const trackName = track.name || '未知歌曲';
const artist = track.artist ? ' - ' + track.artist : '';
taMusicSys('你邀请 ' + name + ' 一起听《' + trackName + '》' + artist);
toast('已邀请 TA，回应会落在聊天里');
setTimeout(function () {
myInvitePending = false; // 四条出口共用这一行先交还：在飞标志不许有第二种持久的伪状态
if ((window.__activeCid || 'default') !== myCid) return;
const say = function (group, fb) {
const pool = window.getInteractPool ? window.getInteractPool(group, fb) : fb;
return window.pickAskCardReply ? window.pickAskCardReply(pool) : pool[Math.floor(Math.random() * pool.length)];
};
const accept = function (line) {
if (line) taMusicSay(line);
if (!findTrack(trackId)) { toast('《' + trackName + '》已不在音乐库里，无法播放'); return; }
taActive = true;
callHoldPlaying = false; callHoldPending = false;
myInviteListening = true;
myInviteAwaitingUntil = Date.now() + 30000;
window.mochiMusicTogetherForce('mochi', trackId);
playTrack(trackId);
taMusicSys('你邀请 ' + name + ' 一起听《' + trackName + '》' + artist + '，TA 同意了一起听', true);
armInvitePlayCheck();
renderFloat();
};
const roll = Math.random();
if (roll < 0.6) { accept(say('音乐邀请TA·同意', ['一起听呀。', '放吧，我靠近一点。', '这首好，就听它。'])); return; }
if (roll < 0.85) {
taMusicSay(say('音乐邀请TA·拒绝', ['这首现在不想听嘛。', '待会儿再听好不好？']));
taMusicSys(name + ' 这次没答应，说待会儿再听《' + trackName + '》');
return;
}
taMusicSay(say('音乐邀请TA·换一首', ['这首听腻啦，换一首嘛～', '换一首行不行？']));
const others = library.filter(x => x && x.id !== trackId);
if (!others.length) { accept('库里就这一首嘛……那就它吧。'); return; }
const pick = others[Math.floor(Math.random() * others.length)];
cooldownAt = Date.now(); // 与概率路径共用冷却＝同一发不再紧接着自然弹出第二条把你这条盖掉
if (!openMusicRequestPanel('named', pick, '')) {
reqData = null; // 面板没画出来就别把 reqData 留成「有待确认邀请」，否则之后每次都撞上面那道闸
toast('TA 想换的那首没能弹出邀请（曲库或弹层不可用）');
return;
}
prewarmLocalAudio(pick.id);
}, 1500 + Math.random() * 2500);
}
function forceTaInviteFor(trackId) {
if (!findTrack(trackId)) { toast('这首已不在音乐库里'); return; }
if (reqData && !pendingInviteOnScreen()) reqData = null; // 同上：被顶掉的旧邀请不许把这条路锁死
if (pendingInviteOnScreen()) { toast('已经有一条听歌邀请等你确认了'); return; }
cooldownAt = Date.now();
if (!openMusicRequestPanel('named', findTrack(trackId), '')) {
reqData = null;
cooldownAt = 0; // 没弹成就不该占着冷却窗，把这条自然触发的机会白白吃掉
toast('邀请没能弹出来：音乐页弹层不可用，可去 音乐设置 → 诊断邀请 看读数');
return;
}
prewarmLocalAudio(trackId);
}
let onlineSearchSerial = 0;
function musicKeywordCards() {
const raw = window.getCustomFuncCards ? window.getCustomFuncCards('musicKeyword') : [];
return (Array.isArray(raw) ? raw : []).map(value => String(value || '').trim()).filter(value => value && value.length <= 80);
}
function finishMusicInviteFlow(flow) {
if (!flow || inviteFlow !== flow) return;
if (flow.timer) clearTimeout(flow.timer);
if (flow.poll) clearInterval(flow.poll);
if (flow.remotePoll) clearInterval(flow.remotePoll);
if (flow.remoteTimer) clearTimeout(flow.remoteTimer);
inviteFlow = null;
}
function musicInviteHasPlayback() {
if (currentId && audio && !audio.paused && !audio.ended) return true;
const remote = window.mochiNeteasePlaybackSnapshot && window.mochiNeteasePlaybackSnapshot();
return !!(remote && remote.playing);
}
function startNextMusicInviteLocal(flow) {
let track = null;
while (flow.localCandidates && flow.localCandidates.length && !track) {
track = findTrack(flow.localCandidates.shift());
}
if (!track) return false;
flow.waiting = true;
flow.localTrackId = track.id;
expectPlayback(track.id, '需要手动播放哦', null, 20000);
taActive = true;
callHoldPlaying = false; callHoldPending = false;
if (window.mochiMusicTogetherForce) window.mochiMusicTogetherForce('mochi', track.id);
playTrack(track.id, false, true);
inviteReturnTrackId = track.id;
inviteResumeGuardUntil = Date.now() + 30000;
armInvitePlayCheck();
return true;
}
function startMusicInviteLocal(flow, tracks) {
flow.localCandidates = Array.from(new Set(tracks.filter(item => item && item.id).map(item => item.id)));
return startNextMusicInviteLocal(flow);
}
function musicInviteRemote(flow, named) {
const remote = window.mochiNeteasePlaybackSnapshot && window.mochiNeteasePlaybackSnapshot();
if (!remote || !remote.available) return false;
const selecting = !!(named && flow.track && flow.track.source === 'netease');
const requested = selecting && window.mochiNeteasePlayQueueItem
? window.mochiNeteasePlayQueueItem(flow.track.id)
: window.mochiNeteasePlayCurrent && window.mochiNeteasePlayCurrent();
if (!requested) return false;
taActive = true;
if (selecting && currentId && window.mochiNeteaseSharedActive && !window.mochiNeteaseSharedActive()) {
if (window.mochiMusicTogetherForce) window.mochiMusicTogetherForce('mochi', currentId);
return true;
}
const heard = () => {
const state = window.mochiNeteasePlaybackSnapshot && window.mochiNeteasePlaybackSnapshot();
return !!(state && state.playing && (!selecting || state.queueId === String(flow.track.id) || state.title === flow.track.title));
};
if (heard()) {
if (window.mochiNeteaseTogetherForceCurrent) window.mochiNeteaseTogetherForceCurrent();
return true;
}
flow.waiting = true;
flow.remotePoll = setInterval(() => {
if (inviteFlow !== flow || !heard()) return;
if (window.mochiNeteaseTogetherForceCurrent) window.mochiNeteaseTogetherForceCurrent();
finishMusicInviteFlow(flow);
}, 500);
flow.remoteTimer = setTimeout(() => {
if (inviteFlow !== flow) return;
clearInterval(flow.remotePoll); flow.remotePoll = null;
flow.waiting = false;
runMusicInviteStep(flow);
}, 12000);
return true;
}
function runMusicInviteStep(flow) {
if (inviteFlow !== flow || flow.waiting) return;
while (inviteFlow === flow && flow.index < flow.steps.length) {
const step = flow.steps[flow.index++];
if (step === 'remote') {
if (musicInviteRemote(flow, flow.kind === 'named')) { if (!flow.waiting) finishMusicInviteFlow(flow); return; }
} else if (step === 'openRemote') {
const remote = window.mochiNeteasePlaybackSnapshot && window.mochiNeteasePlaybackSnapshot();
if (!remote || !remote.available) playbackPrompt('要打开网易云哦');
} else if (step === 'namedLocal') {
if (flow.track && flow.track.source !== 'netease' && startMusicInviteLocal(flow, [flow.track])) return;
} else if (step === 'default') {
const queued = (window.mochiMusicQueuedTracks ? window.mochiMusicQueuedTracks() : [])
.map(item => findTrack(item.id)).filter(Boolean);
const defaults = library.filter(item => item && (item.playlistId === 'spl_default' || item.playlistId === 'default' || !item.playlistId));
if (startMusicInviteLocal(flow, queued.concat(defaults))) return;
} else if (step === 'online') {
const keyword = flow.kind === 'named' ? flow.trackName : flow.keyword;
if (keyword) {
flow.waiting = true;
searchAndPlayOnlineSong(keyword, flow.kind === 'named' ? '《' + keyword + '》' : keyword + '类型的歌',
'接受了 TA 的在线听歌邀请', null, false, flow);
return;
}
} else if (step === 'manual') {
if (flow.kind === 'plain' && Date.now() < flow.deadline) {
flow.index--;
return;
}
playbackPrompt(flow.kind === 'plain' ? '需要手动播放哦' : 'TA想听' +
(flow.kind === 'named' ? '《' + flow.trackName + '》' : flow.keyword + '类型的歌') + '，需要你帮忙播放哦');
}
}
finishMusicInviteFlow(flow);
}
function acceptMusicInvite(kind, track, keyword) {
if (inviteFlow) finishMusicInviteFlow(inviteFlow);
officialInvitePending = null;
const waitMs = Math.max(0, Math.min(3600000, Number(settings.inviteWaitMs) || 0));
if (kind === 'plain' && !keyword) {
const keywords = musicKeywordCards();
keyword = keywords.length ? keywords[Math.floor(Math.random() * keywords.length)] : '流行';
}
const flow = { kind, track: track || null, trackName: String(track && (track.name || track.title) || ''),
keyword: String(keyword || ''), index: 0, waiting: false, localTrackId: null, timer: null, poll: null,
deadline: Date.now() + waitMs,
steps: kind === 'plain' ? ['remote', 'openRemote', 'default', 'online', 'manual']
: kind === 'named' ? ['namedLocal', 'online', 'manual', 'remote', 'openRemote', 'default']
: ['online', 'manual', 'remote', 'openRemote', 'default'] };
inviteFlow = flow;
if (kind === 'plain') {
flow.timer = setTimeout(() => {
if (inviteFlow !== flow) return;
if (musicInviteHasPlayback()) { finishMusicInviteFlow(flow); return; }
if (flow.waiting) {
onlineAttempt = null; onlineSearchSerial++;
if (expectedPlayback && expectedPlayback.id === flow.localTrackId) clearExpectedPlayback();
if (flow.localTrackId && currentId === flow.localTrackId) { teardownAudio(); currentId = null; }
flow.waiting = false;
flow.index = flow.steps.length - 1;
}
runMusicInviteStep(flow);
}, waitMs);
flow.poll = setInterval(() => { if (inviteFlow === flow && musicInviteHasPlayback()) finishMusicInviteFlow(flow); }, 1000);
}
runMusicInviteStep(flow);
}
window.mochiMusicMyInviteAccepted = function (cid) {
if ((window.__activeCid || 'default') !== cid) return;
myInviteListening = true;
myInviteAwaitingUntil = Date.now() + 30000;
if (window.mochiNeteaseIsPlaying && window.mochiNeteaseIsPlaying()) {
if (window.mochiNeteaseTogetherForceCurrent) window.mochiNeteaseTogetherForceCurrent();
return;
}
if (currentId && audio && !audio.paused && !audio.ended) {
window.mochiMusicTogetherForce('mochi', currentId);
return;
}
if (window.mochiNeteaseSessionAvailable && window.mochiNeteaseSessionAvailable() &&
window.mochiNeteasePlayCurrent && window.mochiNeteasePlayCurrent()) return;
const queued = (window.mochiMusicQueuedTracks ? window.mochiMusicQueuedTracks() : [])
.map(item => findTrack(item.id)).filter(Boolean);
const defaults = library.filter(item => item && (item.playlistId === 'spl_default' || item.playlistId === 'default' || !item.playlistId));
const track = queued.concat(defaults)[0];
if (!track) { myInviteListening = false; myInviteAwaitingUntil = 0; playbackPrompt('需要手动播放哦'); return; }
taActive = true;
callHoldPlaying = false; callHoldPending = false;
window.mochiMusicTogetherForce('mochi', track.id);
playTrack(track.id);
armInvitePlayCheck();
};
function openMusicRequestPanel(kind, track, keyword) {
if (!window.openTCPanel) return false;
const card = window.taInvitePickKind ? window.taInvitePickKind('music') : null;
if (!card || !String(card.text || '').trim()) return false;
const name = partnerName();
const cid = window.__activeCid || 'default';
const title = String(track && (track.name || track.title) || '');
const subject = kind === 'named' ? '《' + title + '》' : kind === 'keyword' ? keyword + '风格的歌曲' : '';
const raw = String(card.text).trim();
const keywordSong = '一首' + keyword + '风格的歌';
const text = kind === 'keyword' && raw.includes('{歌名}')
? (raw.replace(/\{歌名\}/g, keywordSong).replace(/^找到一首/, '想找一首'))
: raw.includes('{歌名}') ? raw.replace(/\{歌名\}/g, kind === 'plain' ? '歌' : subject)
: kind === 'plain' ? raw : '想和你一起听' + subject + '：' + raw;
const message = name + '对你发送了听歌邀请~';
const recordInvite = rejected => {
const local = track && findTrack(track.id);
history.push({ id: 'smh_' + Date.now(), trackId: local ? local.id : '',
trackName: kind === 'named' ? title : kind === 'keyword' ? keyword + '风格的歌曲' : '',
cover: local ? (local.cover || '') : '',
triggerType: rejected ? '拒绝了 TA 的听歌邀请' : '接受了 TA 的听歌邀请',
rejected: !!rejected, ts: Date.now() });
if (history.length > 500) history = history.slice(-500);
saveHistory(); renderHistory();
};
window.openTCPanel('音乐', '<div class="sm-req"><div class="sm-req-hint">' + esc(name + '对你发送了听歌邀请~') +
'</div>' + (subject ? '<div class="sm-req-name">' + esc(subject) + '</div>' : '') +
'<div class="sm-req-detail">' + esc(text) + '</div>' +
'</div><div class="mail-actions"><button class="cc-tool" id="sm-req-no">稍后</button>' +
'<button class="cc-tool" id="sm-req-yes">一起听</button></div>');
const no = document.getElementById('sm-req-no');
const yes = document.getElementById('sm-req-yes');
if (!no || !yes) return false;
sendMusicInviteLine(message);
if (kind === 'named') sendNamedSongCard(track, 'TA 邀请你听这首歌');
let answered = false;
const close = () => { document.getElementById('tc-mask').hidden = true; };
no.addEventListener('click', () => {
if (answered) return; answered = true; close();
if ((window.__activeCid || 'default') !== cid) { inviteStaleToast(name); return; }
recordInvite(true);
taMusicSys('你拒绝了 ' + name + ' 的听歌邀请', true);
if (window.chatInviteDecline) window.chatInviteDecline('music');
});
yes.addEventListener('click', () => {
if (answered) return; answered = true; close();
if ((window.__activeCid || 'default') !== cid) { inviteStaleToast(name); return; }
recordInvite(false);
taMusicSys('你接受了 ' + name + ' 的听歌邀请', true);
acceptMusicInvite(kind, track, keyword);
});
return true;
}
let onlineNativeSerial = 0;
const onlineNativePending = new Map();
window.ciciOnlineMusicResponse = function (token, raw) {
const pending = onlineNativePending.get(String(token));
if (!pending) return;
onlineNativePending.delete(String(token));
clearTimeout(pending.timer);
try {
const data = JSON.parse(raw);
if (!data || data.code !== 200) throw new Error('在线歌曲不可用');
pending.resolve(data);
} catch (error) { pending.reject(error); }
};
function validOnlineEndpoint(value) {
if (!value || value.length > 2048 || value.includes('#')) return false;
try {
const url = new URL(value);
return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
} catch (e) { return false; }
}
function onlineSongJson(type, value, endpoint) {
if (window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn())
return window.ciciNeteaseEnhanced.onlineSongJson(type, value);
const queryValue = value && typeof value === 'object' ? String(value.id || '') : String(value);
if (endpoint && !validOnlineEndpoint(endpoint)) return Promise.reject(new Error('在线音乐接口地址无效'));
if (!window.CiCiMusicApi || typeof window.CiCiMusicApi.request !== 'function') {
if (!endpoint) return Promise.reject(new Error('当前版本没有在线音乐接口'));
const url = new URL(endpoint);
url.searchParams.append('type', type);
url.searchParams.append(type === 'search' || type === 'style' ? 'keywords' : 'id', queryValue);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20000);
return fetch(url.href, { signal: controller.signal, headers: { Accept: 'application/json' } })
.then(response => { if (!response.ok) throw new Error('在线音乐接口请求失败'); return response.json(); })
.then(data => { if (!data || Number(data.code) !== 200) throw new Error('在线音乐接口数据无效'); return data; })
.finally(() => clearTimeout(timer));
}
return new Promise((resolve, reject) => {
const token = String(++onlineNativeSerial);
const timer = setTimeout(() => {
onlineNativePending.delete(token);
reject(new Error('在线音乐请求超时'));
}, 45000);
onlineNativePending.set(token, { resolve, reject, timer });
try { window.CiCiMusicApi.request(token, type, queryValue, endpoint || ''); }
catch (error) {
onlineNativePending.delete(token);
clearTimeout(timer);
reject(error);
}
});
}
window.ciciMusicLyricRequest = function (type, value) {
return onlineSongJson(type, value, String(settings.onlineApiUrl || '').trim());
};
function onlineAttemptCurrent(attempt) {
return onlineAttempt === attempt && attempt.serial === onlineSearchSerial &&
(window.__activeCid || 'default') === attempt.cid && !document.hidden &&
currentId === attempt.expectedCurrentId;
}
function removeFailedRecommendationInsert(id) {
const session = recommendationSession;
const track = findTrack(id);
if (!session || !track || track.playlistId === session.pid) return;
const index = session.ids.indexOf(id);
if (index < 0) return;
session.ids.splice(index, 1);
if (session.index >= index) session.index = Math.max(0, session.index - 1);
}
function finishTemporaryOnlineFailure(id) {
const attempt = onlineAttempt;
if (!attempt || temporaryOnlineId !== id || attempt.trackId !== id || !onlineAttemptCurrent(attempt)) return;
if (attempt.playbackSource === 'netease' && !attempt.fallbackTried &&
window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn()) {
attempt.fallbackTried = true;
const track = findTrack(id);
clearExpectedPlayback();
teardownAudio();
if (track) {
window.ciciNeteaseEnhanced.fallbackTrack(track).then(result => {
if (!onlineAttemptCurrent(attempt) || attempt.trackId !== id) return;
attempt.playbackSource = result.source || 'fallback';
expectPlayback(id, attempt.failureText, () => finishTemporaryOnlineFailure(id), 20000);
playTrack(id, false, true, result.url, attempt.playbackSource);
}).catch(() => { if (onlineAttemptCurrent(attempt)) finishTemporaryOnlineFailure(id); });
return;
}
}
temporaryOnlineId = null;
temporaryOnlinePrompt = '';
removeFailedRecommendationInsert(id);
clearExpectedPlayback();
teardownAudio();
currentId = null;
if (temporaryOnlineCreatedId === id) {
library = library.filter(item => item.id !== id);
saveLibrary();
} else if (temporaryOnlineBackup) {
const track = findTrack(id);
if (track) {
track.url = temporaryOnlineBackup.url;
track.source = temporaryOnlineBackup.source;
if (temporaryOnlineBackup.hasLrc) track.lrc = temporaryOnlineBackup.lrc;
else delete track.lrc;
saveLibrary();
}
}
temporaryOnlineCreatedId = null;
temporaryOnlineBackup = null;
attempt.trackId = null;
attempt.expectedCurrentId = null;
if (attempt.styleStream) attempt.failureStreak++;
renderPage();
void tryNextOnlineCandidate(attempt);
}
async function tryNextOnlineCandidate(attempt) {
while (onlineAttemptCurrent(attempt) && attempt.candidates.length &&
(attempt.styleStream ? attempt.failureStreak < 3 : attempt.nextIndex < attempt.candidates.length)) {
const song = attempt.candidates[attempt.styleStream
? attempt.nextIndex++ % attempt.candidates.length : attempt.nextIndex++];
if (!song || !song.id || !song.name) { if (attempt.styleStream) attempt.failureStreak++; continue; }
const prefetched = attempt.reservation && attempt.reservation.first &&
String(attempt.reservation.first.song.id) === String(song.id) ? attempt.reservation.first : null;
if (prefetched) attempt.reservation.first = null;
let rawUrl = prefetched && prefetched.url;
if (window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn()) rawUrl = null;
let address = null;
if (!rawUrl) {
try { address = await onlineSongJson('url', song, attempt.endpoint); }
catch (e) { if (attempt.styleStream) attempt.failureStreak++; continue; }
if (!onlineAttemptCurrent(attempt)) return false;
rawUrl = address.data && address.data[0] && address.data[0].url;
}
if (!validAudioSrc(rawUrl) || (!prefetched && onlinePreviewOnly(song, address))) {
if (attempt.styleStream) attempt.failureStreak++;
continue;
}
let lrc = prefetched ? prefetched.lrc : '';
if (!prefetched) {
try {
const lyric = await onlineSongJson('lyric', String(song.id), attempt.endpoint);
lrc = lyric.data ? String(lyric.data.lrc || '') : '';
} catch (e) {} // 歌词不是起播条件
}
if (!onlineAttemptCurrent(attempt)) return false;
const neteaseId = String(song.id);
let track = library.find(item => item.playlistId === 'spl_default' && String(item.neteaseId || '') === neteaseId);
const created = !track || !!(prefetched && prefetched.created);
temporaryOnlineBackup = prefetched && attempt.reservation.original ? attempt.reservation.original
: track ? { url: track.url, source: track.source, lrc: track.lrc, hasLrc: Object.prototype.hasOwnProperty.call(track, 'lrc') } : null;
if (!track) {
track = {
id: 'sm_online_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
neteaseId, name: String(song.name), artist: String(song.artists || ''),
cover: String(song.picUrl || '').replace(/^http:/i, 'https:'),
url: rawUrl, source: 'url', neteaseAccount: !!(window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn()), duration: Number(song.duration || 0) / 1000,
lrc, playlistId: 'spl_default', addedAt: Date.now()
};
library.push(track);
} else {
track.url = rawUrl;
track.source = 'url';
track.neteaseAccount = !!(window.ciciNeteaseEnhanced && window.ciciNeteaseEnhanced.loggedIn());
if (lrc) track.lrc = lrc;
}
saveLibrary();
renderPage();
if (!attempt.prepared && window.mochiNeteasePrepareTemporaryLocalPlayback) {
window.mochiNeteasePrepareTemporaryLocalPlayback();
attempt.prepared = true;
}
temporaryOnlineId = track.id;
if (attempt.reservation) currentTaReservationId = track.id;
if (attempt.styleStream) attempt.lastTrackId = track.id;
temporaryOnlineCreatedId = created ? track.id : null;
temporaryOnlinePrompt = attempt.failureText;
attempt.trackId = track.id;
attempt.expectedCurrentId = track.id;
attempt.recorded = false;
attempt.playbackSource = String(address && address.data && address.data[0] && address.data[0].source || 'online');
attempt.fallbackTried = attempt.playbackSource !== 'netease';
expectPlayback(track.id, attempt.failureText, () => finishTemporaryOnlineFailure(track.id), 20000);
taActive = true;
if (window.mochiMusicTogetherForce) window.mochiMusicTogetherForce('mochi', track.id);
playTrack(track.id, false, true, track.neteaseAccount ? rawUrl : undefined, attempt.playbackSource);
if (attempt.flow && inviteFlow === attempt.flow) {
attempt.flow.waiting = true;
attempt.flow.localTrackId = track.id;
}
return true;
}
if (onlineAttemptCurrent(attempt)) {
onlineAttempt = null;
if (attempt.styleStream && attempt.prepared && !(attempt.flow && inviteFlow === attempt.flow)) {
currentTaReservationId = null;
finishTaReservation(attempt.lastTrackId);
return false;
}
const resumed = !!(attempt.prepared && window.mochiNeteaseResumeAfterLocal && window.mochiNeteaseResumeAfterLocal());
if (attempt.flow && inviteFlow === attempt.flow) { attempt.flow.waiting = false; attempt.flow.localTrackId = null; runMusicInviteStep(attempt.flow); }
else playbackPrompt(attempt.failureText);
if (attempt.fallbackToNext && !resumed && !(window.mochiNeteaseSharedActive && window.mochiNeteaseSharedActive())) next();
}
return false;
}
async function searchAndPlayOnlineSong(query, wantedText, recordType, reservation, fallbackToNext, flow) {
const serial = ++onlineSearchSerial;
const failureText = 'TA想听' + wantedText + '，需要你帮忙播放哦';
const attempt = {
serial, cid: window.__activeCid || 'default', expectedCurrentId: currentId,
endpoint: reservation ? reservation.endpoint : String(settings.onlineApiUrl || '').trim(),
candidates: [], nextIndex: 0, trackId: null, recordType, recorded: false,
prepared: false, failureText, reservation: reservation || null, fallbackToNext: !!fallbackToNext,
styleStream: !!((reservation && reservation.style) || (flow && flow.kind === 'keyword')),
failureStreak: reservation && reservation.style ? Number(reservation.initialFailures || 0) : 0,
lastTrackId: null,
flow: flow || null
};
onlineAttempt = attempt;
try {
if (reservation) {
attempt.candidates = reservation.candidates;
attempt.nextIndex = reservation.first ? reservation.first.index : 0;
} else {
const styleSearch = !!((reservation && reservation.style) || (flow && flow.kind !== 'named'));
const search = await onlineSongJson(styleSearch ? 'style' : 'search', query, attempt.endpoint);
if (!onlineAttemptCurrent(attempt)) return false;
attempt.candidates = onlineCandidates(search.data && search.data.songs, query, styleSearch);
}
return await tryNextOnlineCandidate(attempt);
} catch (error) {
if (onlineAttemptCurrent(attempt)) {
onlineAttempt = null;
if (attempt.flow && inviteFlow === attempt.flow) { attempt.flow.waiting = false; attempt.flow.localTrackId = null; runMusicInviteStep(attempt.flow); }
else playbackPrompt(failureText);
if (attempt.fallbackToNext && !(window.mochiNeteaseSharedActive && window.mochiNeteaseSharedActive())) next();
}
return false;
}
}
function namedInviteCandidates() {
const ids = [].concat(favIds(), taFavList().map(x => x.id), playQueue);
const seen = new Set();
const local = ids.map(id => findTrack(id)).filter(track => {
if (!track || !track.name || seen.has(track.id)) return false;
seen.add(track.id);
return true;
});
const remote = window.mochiNeteaseQueueCandidates ? window.mochiNeteaseQueueCandidates() : [];
const snapshots = taFavList().filter(item => item && (item.name || item.title) && (!item.id || !findTrack(item.id)))
.map(item => ({ source: 'onlineName', id: String(item.id || ''), name: String(item.name || item.title) }));
return local.concat(remote, snapshots);
}
window.maybeMusicRequest = function () {
try {
if (document.hidden) { console.log('[music-req] return: page hidden'); return; }
const prob = (typeof settings.reqProb === 'number' ? settings.reqProb : 5);
console.log('[music-req] called', { libLen: library.length, cooldownAt: cooldownAt, cooldownMs: settings.cooldownMs, reqProb: settings.reqProb, prob: prob, now: Date.now() });
const now = Date.now();
const cooling = now - cooldownAt < settings.cooldownMs;
if (cooling) return;
if (taPauseActive || (window.mochiNeteaseTaPauseInProgress && window.mochiNeteaseTaPauseInProgress())) return;
const localPlaying = !!(currentId && audio && !audio.paused && !audio.ended && findTrack(currentId));
const remotePlaying = !!(window.mochiNeteaseIsPlaying && window.mochiNeteaseIsPlaying());
const effProb = window.icProb ? window.icProb(prob) : prob;
if (!localPlaying && !remotePlaying && !myInviteListening && !myInvitePending && Math.random() * 100 < effProb) {
console.log('[music-req] TRIGGER');
const namedCandidates = namedInviteCandidates();
const keywords = musicKeywordCards();
const plain = Math.random() * 100 < probOf(settings.plainInviteProb, 70);
let kind = 'plain', track = null, keyword = '';
if (!plain) {
if (keywords.length && Math.random() * 100 < probOf(settings.keywordProb, 50)) {
kind = 'keyword';
keyword = keywords[Math.floor(Math.random() * keywords.length)];
} else if (namedCandidates.length) {
kind = 'named';
track = namedCandidates[Math.floor(Math.random() * namedCandidates.length)];
} else if (keywords.length) {
kind = 'keyword';
keyword = keywords[Math.floor(Math.random() * keywords.length)];
}
}
const opened = openMusicRequestPanel(kind, track, keyword);
if (!opened) { console.log('[music-req] panel open failed'); return; }
cooldownAt = now;
if (track && track.source !== 'netease' && findTrack(track.id)) prewarmLocalAudio(track.id);
return; // 邀请已触发，本次不再判断预订
}
if (!localPlaying && !remotePlaying) return;
const remoteCandidates = remotePlaying && window.mochiNeteaseQueueCandidates ? window.mochiNeteaseQueueCandidates() : [];
const listedNames = new Set(library.map(item => String(item.name || '').trim().toLocaleLowerCase())
.concat(remoteCandidates.map(item => String(item.title || '').trim().toLocaleLowerCase()))
.concat(Array.from(onlineReservations.values(), item => String(item.name || '').trim().toLocaleLowerCase())));
const seenOnlineNames = new Set();
const onlineNames = namedInviteCandidates().filter(item => {
if (item.source !== 'onlineName') return false;
const name = String(item.name || '').trim().toLocaleLowerCase();
if (!name || listedNames.has(name) || seenOnlineNames.has(name)) return false;
seenOnlineNames.add(name);
return true;
});
const reserveCandidates = library.filter(c => c && c.id !== currentId && playQueue.indexOf(c.id) < 0)
.concat(remotePlaying ? remoteCandidates : [], onlineNames);
const rProb = probOf(settings.taReserveProb, 6);
if (Math.random() * 100 < rProb) {
const keywords = musicKeywordCards();
const useKeyword = keywords.length && (!reserveCandidates.length || Math.random() * 100 < probOf(settings.keywordProb, 50));
let candidate;
if (useKeyword) {
const keyword = keywords[Math.floor(Math.random() * keywords.length)];
candidate = { source: 'musicKeyword', keyword, name: keyword + '类型的歌' };
} else if (reserveCandidates.length) candidate = reserveCandidates[Math.floor(Math.random() * reserveCandidates.length)];
else return;
if (candidate.source === 'netease') {
if (!reserveOnlineSong({ source: 'onlineName', name: candidate.title, artist: candidate.artist })) return;
} else if (candidate.source === 'onlineName' || candidate.source === 'musicKeyword') {
if (!reserveOnlineSong(candidate)) return;
} else {
playQueue.push(candidate.id);
taReservedIds.add(candidate.id);
renderQueueBadge();
}
cooldownAt = now;
const name = partnerName();
const trackName = candidate.name || candidate.title || '未知歌曲';
const artist = candidate.artist ? ' - ' + candidate.artist : '';
taMusicSys(candidate.source === 'musicKeyword'
? name + ' 预订了下一首想听的' + trackName
: name + ' 预订了下一首要听的歌：《' + trackName + '》' + artist);
if (candidate.source !== 'musicKeyword') sendNamedSongCard(candidate, 'TA 预订的下一首');
if (candidate.source !== 'netease' && candidate.source !== 'onlineName' && candidate.source !== 'musicKeyword') addRecord(candidate.id, 'TA 预订了下一首');
}
} catch (e) {}
};
function maybeTAAutoAction() {
if (!taActive || !currentId) return false;
const endedId = currentId;
const pNext = probOf(settings.taNextProb, 15);
const pRand = probOf(settings.taRandProb, 10);
const pMode = probOf(settings.taModeProb, 5);
const r = Math.random() * 100;
const name = partnerName();
if (r < pNext) {
const list = playableList();
if (list.length > 1) {
const others = list.filter(x => x.id !== currentId);
const t = others[Math.floor(Math.random() * others.length)];
taMusicSys(name + ' 切到了下一首《' + (t.name || '未知歌曲') + '》');
addRecord(t.id, 'TA 切到了下一首');
window.mochiMusicTogetherForce('mochi', t.id);
setTimeout(() => { if (currentId === endedId) playTrack(t.id); }, 300);
return true;
}
return false;
}
if (r < pNext + pRand) {
const list = playableList();
if (list.length > 1) {
const t = list[Math.floor(Math.random() * list.length)];
taMusicSys(name + ' 随机挑了一首《' + (t.name || '未知歌曲') + '》');
addRecord(t.id, 'TA 随机挑了一首');
window.mochiMusicTogetherForce('mochi', t.id);
setTimeout(() => { if (currentId === endedId) playTrack(t.id); }, 300);
return true;
}
return false;
}
if (r < pNext + pRand + pMode) {
cycleMode();
const modeLabel = { list: '顺序播放', shuffle: '随机播放', single: '单曲循环' }[mode];
taMusicSys(name + ' 把播放模式换成了' + modeLabel);
addModeRecord(modeLabel);
window.mochiMusicTogetherForce('mochi', '', 'mochi:' + currentId);
}
return false;
}
const DEF_TA_PAUSE_CARDS = ['先暂停一下，听我说句话', '嘘——让音乐停一会儿', '（TA 按下了暂停键）'];
const DEF_TA_RESUME_CARDS = ['好啦，继续听吧', '又帮你按了播放，接着听', '（TA 又按下了播放键）'];
let taPauseActive = false;      // TA 暂停进行中（禁止后台补播/手势补播打扰）
let taPauseFiredId = null;      // 本次互动「已真的暂停过」的歌曲 id（#673：用户介入打断时据它记账）
let taPauseTimer = null;        // 掷骰子命中后的延迟触发定时器
let taPauseResumeTimer = null;  // TA 恢复播放定时器
let taPauseDoneId = null;       // 已互动过的歌曲 id（同一首歌不重复触发）
let taPauseCooldownAt = 0;      // 上次互动完成时间戳（冷却期内不连发）
function bookTaPauseFired(id) {
if (!id) return;
taPauseDoneId = id;
taPauseCooldownAt = Date.now();
}
function cancelTaPause() {
if (taPauseActive && taPauseFiredId) bookTaPauseFired(taPauseFiredId);
taPauseActive = false;
taPauseFiredId = null;
if (taPauseTimer) { clearTimeout(taPauseTimer); taPauseTimer = null; }
if (taPauseResumeTimer) { clearTimeout(taPauseResumeTimer); taPauseResumeTimer = null; }
}
function taPauseSendCard(group, fallback) {
try {
if (window.dcfGet && !(Math.random() * 100 < window.dcfGet('music'))) return;
let arr = window.getLibPool ? window.getLibPool('music', group, fallback) : (fallback || []);
if (window.isDefaultCardOff) arr = arr.filter(c => !window.isDefaultCardOff('music', c));
if (!arr.length) arr = window.gateCardFallback ? window.gateCardFallback('music', fallback) : [];
if (!arr.length) return;
let m = arr[Math.floor(Math.random() * arr.length)];
if (window.taFit) m = window.taFit(m);
taMusicSay(m);
} catch (e) {}
}
window.mochiMusicTaPauseCanSchedule = function (id) {
return !!(id && settings.taPauseEn && !taPauseActive && id !== taPauseDoneId &&
Date.now() - taPauseCooldownAt >= (settings.cooldownMs ?? 600000));
};
window.mochiMusicTaPauseRemoteStarted = function (id) {
if (!id) return;
bookTaPauseFired(id);
try { taMusicSys(partnerName() + ' 暂停了音乐'); } catch (e) {}
taPauseSendCard('TA 暂停播放', DEF_TA_PAUSE_CARDS);
if (window.mochiNeteaseTogetherForceCurrent) window.mochiNeteaseTogetherForceCurrent();
};
window.mochiMusicTaPauseRemoteResumed = function () {
try { taMusicSys(partnerName() + ' 又播放了音乐'); } catch (e) {}
taPauseSendCard('TA 恢复播放', DEF_TA_RESUME_CARDS);
};
function scheduleTaPauseIfLucky() {
cancelTaPause();
if (!settings.taPauseEn) return;                                  // 权限开关关闭：彻底不触发
if (currentId && currentId === taPauseDoneId) return;             // 同一首歌只互动一次
if (Date.now() - taPauseCooldownAt < (settings.cooldownMs ?? 600000)) return; // 冷却期内不连发（#673：`??` 让「无冷却」=0 真正生效；`||` 会把设置成 0 的「无冷却」当成 600000，与 3913/3978 两处冷却判定不一致＝选「无冷却」却仍冷却 10 分钟＝「一播就被打断」难复现、交互频率异常）
const p = probOf(settings.taPauseProb, 3);
if (p <= 0 || Math.random() * 100 >= p) return;
if (!currentId || !audio) return;
const endedId = currentId;
taPauseTimer = setTimeout(function () {
taPauseTimer = null;
if (taPauseActive || !audio || !currentId || currentId !== endedId || audio.paused) return;
if (callHoldPending || document.hidden) return; // 通话/后台不打扰
taPauseActive = true;
taPauseFiredId = endedId; // #673：记下「这次真的暂停过了」，用户介入打断时据此记账
wantPlay = true; // 保留播放意图（TA 稍后会恢复，不按「用户主动暂停」处理）
try { audio.pause(); } catch (e) {}
try { const nm = partnerName(); taMusicSys(nm + ' 暂停了音乐'); } catch (e) {}
taPauseSendCard('TA 暂停播放', DEF_TA_PAUSE_CARDS);
window.mochiMusicTogetherForce('mochi', endedId);
taPauseResumeTimer = setTimeout(function () {
taPauseResumeTimer = null;
if (!taPauseActive || !audio || !currentId || currentId !== endedId) { taPauseActive = false; taPauseFiredId = null; return; }
taPauseActive = false;
taPauseFiredId = null;
bookTaPauseFired(endedId);
const p2 = audio.play();
if (p2 && p2.catch) p2.catch(function () {
if (!audio) return; // v3.28.x：判空防 null.play()（3.5s 恢复窗口内可能已切歌/停止）
try { audio.muted = true; } catch (e) {}
const p3 = audio.play();
if (p3 && p3.then) p3.then(function () { try { if (audio) audio.muted = false; } catch (e) {} }).catch(function () {
try { syncPlayIcons(false); } catch (e) {}
try { armAutoResume(); } catch (e) {}
});
});
try { const nm = partnerName(); taMusicSys(nm + ' 又播放了音乐'); } catch (e) {}
taPauseSendCard('TA 恢复播放', DEF_TA_RESUME_CARDS);
}, 3500);
}, 10000 + Math.floor(Math.random() * 15000));
}
function MUSIC_FILE_PREFIX() { return MUSIC_PREFIX + ':music-file:'; }
function calcStorageBytes() {
if (!window.idbGetAllKeys) return Promise.resolve(-1);
return window.idbGetAllKeys().then(keys => {
const fileKeys = keys.filter(k => k.indexOf(MUSIC_FILE_PREFIX()) === 0);
if (!fileKeys.length) return 0;
const BATCH = 20;
function readBatch(i) {
if (i >= fileKeys.length) return Promise.resolve(0);
return window.idbGetMany(fileKeys.slice(i, i + BATCH)).then(map => {
let total = 0;
fileKeys.slice(i, i + BATCH).forEach(k => {
const v = map[k];
if (v instanceof Blob) total += v.size;
else if (typeof v === 'string') total += v.length * 0.75;
});
return readBatch(i + BATCH).then(sub => total + sub);
});
}
return readBatch(0);
}).catch(() => -1);
}
function fmtStorageMB(bytes) {
if (bytes < 0) return '计算失败';
if (!bytes) return '0 MB';
const mb = bytes / 1048576;
return (mb < 0.01 ? '0.01' : mb.toFixed(1)) + ' MB';
}
function refreshStorageUse() {
const el = document.getElementById('sm-storage-use');
if (!el) return;
el.textContent = '计算中…';
calcStorageBytes().then(b => { const e = document.getElementById('sm-storage-use'); if (e) e.textContent = fmtStorageMB(b); });
}
function clearLocalAudioCache() {
if (!window.idbGetAllKeys || !window.idbDelete) { toast('当前环境不支持清理'); return; }
window.idbGetAllKeys().then(keys => {
const fileKeys = keys.filter(k => k.indexOf(MUSIC_FILE_PREFIX()) === 0);
if (!fileKeys.length) { toast('没有本地音频缓存'); refreshStorageUse(); return; }
const delIds = [];       // 要移除的歌曲 id（非种子，音频删了歌也播不了）
const cacheOnly = [];    // 种子歌的本地旋律缓存键（可再生成，只删缓存不动歌）
fileKeys.forEach(k => {
const id = k.slice(MUSIC_FILE_PREFIX().length);
const m = library.find(x => x.id === id);
if (m && seedIdxOf(m) >= 0) cacheOnly.push(k);
else delIds.push(id);
});
window.openModal('将删除 ' + fileKeys.length + ' 个本地音频文件，并从歌单移除 ' + delIds.length + ' 首本地歌曲（外链歌曲不受影响）。确定清理？', '', () => {
let p = Promise.resolve(true);
fileKeys.forEach(k => { p = p.then(() => window.idbDelete(k)); });
p.then(() => {
if (delIds.length) {
library = library.filter(m => !delIds.includes(m.id));
if (currentId && delIds.includes(currentId)) { teardownAudio(); currentId = null; }
saveLibrary();
}
if (audio) updatePlayerBar();
renderFloat();
refreshStorageUse();
toast('已清理本地音频缓存');
});
}, { noInput: true });
});
}
function openSettings() {
if (!window.openTCPanel) return;
const cooldownOpts = [
{ v: '0', label: '无冷却' },
{ v: '300000', label: '5 分钟' },
{ v: '600000', label: '10 分钟' }
].map(o => '<option value="' + o.v + '"' + (String(settings.cooldownMs) === o.v ? ' selected' : '') + '>' + o.label + '</option>').join('');
window.openTCPanel('音乐设置', '' +
'<div class="sm-set-row"><span>悬浮播放小框</span><label class="toggle"><input type="checkbox" id="sm-set-float"' + (settings.floatEn ? ' checked' : '') + '><span class="tk"></span></label></div>' +
'<div class="gs-row"><span>音乐请求触发概率</span><div class="stepper" id="sm-set-prob" data-min="1" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-prob-val" type="number" min="1" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="gs-row"><span>普通听歌邀请占比</span><div class="stepper" id="sm-set-plain" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-plain-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">默认 70% 只邀请“一起听歌”，其余 30% 邀请具体歌名或关键词风格；两部分总和始终为 100%。没有可选歌名或关键词时会使用普通邀请。</div>' +
'<div class="gs-row"><span>指定内容中关键词占比</span><div class="stepper" id="sm-set-keyword" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-keyword-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">指定内容邀请和“预订下一首”共用此比例：两类都有候选时，默认 50% 选关键词风格，另 50% 选具体歌名；只有一类可用时直接选它。关键词写在【字卡库 → 可自定义字卡 → 其他互动功能字卡 → 音乐关键词】。风格词先找相关歌单，再随机抽取候选；具体歌名仍按歌曲搜索。安卓 App 登录网易云后，CiCi 会优先尝试用账号可用的音源播放。</div>' +
'<div class="gs-row"><span>无音乐等待时间（分钟）</span><input class="tc-input" id="sm-set-invite-wait" type="number" min="0" max="60" step="1" inputmode="numeric" style="width:74px;text-align:center" value="' + Math.round(Math.max(0, Math.min(3600000, Number(settings.inviteWaitMs) || 0)) / 60000) + '"></div>' +
'<div class="sm-set-hint">普通听歌邀请点同意后会立即尝试网易云、默认歌单和关键词搜索；到这里仍无音乐时，等待本时长后提示手动播放。默认 5 分钟，和下方请求冷却时间分别计算。</div>' +
'<div class="gs-row"><span>在线点歌接口链接</span><button class="cc-tool" id="sm-set-api-reset" type="button">恢复内置</button></div>' +
'<input class="tc-input" id="sm-set-api-url" type="url" inputmode="url" maxlength="2048" placeholder="留空使用 App 内置接口" style="width:100%;box-sizing:border-box" value="' + esc(settings.onlineApiUrl || '') + '">' +
'<div class="sm-set-hint">填写可通过 HTTPS 访问、兼容 music_jx 的 JSON 接口地址，须支持 type=search&amp;keywords=、type=url&amp;id=、type=lyric&amp;id=。App 的风格歌单搜索使用内置网易云接口，歌曲地址和歌词仍可走自填接口。普通网站页面或 GitHub 仓库链接不能直接使用；网页版的风格搜索需接口额外支持 type=style&amp;keywords= 并允许跨域请求。</div>' +
(window.ciciNeteaseEnhancedSettings ? '<div class="gs-row"><span>网易云账号</span><button class="cc-tool" id="sm-set-official" type="button">扫码登录</button></div><div class="sm-set-hint">登录后可在音乐页用 CiCi 播放每日推荐与心动模式。会员音源以网易云实际返回为准；心动模式优先用当前歌曲作起点，否则从“我喜欢的音乐”取一首。</div>' : '') +
'<div class="gs-row"><span>第二页陪听提示概率</span><div class="stepper" id="sm-set-together" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-together-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="gs-row"><span>TA 离开陪听概率</span><div class="stepper" id="sm-set-together-leave" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-together-leave-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">播放开始时按陪听提示概率判断；没出现则每 60 秒尝试加入。TA 加入后每隔随机 15～30 分钟按离开概率判断，默认 20%；未离开就等待下一轮。离开后每隔随机 15～30 分钟按陪听提示概率尝试回来。暂停或停止时隐藏提示，但 TA 的在场状态和计时继续；再次播放时如 TA 正在陪听会立即显示。接受邀请或 TA 成功控制播放时必定加入。点“知道啦”后才显示音乐评论。</div>' +
'<div class="gs-row"><span>请求冷却时间</span><select class="tc-input" id="sm-set-cool" style="width:110px">' + cooldownOpts + '</select></div>' +
'<div class="gs-row"><span>桌面小组件封面</span><select class="tc-input" id="sm-set-wcov" style="width:120px"><option value="song"' + (settings.widgetCoverMode !== 'playlist' ? ' selected' : '') + '>歌曲封面</option><option value="playlist"' + (settings.widgetCoverMode === 'playlist' ? ' selected' : '') + '>歌单封面</option></select></div>' +
'<div class="sm-set-hint">聊天过程中 TA 会按概率请求和你一起听歌；邀请文案有时会写成「现在就想要一起听《歌名》」，歌曲从可播放的收藏或播放队列中挑选；播放时右上角出现可拖动的悬浮小框。想现在就要（或换你主动邀 TA）：在音乐页那首歌按「⋯」，快捷操作里有「邀请 TA 一起听」和「让 TA 邀我听这首」——后者不走概率、不等冷却</div>' +
'<div class="gs-row"><span>预订下一首概率</span><div class="stepper" id="sm-set-reserve" data-min="0" data-max="100" data-step="5"><button class="stp-min">−</button><input class="stp-val" id="sm-set-reserve-val" readonly><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">聊天过程中 TA 有概率「预订」下一首。已在网易云当前媒体队列里的歌曲会尝试按队列控制；新搜索的歌曲会优先插入 CiCi 待播队列；起播后也加入当前播放列表，播完继续原列表。设 0 = TA 从不预订下一首。</div>' +
'<div class="gs-row"><span>CiCi 歌曲播完·TA 切下一首概率</span><div class="stepper" id="sm-set-next" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-next-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="gs-row"><span>歌曲播完·随机挑歌概率</span><div class="stepper" id="sm-set-rand" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-rand-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="gs-row"><span>歌曲播完·换播放模式概率</span><div class="stepper" id="sm-set-modep" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-modep-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">CiCi 音乐库一起听完一首歌时，TA 按“切下一首 / 随机挑歌 / 换播放模式”三个概率接动作；都不中就按当前播放模式继续。开启下方网易云互动后，同样共用这三个概率。</div>' +
'<div class="sm-set-row"><span>联系人可暂停你的播放</span><label class="toggle"><input type="checkbox" id="sm-set-pause-en"' + (settings.taPauseEn ? ' checked' : '') + '><span class="tk"></span></label></div>' +
'<div class="gs-row"><span>播放中·TA 暂停再播放概率</span><div class="stepper" id="sm-set-pauseprob" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-pauseprob-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">CiCi 或网易云播放歌曲时共用此开关和概率：TA 有概率在播放 10～25 秒后暂停，约 3.5 秒后恢复；确认操作成功才发送聊天字卡。字卡文案在【字卡库 → 其他互动功能字卡 → 音乐】可逐张开关。关闭开关或概率设 0 即关闭；同一首歌只触发一次，触发后按上方冷却时间避免连续打断。网易云遥控需 CiCi 保持打开且网易云向系统提供播放控制。</div>' +
'<div class="gs-row"><span>TA 收藏歌曲概率</span><div class="stepper" id="sm-set-favprob" data-min="0" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-favprob-val" type="number" min="0" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">CiCi 歌库和网易云正在播的歌曲共用这一概率（默认 20%）：听 10～25 秒后判定，命中就收进「TA的收藏」；已收藏过的不重复判定，两次成功收藏至少间隔 90 秒。0% 关闭；可直接输入 1～100 的任意整数。</div>' +
'<div class="gs-row"><span>TA 收藏歌词概率</span><div class="stepper" id="sm-set-lyric-favprob" data-min="1" data-max="100" data-step="1"><button class="stp-min">−</button><input class="stp-val" id="sm-set-lyric-favprob-val" type="number" min="1" max="100" step="1" inputmode="numeric"><button class="stp-max">+</button></div></div>' +
'<div class="sm-set-hint">默认 20%，与收藏歌曲一样在听满 10～25 秒后判断，每首只判断一次；两次成功收藏至少间隔 90 秒。仅在“TA在和你一起听歌”显示且当前有同步歌词时收藏当时的一句。</div>' +
'<div class="sm-set-row"><span>网易云自动音乐互动</span><label class="toggle"><input type="checkbox" id="sm-set-netease-auto"' + (settings.neteaseAutoEn ? ' checked' : '') + '><span class="tk"></span></label></div>' +
'<div class="sm-set-hint">只在 CiCi 打开、网易云正在播放时，确认一首歌自然播完后按上方共用的三个概率依次判断；都不中就让网易云按原播放方式继续。成功切歌后至少间隔 90 秒。随机挑歌需要网易云向系统提供歌曲队列及指定跳转控制；系统媒体会话无法通用地切换网易云播放模式，抽中“换播放模式”时不会修改网易云。TA 暂停与收藏分别使用上方各自的开关和概率，不依赖此开关。</div>' +
'<div class="sm-set-row"><span>本地音频缓存</span><span id="sm-storage-use" style="color:var(--muted);font-size:12px">计算中…</span></div>' +
'<div class="mail-actions"><button class="cc-tool" id="sm-diag-req">诊断邀请</button><button class="cc-tool" id="sm-clear-cache">清理本地音频缓存</button><button class="cc-tool" id="sm-set-close">关闭</button></div>');
document.getElementById('sm-set-close').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
const officialBtn = document.getElementById('sm-set-official');
if (officialBtn) officialBtn.addEventListener('click', () => window.ciciNeteaseEnhancedSettings());
const diagBtn = document.getElementById('sm-diag-req');
if (diagBtn) diagBtn.addEventListener('click', function () {
const remain = Math.max(0, settings.cooldownMs - (Date.now() - cooldownAt));
const lines = [
'歌库: ' + library.length + ' 首',
'maybeMusicRequest: ' + (typeof window.maybeMusicRequest),
'reqProb: ' + settings.reqProb + ' → 实际 ' + (typeof settings.reqProb === 'number' ? settings.reqProb : 5) + '%',
'cooldownMs: ' + settings.cooldownMs,
'冷却剩余: ' + Math.ceil(remain / 1000) + ' s',
'openTCPanel: ' + (typeof window.openTCPanel),
'chatAddSystem: ' + (typeof window.chatAddSystem)
];
window.openTCPanel('音乐邀请诊断', '<div class="sm-set-hint">' + lines.join('<br>') + '</div><div class="mail-actions"><button class="cc-tool" id="sm-diag-force">强制触发一次</button><button class="cc-tool" id="sm-diag-close">关闭</button></div>');
document.getElementById('sm-diag-close').addEventListener('click', () => { document.getElementById('tc-mask').hidden = true; });
document.getElementById('sm-diag-force').addEventListener('click', () => {
document.getElementById('tc-mask').hidden = true;
if (!library.length) { toast('library 为空，无法触发'); return; }
const track = library[Math.floor(Math.random() * library.length)];
if (!openMusicInvitePanel(track.id, false)) { toast('邀请面板没能打开，请重进音乐页再试'); return; }
prewarmLocalAudio(track.id);
});
});
const clearBtn = document.getElementById('sm-clear-cache');
if (clearBtn) clearBtn.addEventListener('click', clearLocalAudioCache);
refreshStorageUse();
const bindProbStep = (id, key, def, max, step = 5, min = 0) => {
const valEl = document.getElementById(id + '-val');
const box = document.getElementById(id);
if (!valEl || !box) return;
valEl.value = Math.max(min, Math.min(max, probOf(settings[key], def)));
const commit = value => {
const n = Number(value);
const nv = Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : probOf(settings[key], def)));
valEl.value = nv;
settings[key] = nv;
saveSettings();
};
box.querySelector('.stp-min').addEventListener('click', () => {
commit((parseInt(valEl.value, 10) || 0) - step);
});
box.querySelector('.stp-max').addEventListener('click', () => {
commit((parseInt(valEl.value, 10) || 0) + step);
});
if (!valEl.readOnly) valEl.addEventListener('change', () => commit(valEl.value));
};
bindProbStep('sm-set-prob', 'reqProb', 5, 100, 1, 1);
bindProbStep('sm-set-plain', 'plainInviteProb', 70, 100, 1);
bindProbStep('sm-set-keyword', 'keywordProb', 50, 100, 1);
const inviteWait = document.getElementById('sm-set-invite-wait');
if (inviteWait) inviteWait.addEventListener('change', () => {
const minutes = Math.max(0, Math.min(60, Number.isFinite(Number(inviteWait.value)) ? Math.round(Number(inviteWait.value)) : 5));
inviteWait.value = String(minutes);
settings.inviteWaitMs = minutes * 60000;
saveSettings();
});
const apiUrl = document.getElementById('sm-set-api-url');
if (apiUrl) apiUrl.addEventListener('change', () => {
const next = apiUrl.value.trim();
if (next && !validOnlineEndpoint(next)) {
playbackPrompt('请填写可用的 HTTPS 接口地址');
apiUrl.value = settings.onlineApiUrl || '';
return;
}
settings.onlineApiUrl = next;
apiUrl.value = next;
saveSettings();
});
const apiReset = document.getElementById('sm-set-api-reset');
if (apiReset) apiReset.addEventListener('click', () => {
settings.onlineApiUrl = '';
if (apiUrl) apiUrl.value = '';
saveSettings();
});
bindProbStep('sm-set-together', 'togetherProb', 50, 100, 1);
bindProbStep('sm-set-together-leave', 'togetherLeaveProb', 20, 100, 1);
bindProbStep('sm-set-reserve', 'taReserveProb', 6, 100);
bindProbStep('sm-set-next', 'taNextProb', 15, 100, 1);
bindProbStep('sm-set-rand', 'taRandProb', 10, 100, 1);
bindProbStep('sm-set-modep', 'taModeProb', 5, 100, 1);
bindProbStep('sm-set-pauseprob', 'taPauseProb', 3, 100, 1);
bindProbStep('sm-set-favprob', 'taFavProb', 20, 100, 1);
bindProbStep('sm-set-lyric-favprob', 'taLyricFavProb', 20, 100, 1, 1);
const neteaseAuto = document.getElementById('sm-set-netease-auto');
if (neteaseAuto) neteaseAuto.addEventListener('change', () => { settings.neteaseAutoEn = neteaseAuto.checked; saveSettings(); });
const syncPauseEn = function () {
const box = document.getElementById('sm-set-pauseprob');
if (box) box.style.opacity = settings.taPauseEn ? '' : '0.4';
const valEl = document.getElementById('sm-set-pauseprob-val');
if (valEl) valEl.style.pointerEvents = settings.taPauseEn ? '' : 'none';
};
const pauseEnCb = document.getElementById('sm-set-pause-en');
if (pauseEnCb) {
pauseEnCb.addEventListener('change', () => {
settings.taPauseEn = pauseEnCb.checked;
saveSettings();
syncPauseEn();
});
}
syncPauseEn();
const cool = document.getElementById('sm-set-cool');
if (cool) cool.addEventListener('change', () => { settings.cooldownMs = Number(cool.value); saveSettings(); });
const floatCb = document.getElementById('sm-set-float');
if (floatCb) floatCb.addEventListener('change', () => { settings.floatEn = floatCb.checked; floatHideByWidget = false; saveSettings(); syncFloatToggle(); renderFloat(); });
const wcov = document.getElementById('sm-set-wcov');
if (wcov) wcov.addEventListener('change', () => {
settings.widgetCoverMode = wcov.value;
saveSettings();
const m = findTrack(currentId);
if (m) setWidgetCover(m);
});
}
function bindWidget() {
const playBtn = document.getElementById('mw-play');
const prevBtn = document.getElementById('mw-prev');
const nextBtn = document.getElementById('mw-next');
const heartBtn = document.getElementById('mw-heart');
const modeBtn = document.getElementById('mw-mode');
const queueBtn = document.getElementById('mw-queue');
const bar = document.getElementById('mw-bar');
const fill = document.getElementById('mw-fill');
const knob = document.getElementById('mw-knob');
const curEl = document.getElementById('mw-cur');
const durEl = document.getElementById('mw-dur');
if (playBtn) playBtn.addEventListener('click', () => toggle(true));
if (modeBtn) modeBtn.addEventListener('click', cycleMode);
if (queueBtn) queueBtn.addEventListener('click', openQueuePanel);
if (prevBtn) prevBtn.addEventListener('click', () => prev(true));
if (nextBtn) nextBtn.addEventListener('click', () => next(true));
if (heartBtn) {
heartBtn.addEventListener('click', () => {
const m = findTrack(currentId);
if (!m) { toast('请先播放一首歌'); return; }
const liked = toggleFav(m.id);
toast(liked ? '已收藏' : '已取消收藏');
});
syncHeartIcons();
}
const fHeart = document.getElementById('sm-f-heart');
if (fHeart) {
fHeart.addEventListener('click', () => {
const m = findTrack(currentId);
if (!m) { toast('请先播放一首歌'); return; }
const liked = toggleFav(m.id);
toast(liked ? '已收藏' : '已取消收藏');
});
}
const pbHeart = document.getElementById('sm-pb-heart');
if (pbHeart) {
pbHeart.addEventListener('click', () => {
const m = findTrack(currentId);
if (!m) { toast('请先播放一首歌'); return; }
const liked = toggleFav(m.id);
toast(liked ? '已收藏' : '已取消收藏');
});
syncHeartIcons();
}
if (bar) {
bar.addEventListener('click', (e) => {
if (!audio || !audio.duration) return;
const r = bar.getBoundingClientRect();
audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});
}
if (fill && curEl && durEl && knob) {
const iv = setInterval(() => {
if (!audio || !audio.duration) return;
if (musicBuffering()) return; // #795：缓冲期保留「缓冲中」文案，别拿冻住的时间盖回去
const pct = audio.currentTime / audio.duration * 100;
fill.style.width = pct + '%';
knob.style.left = pct + '%';
curEl.textContent = fmtDur(audio.currentTime);
durEl.textContent = fmtDur(audio.duration);
}, 500);
window._mwProgressTimer = iv;
}
const wSong = document.getElementById('mw-song');
if (wSong && !currentId) wSong.textContent = '未在播放';
const wArtist = document.getElementById('mw-artist');
if (wArtist && !currentId) wArtist.textContent = '音乐';
}
const musicApp = document.querySelector('.app[data-app="music"]');
const musicPage = document.getElementById('page-music');
if (musicApp && musicPage) {
musicApp.addEventListener('click', () => {
const editing = Array.from(document.querySelectorAll('.app-grid')).some(g => g.classList.contains('editing'));
if (editing) return;
document.querySelectorAll('.page').forEach(p => p.hidden = true);
musicPage.hidden = false;
renderPage();
probeAllMissingDurations();
ensureMissingCovers();
});
}
const musicBack = document.getElementById('music-back');
if (musicBack) {
musicBack.addEventListener('click', () => {
document.querySelectorAll('.page').forEach(p => p.hidden = true);
const home = document.getElementById('page-phone');
if (home) home.hidden = false;
});
}
document.querySelectorAll('#page-music .fav-tab').forEach(tab => {
tab.addEventListener('click', () => {
curTab = tab.dataset.mtab;
document.querySelectorAll('#page-music .fav-tab').forEach(x => x.classList.toggle('sel', x === tab));
document.querySelectorAll('#page-music .cal-card').forEach(c => { c.hidden = c.dataset.mpanel !== curTab; });
if (curTab === 'pl') renderPlaylists();
if (curTab === 'fav') renderFavList();
if (curTab === 'favta') renderTaFavList();
if (curTab === 'his') renderHistory();
});
});
const upBtn = document.getElementById('music-upload');
if (upBtn) upBtn.addEventListener('click', triggerUpload);
const urlBtn = document.getElementById('music-add-url');
if (urlBtn) urlBtn.addEventListener('click', openAddUrl);
const batchBtn = document.getElementById('music-batch');
if (batchBtn) batchBtn.addEventListener('click', openBatch);
const batchMgmt = document.getElementById('music-batch-manage');
if (batchMgmt) batchMgmt.addEventListener('click', () => { if (musicBatch) exitBatch(); else enterBatch(); });
const vipClean = document.getElementById('music-vip-clean');
if (vipClean) vipClean.addEventListener('click', openVipClean);
const dailyRecommend = document.getElementById('music-daily-recommend');
if (dailyRecommend) dailyRecommend.addEventListener('click', () => { void startRecommendation('daily'); });
const heartRecommend = document.getElementById('music-heart-recommend');
if (heartRecommend) heartRecommend.addEventListener('click', () => { void startRecommendation('heart'); });
const setBtn = document.getElementById('music-set');
if (setBtn) setBtn.addEventListener('click', openSettings);
const playBtn = document.getElementById('sm-play');
if (playBtn) playBtn.addEventListener('click', () => toggle());
const modeBtn = document.getElementById('sm-mode');
if (modeBtn) modeBtn.addEventListener('click', cycleMode);
const fModeBtn = document.getElementById('sm-f-mode');
if (fModeBtn) fModeBtn.addEventListener('click', cycleMode);
const prevBtn = document.getElementById('sm-prev');
if (prevBtn) prevBtn.addEventListener('click', () => prev());
const nextBtn = document.getElementById('sm-next');
if (nextBtn) nextBtn.addEventListener('click', () => next());
const queueBtn = document.getElementById('sm-queue');
if (queueBtn) queueBtn.addEventListener('click', openQueuePanel);
const fPlay = document.getElementById('sm-f-play');
if (fPlay) fPlay.addEventListener('click', () => toggle());
const fPrev = document.getElementById('sm-f-prev');
if (fPrev) fPrev.addEventListener('click', () => prev());
const fNext = document.getElementById('sm-f-next');
if (fNext) fNext.addEventListener('click', () => next());
const fQueue = document.getElementById('sm-f-queue');
if (fQueue) fQueue.addEventListener('click', openQueuePanel);
const fCollapse = document.getElementById('sm-f-collapse');
if (fCollapse) fCollapse.addEventListener('click', toggleFloatMin);
const fMiniExpand = document.getElementById('sm-f-mini-expand');
if (fMiniExpand) fMiniExpand.addEventListener('click', toggleFloatMin);
const fMiniPlay = document.getElementById('sm-f-mini-play');
if (fMiniPlay) fMiniPlay.addEventListener('click', () => toggle());
const fToggle = document.getElementById('music-float-en');
if (fToggle) {
fToggle.addEventListener('change', () => {
settings.floatEn = fToggle.checked;
floatClosed = false;
floatHideByWidget = false; // 用户显式操作悬浮小窗开关 → 清除小组件抑制
saveSettings();
renderFloat();
});
}
function bootMusic() {
loadAll();
{
const known = { 2613048732: { name: 'Moonlit Dream', artist: 'DLSS · shell（月光梦）', cover: 'https://p2.music.126.net/cXuoNwFzgFoQF7bGvC2mIQ==/109951169832660411.jpg' }, 27538343: { name: 'Baby', artist: 'EXO-K', cover: '' } };
let changed = false;
const before = library.length;
library = library.filter(m => !(m.playlistId === 'spl_default' && (m.neteaseId === '28815250' || m.neteaseId === '2064961530')));
if (library.length !== before) changed = true;
library.forEach(m => {
if (m.playlistId === 'spl_default' && m.neteaseId) {
const k = known[m.neteaseId];
if (k && (!m.name || m.name.indexOf('网易云音乐-') === 0)) {
m.name = k.name; m.artist = k.artist; changed = true;
}
if (k && k.cover && !m.cover) { m.cover = k.cover; changed = true; }
}
});
if (changed) saveLibrary();
library.forEach(m => {
if (m.playlistId === 'spl_default' && m.neteaseId && m.name && m.name.indexOf('网易云音乐-') === 0) {
fetchNeteaseInfo(String(m.neteaseId), (info) => {
const mm = findTrack(m.id);
if (mm && info && info.name) {
mm.name = info.name;
if (info.artist) mm.artist = info.artist;
if (info.duration && !mm.duration) mm.duration = info.duration;
saveLibrary();
renderPage();
}
});
}
});
}
renderPage();
probeAllMissingDurations();
}
setupFloatDrag();
bindWidget();
if (window.__mochiDataReady) {
bootMusic();
} else {
document.addEventListener('mochi-restore-done', function h() {
document.removeEventListener('mochi-restore-done', h);
bootMusic();
});
}
document.addEventListener('contact-switched', function () {
try {
taActive = false;
togetherPending = null;
endTogetherSession();
cooldownAt = 0;
reqData = null;
myInvitePending = false; // 我方那条「在飞」闸同属互动状态：旧桌面的在飞不许把新桌口的邀请挡掉
libFilter = 'all';
libRenderShown = LIB_RENDER_LIMIT; // 切联系人时重置窗口化渲染计数
clearTaFavTimer();
try { renderFloat(); } catch (e) {}
try { syncTaFavTab(); renderTaFavList(); } catch (e) {}
} catch (e) {}
});
})();
if (window.__mochiLoaded) window.__mochiLoaded.push("music-player.js");
} catch (__e) { if (window.__mochiErrLoaded) window.__mochiErrLoaded.push("music-player.js"); try { console.error("[JS] music-player.js", __e && __e.message || __e); } catch (x) {} if (window.__jsErrors) window.__jsErrors.push("[music-player.js] " + String(__e && __e.message || __e)); } })();