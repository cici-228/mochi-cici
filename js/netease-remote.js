(function () { try {
(function () {
if (window.MochiFileSave) {
const pendingSaves = new Map();
window.mochiNativeSaveResolve = (token, ok) => {
const resolve = pendingSaves.get(token);
if (resolve) { pendingSaves.delete(token); resolve(!!ok); }
};
window.mochiNativeSaveFile = async (blob, name) => {
const native = window.MochiFileSave;
const token = native.begin(String(name || 'mochi-backup.json'), String(blob.type || 'application/octet-stream'));
if (!token) throw new Error('无法开始保存');
const readChunk = part => new Promise((resolve, reject) => {
const reader = new FileReader();
reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
reader.readAsDataURL(part);
});
try {
for (let pos = 0; pos < blob.size; pos += 128 * 1024) {
if (!native.append(token, await readChunk(blob.slice(pos, pos + 128 * 1024)))) throw new Error('暂存备份失败');
}
return await new Promise((resolve, reject) => {
pendingSaves.set(token, resolve);
if (!native.finish(token)) { pendingSaves.delete(token); reject(new Error('无法打开保存框')); }
});
} catch (e) {
pendingSaves.delete(token);
try { native.abort(token); } catch (ignored) {}
throw e;
}
};
}
const bridge = window.MochiNetease;
const panel = document.getElementById('netease-remote');
if (!bridge || !panel) return;
panel.hidden = false;
const el = id => document.getElementById('netease-remote-' + id);
const access = el('access');
const seek = el('seek');
const controls = ['prev', 'play', 'next'];
let state = null;
let dragging = false;
let sourceChoice = 'auto'; // 自动跟随网易云；用户点 CiCi 曲目后切回本地。
let lastCover = '';
let remoteQueue = [];
let remoteQueueCount = 0;
let remoteQueueTitle = '';
let queueRevision = 0;
let remoteReservations = [];
let returnToRemoteAfterLocal = false;
let adoptedQueueForTakeover = false;
let pendingReservationResume = null;
let autoReservationTarget = '';
let autoReservationAt = 0;
let manualQueueJumpId = '';
let manualQueueJumpAt = 0;
let localTakeoverAt = 0;
let localTakeoverMediaId = '';
let localTakeoverQueueId = '';
let localTakeoverTitle = '';
let localPauseObserved = false;
let localPauseRetries = 0;
let localPauseRetryAt = 0;
let pendingQueueJump = null;
const fmt = ms => {
const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
};
const call = (method, arg) => {
try { if (typeof bridge[method] !== 'function') return false; bridge[method](arg); return true; }
catch (e) { el('status').textContent = '控制失败，请刷新'; return false; }
};
const playbackPrompt = message => {
if (window.mochiMusicPlaybackPrompt) window.mochiMusicPlaybackPrompt(message);
else if (typeof window.toast === 'function') window.toast(message);
else {
let node = document.getElementById('cc-toast');
if (!node) { node = document.createElement('div'); node.id = 'cc-toast'; document.body.appendChild(node); }
node.textContent = message;
node.className = 'cc-toast'; void node.offsetWidth; node.className = 'cc-toast show';
node.style.opacity = '';
clearTimeout(node._timer);
node._timer = setTimeout(() => { node.className = 'cc-toast'; }, 2000);
}
};
const byId = id => document.getElementById(id);
const put = (id, value) => { const node = byId(id); if (node) node.textContent = value; };
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const playingPath = '<path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z"/>';
const pausedPath = '<path d="M8 5.5v13l11-6.5z"/>';
const activeShared = () => sourceChoice === 'remote' && !!(state && state.access && state.active);
window.mochiNeteaseSessionAvailable = () => !!(state && state.access && state.active);
window.mochiNeteasePlaybackSnapshot = () => ({
available: !!(state && state.access && state.active),
playing: !!(state && state.playing),
title: String(state && state.title || ''),
queueId: currentQueueId()
});
window.mochiNeteaseLyricSnapshot = () => activeShared() && state && state.playing && state.title ? {
key: trackKey(state), title: String(state.title), artist: String(state.artist || ''),
mediaId: String(state.mediaId || ''), position: Math.max(0, Number(state.position || 0))
} : null;
const queueIdOf = item => String(item && item.id != null ? item.id : '');
const currentQueueId = () => String(state && state.activeQueueId || '');
const togetherTrackKey = () => currentQueueId() + ':' + currentTrackKey;
window.mochiNeteaseTogetherForceCurrent = () => {
if (activeShared() && window.mochiMusicTogetherForce)
window.mochiMusicTogetherForce('netease', togetherTrackKey());
};
const canSelectQueueItem = () => !!(state && state.canSkipToQueueItem && typeof bridge.skipToQueueItem === 'function');
const localQueuedTracks = () => window.mochiMusicQueuedTracks ? window.mochiMusicQueuedTracks() : [];
function remoteQueueCandidates() {
if (!activeShared() || !state.playing || !canSelectQueueItem()) return [];
const currentId = currentQueueId();
const currentMediaId = String(state.mediaId || '');
let currentIndex = remoteQueue.findIndex(item => queueIdOf(item) === currentId);
if (currentIndex < 0 && currentMediaId) currentIndex = remoteQueue.findIndex(item => String(item.mediaId || '') === currentMediaId);
const upcoming = currentIndex >= 0 ? remoteQueue.slice(currentIndex + 1) : remoteQueue;
return upcoming.filter(item => {
const id = queueIdOf(item);
if (!id || id === '-1' || id === currentId || !item.title) return false;
if (!currentId || currentId === '-1') {
if (item.mediaId && currentMediaId && item.mediaId === currentMediaId) return false;
}
return !remoteReservations.includes(id);
}).map(item => ({ source: 'netease', id: queueIdOf(item), title: String(item.title),
artist: String(item.artist || ''), cover: String(item.cover || '') }));
}
window.mochiNeteaseQueueCandidates = remoteQueueCandidates;
function finishQueueJump(success) {
if (!pendingQueueJump) return;
clearTimeout(pendingQueueJump.timer);
pendingQueueJump = null;
if (!success) {
manualQueueJumpId = '';
autoReservationTarget = '';
playbackPrompt('需要手动播放哦');
}
}
function queueJumpPlaying(next, pending) {
if (!next.playing) return false;
if (String(next.activeQueueId || '') === pending.id) return true;
if (pending.mediaId && String(next.mediaId || '') === pending.mediaId) return true;
if ((!next.activeQueueId || String(next.activeQueueId) === '-1') && !next.mediaId)
return String(next.title || '') === pending.title && String(next.artist || '') === pending.artist;
return false;
}
function selectQueueItem(id, manual = true) {
const target = String(id || '');
const item = remoteQueue.find(entry => queueIdOf(entry) === target);
if (!activeShared() || !canSelectQueueItem() || !item) {
playbackPrompt('需要手动播放哦');
return false;
}
if (pendingQueueJump) { clearTimeout(pendingQueueJump.timer); pendingQueueJump = null; }
if (manual) {
markManual();
manualQueueJumpId = target;
manualQueueJumpAt = Date.now();
autoReservationTarget = '';
}
remoteReservations = remoteReservations.filter(itemId => itemId !== target);
const pending = { id: target, mediaId: String(item.mediaId || ''), title: String(item.title || ''), artist: String(item.artist || ''), timer: null };
pending.timer = setTimeout(() => { if (pendingQueueJump === pending) finishQueueJump(false); }, 12000);
pendingQueueJump = pending;
if (!call('skipToQueueItem', target)) { finishQueueJump(false); return false; }
return true;
}
window.mochiNeteasePlayQueueItem = selectQueueItem;
window.mochiNeteaseReserveQueueItem = id => {
const target = String(id || '');
if (!remoteQueueCandidates().some(item => item.id === target)) return false;
remoteReservations.push(target);
queueRevision++;
renderRemoteQueue();
return true;
};
const musicStore = window.storeFor ? window.storeFor('default') : null;
const FAV_KEY = 'music-netease-favs';
const clampProb = value => Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 0));
const musicSettings = () => window.mochiMusicGetSettings ? window.mochiMusicGetSettings() : {};
let favorites = [];
try { const saved = JSON.parse(musicStore.get(FAV_KEY) || '[]'); if (Array.isArray(saved)) favorites = saved; } catch (e) {}
let lastAutoAt = 0;
let lastManualAt = 0;
let pendingTaSongChange = null;
let appForeground = true;
let currentTrackKey = '';
let favoriteCheckedKey = '';
let favoriteDueAt = 0;
let completionCandidate = null;
let lastObservedPosition = 0;
let lastObservedAt = 0;
const trackKey = track => [String(track.title || '').trim(), String(track.artist || '').trim(), Math.round(Number(track.duration || 0) / 1000)].join('\u001f');
let taPauseCheckedKey = '';
let taPausePhase = null;
window.mochiNeteaseTaPauseInProgress = () => !!(taPausePhase && taPausePhase.stage !== 'scheduled');
const remotePauseKey = () => 'netease:' + currentQueueId() + ':' + currentTrackKey;
function cancelRemoteTaPause() {
if (taPausePhase && taPausePhase.timer) clearTimeout(taPausePhase.timer);
taPausePhase = null;
}
function maybeScheduleRemoteTaPause() {
if (!state.playing || !currentTrackKey || taPausePhase) return;
const key = remotePauseKey();
if (key === taPauseCheckedKey) return;
taPauseCheckedKey = key; // 每次播放同一曲目只判断一次，未命中也不反复掷骰子。
const settings = musicSettings();
if (!settings.taPauseEn || !window.mochiMusicTaPauseCanSchedule ||
!window.mochiMusicTaPauseCanSchedule(key) ||
Math.random() * 100 >= clampProb(settings.taPauseProb ?? 3)) return;
const phase = { key, stage: 'scheduled', timer: null };
taPausePhase = phase;
phase.timer = setTimeout(() => {
phase.timer = null;
if (taPausePhase !== phase) return;
if (!appForeground || document.hidden || !activeShared() ||
!state.playing || remotePauseKey() !== key || !musicSettings().taPauseEn ||
!window.mochiMusicTaPauseCanSchedule(key)) { cancelRemoteTaPause(); return; }
if (!call('command', 'pause')) { cancelRemoteTaPause(); return; }
phase.stage = 'pause-requested';
phase.timer = setTimeout(() => { if (taPausePhase === phase) cancelRemoteTaPause(); }, 4000);
}, delayToCheck());
}
function reconcileRemoteTaPause() {
const phase = taPausePhase;
if (!phase) return;
if (!appForeground || document.hidden || !activeShared() || !state.title ||
remotePauseKey() !== phase.key || !musicSettings().taPauseEn) { cancelRemoteTaPause(); return; }
if (phase.stage === 'scheduled') {
if (!state.playing) cancelRemoteTaPause();
} else if (phase.stage === 'pause-requested' && !state.playing) {
clearTimeout(phase.timer);
phase.stage = 'paused';
if (window.mochiMusicTaPauseRemoteStarted) window.mochiMusicTaPauseRemoteStarted(phase.key);
phase.timer = setTimeout(() => {
phase.timer = null;
if (taPausePhase !== phase || !appForeground || document.hidden || !activeShared() ||
remotePauseKey() !== phase.key || state.playing || !musicSettings().taPauseEn) {
cancelRemoteTaPause(); return;
}
if (!call('command', 'play')) { cancelRemoteTaPause(); playbackPrompt('需要手动播放哦'); return; }
phase.stage = 'resume-requested';
phase.timer = setTimeout(() => {
if (taPausePhase === phase) { cancelRemoteTaPause(); playbackPrompt('需要手动播放哦'); }
}, 4000);
}, 3500);
} else if (phase.stage === 'paused' && state.playing) {
cancelRemoteTaPause();
} else if (phase.stage === 'resume-requested' && state.playing) {
if (window.mochiMusicTaPauseRemoteResumed) window.mochiMusicTaPauseRemoteResumed();
cancelRemoteTaPause();
}
}
function noteNearEnd(snapshot, key, at = Date.now()) {
if (!snapshot || !snapshot.playing || !key) return;
const duration = Number(snapshot.duration || 0);
let position = Number(snapshot.position || 0);
if (snapshot === state && lastObservedAt && at - lastObservedAt < 2000 && Math.abs(position - lastObservedPosition) < 150)
position += at - lastObservedAt;
if (duration >= 10000 && position >= duration - 3000 && position <= duration + 1000)
completionCandidate = { key, queueId: String(snapshot.activeQueueId || ''), at };
}
function completedNaturally(key, queueId, at) {
const candidate = completionCandidate;
return !!(candidate && candidate.key === key && at - candidate.at <= 7000 &&
(!candidate.queueId || candidate.queueId === '-1' || !queueId || queueId === '-1' || candidate.queueId === queueId));
}
function randomRemoteQueueItem() {
if (!canSelectQueueItem()) return null;
const currentId = currentQueueId();
const mediaId = String(state && state.mediaId || '');
const candidates = remoteQueue.filter(item => {
const id = queueIdOf(item);
return id && id !== '-1' && id !== currentId && item.title &&
(!mediaId || !item.mediaId || String(item.mediaId) !== mediaId);
});
return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
}
function maybeAutoActionAfterSong() {
const settings = musicSettings();
const now = Date.now();
if (!settings.neteaseAutoEn || !activeShared() || !state.playing ||
now - lastAutoAt < 90000 || now - lastManualAt < 15000) return;
const roll = Math.random() * 100;
const nextLimit = clampProb(settings.taNextProb ?? 15);
const randomLimit = nextLimit + clampProb(settings.taRandProb ?? 10);
const modeLimit = randomLimit + clampProb(settings.taModeProb ?? 5);
if (roll < nextLimit) {
if (state.canSkipNext && call('command', 'next')) {
lastAutoAt = now;
pendingTaSongChange = { kind: 'next', previousKey: currentTrackKey, previousQueueId: currentQueueId(), at: now };
if (window.mochiMusicTogetherForce) window.mochiMusicTogetherForce('netease', '', 'netease:' + togetherTrackKey());
}
return;
}
if (roll < randomLimit) {
const item = randomRemoteQueueItem();
if (item && selectQueueItem(queueIdOf(item), false)) {
lastAutoAt = now;
pendingTaSongChange = { kind: 'random', id: queueIdOf(item), title: String(item.title), mediaId: String(item.mediaId || ''), at: now };
if (window.mochiMusicTogetherForce) window.mochiMusicTogetherForce('netease', queueIdOf(item));
}
return;
}
if (roll < modeLimit) {
return;
}
}
const saveFavorites = () => { try { if (musicStore) musicStore.set(FAV_KEY, JSON.stringify(favorites)); } catch (e) {} };
const currentFavorite = () => !!(state && state.title && favorites.some(item => item.key === trackKey(state)));
function renderFavorites() {
const section = byId('netease-favorites');
const list = byId('netease-favorites-list');
if (!section || !list) return;
section.hidden = false;
list.replaceChildren();
if (!favorites.length) {
const empty = document.createElement('p');
empty.className = 'netease-remote-help';
empty.textContent = '还没有网易云收藏';
list.appendChild(empty);
}
favorites.forEach(item => {
const row = document.createElement('div');
row.className = 'netease-favorite-row';
if (item.cover && /^https:\/\//.test(item.cover)) {
const img = document.createElement('img');
img.src = item.cover;
img.alt = '';
row.appendChild(img);
}
const info = document.createElement('div');
info.className = 'netease-favorite-info';
const title = document.createElement('strong');
title.textContent = item.title || '未知歌曲';
const detail = document.createElement('small');
detail.textContent = (item.artist || '未知歌手') + ' · ' + fmt(item.duration);
info.append(title, detail);
row.appendChild(info);
const remove = document.createElement('button');
remove.type = 'button';
remove.textContent = '移除';
remove.addEventListener('click', () => {
favorites = favorites.filter(x => x.key !== item.key);
saveFavorites();
renderFavorites();
renderFavoriteButtons();
});
row.appendChild(remove);
list.appendChild(row);
});
}
function renderFavoriteButtons() {
const liked = currentFavorite();
const button = el('favorite');
if (button) { button.disabled = !(state && state.active && state.title); button.textContent = liked ? '取消收藏当前歌曲' : '收藏当前歌曲'; }
['mw-heart', 'sm-pb-heart', 'sm-f-heart'].forEach(id => {
const heart = byId(id);
if (heart) heart.classList.toggle('liked', activeShared() && liked);
});
}
function toggleFavorite() {
if (!state || !state.active || !state.title) return false;
const key = trackKey(state);
if (currentFavorite()) favorites = favorites.filter(item => item.key !== key);
else favorites.unshift({ key, title: String(state.title), artist: String(state.artist || ''), duration: Number(state.duration || 0), cover: /^https:\/\//.test(lastCover) ? lastCover : '', savedAt: Date.now() });
favorites = favorites.slice(0, 100);
saveFavorites();
renderFavorites();
renderFavoriteButtons();
if (window.toast) window.toast(currentFavorite() ? '已收藏到 CiCi' : '已从 CiCi 收藏移除');
return true;
}
function markManual() { lastManualAt = Date.now(); completionCandidate = null; pendingTaSongChange = null; cancelRemoteTaPause(); }
function resetAutoChecks() {
cancelRemoteTaPause();
favoriteCheckedKey = '';
favoriteDueAt = 0;
completionCandidate = null;
lastObservedPosition = 0;
lastObservedAt = 0;
}
window.mochiNeteaseSetForeground = foreground => {
appForeground = !!foreground;
if (!appForeground) resetAutoChecks();
else call('refresh');
};
const delayToCheck = () => 10000 + Math.floor(Math.random() * 15000);
function autoTick() {
if (!appForeground || document.hidden || !activeShared() || !state || !state.title) return;
const settings = musicSettings();
const now = Date.now();
const key = currentTrackKey;
maybeScheduleRemoteTaPause();
if (state.playing && settings.neteaseAutoEn) noteNearEnd(state, key, now);
if (state.playing && key !== favoriteCheckedKey) {
favoriteCheckedKey = key;
favoriteDueAt = now + delayToCheck();
}
if (favoriteDueAt && now >= favoriteDueAt) {
favoriteDueAt = 0;
const cooldown = window.mochiMusicTaFavCooldownRemaining ? window.mochiMusicTaFavCooldownRemaining() : 0;
const already = window.mochiMusicHasRemoteTaFavorite && window.mochiMusicHasRemoteTaFavorite(key);
if (state.playing && !cooldown && !already && Math.random() * 100 < clampProb(settings.taFavProb ?? 20)) {
const added = window.mochiMusicAddRemoteTaFavorite && window.mochiMusicAddRemoteTaFavorite({
key, title: String(state.title), artist: String(state.artist || ''), duration: Number(state.duration || 0), cover: lastCover
});
if (added && window.mochiMusicNoteTaFav) window.mochiMusicNoteTaFav();
}
}
}
window.mochiNeteaseAutoTick = autoTick;
setInterval(autoTick, 1000);
document.addEventListener('mochi-music-settings-changed', () => {
if (!musicSettings().taPauseEn || clampProb(musicSettings().taPauseProb ?? 3) <= 0) cancelRemoteTaPause();
if (!musicSettings().neteaseAutoEn) completionCandidate = null;
else autoTick();
});
renderFavorites();
window.mochiNeteaseSharedActive = activeShared;
window.mochiNeteaseIsPlaying = () => !!(activeShared() && state.playing);
function adoptCurrentRemoteQueue() {
if (adoptedQueueForTakeover) return true;
if (!activeShared() || !state.playing || !window.mochiMusicAdoptNeteaseQueue) return false;
adoptedQueueForTakeover = !!window.mochiMusicAdoptNeteaseQueue({
queue: remoteQueue.map(item => ({ id: item.id, mediaId: item.mediaId,
title: item.title, artist: item.artist })),
activeQueueId: state.activeQueueId, mediaId: state.mediaId,
title: state.title, artist: state.artist, duration: state.duration,
cover: lastCover
});
return adoptedQueueForTakeover;
}
window.mochiNeteaseUseLocal = fromUnifiedQueue => {
if (fromUnifiedQueue) adoptCurrentRemoteQueue();
localTakeoverAt = Date.now();
localTakeoverMediaId = String(state && state.mediaId || '');
localTakeoverQueueId = String(state && state.activeQueueId || '');
localTakeoverTitle = String(state && state.title || '');
localPauseObserved = !(state && state.playing);
localPauseRetries = 0;
localPauseRetryAt = localTakeoverAt;
if (pendingReservationResume) {
clearTimeout(pendingReservationResume.timer);
pendingReservationResume = null;
}
if (!fromUnifiedQueue || adoptedQueueForTakeover) returnToRemoteAfterLocal = false;
manualQueueJumpId = '';
if (pendingQueueJump) { clearTimeout(pendingQueueJump.timer); pendingQueueJump = null; }
if (state && state.active && state.playing) call('command', 'pause');
sourceChoice = 'local';
resetAutoChecks();
document.body.classList.remove('netease-shared');
};
window.mochiNeteasePrepareTemporaryLocalPlayback = () => {
adoptCurrentRemoteQueue();
returnToRemoteAfterLocal = !!(state && state.access && state.active);
return returnToRemoteAfterLocal;
};
function playLocalQueued(id) {
if (!localQueuedTracks().length) return false;
returnToRemoteAfterLocal = true;
const played = id
? window.mochiMusicPlayQueuedTrack && window.mochiMusicPlayQueuedTrack(id)
: window.mochiMusicPlayNextQueued && window.mochiMusicPlayNextQueued();
if (!played) returnToRemoteAfterLocal = false;
return !!played;
}
window.mochiNeteaseResumeAfterLocal = () => {
if (!returnToRemoteAfterLocal) return false;
returnToRemoteAfterLocal = false;
if (!appForeground || document.hidden) return false;
if (!state || !state.access || !state.active) {
playbackPrompt('要打开网易云哦');
return true;
}
if (!activateRemote()) { playbackPrompt('需要手动播放哦'); return true; }
const reserved = remoteReservations[0];
if (reserved && selectQueueItem(reserved, false)) return true;
if (!call('command', 'play')) playbackPrompt('需要手动播放哦');
return true;
};
function finishReservationResume(success) {
const pending = pendingReservationResume;
if (!pending) return;
clearTimeout(pending.timer);
pendingReservationResume = null;
if (!success) pending.onFailure();
}
window.mochiNeteaseResumeAfterReservation = onFailure => {
returnToRemoteAfterLocal = false;
if (!appForeground || document.hidden || !state || !state.access || !state.active) return false;
if (!activateRemote()) return false;
if (pendingReservationResume) finishReservationResume(false);
const pending = { onFailure, timer: null, startedAt: Date.now() };
pendingReservationResume = pending;
pending.timer = setTimeout(() => {
if (pendingReservationResume === pending) finishReservationResume(false);
}, 8000);
if (!call('command', 'play')) finishReservationResume(false);
return true;
};
function renderShared() {
if (!activeShared()) return;
if (window.mochiMusicTogetherUpdate) window.mochiMusicTogetherUpdate('netease', togetherTrackKey(), !!state.playing);
const song = state.title || '未知歌曲';
const artist = state.artist || '网易云音乐';
const duration = Math.max(0, Number(state.duration || 0));
const position = Math.min(duration || Infinity, Math.max(0, Number(state.position || 0)));
const pct = duration > 0 ? Math.min(100, position / duration * 100) : 0;
document.body.classList.add('netease-shared');
put('mw-song', song);
put('mw-artist', artist + ' · 网易云音乐');
put('mw-cur', fmt(position));
put('mw-dur', fmt(duration));
const fill = byId('mw-fill');
const knob = byId('mw-knob');
if (fill) fill.style.width = pct + '%';
if (knob) knob.style.left = pct + '%';
const cover = byId('mw-cover');
if (cover) {
cover.style.backgroundImage = lastCover ? 'url("' + lastCover.replace(/"/g, '%22') + '")' : '';
cover.style.backgroundSize = lastCover ? 'cover' : '';
cover.style.backgroundPosition = lastCover ? 'center' : '';
cover.classList.toggle('has-cover', !!lastCover);
}
const bar = byId('sm-player-bar');
const batch = byId('music-batch-bar');
if (bar) bar.hidden = !!(batch && !batch.hidden);
put('sm-pb-name', song);
put('sm-pb-artist', artist + ' · 网易云音乐');
put('sm-pb-cur', fmt(position));
put('sm-pb-dur', fmt(duration));
const float = byId('sm-float');
if (float) float.hidden = !(window.mochiMusicRemoteFloatAllowed && window.mochiMusicRemoteFloatAllowed());
put('sm-f-name', song);
put('sm-f-mini-name', song);
put('sm-f-artist', artist + ' · 网易云音乐');
put('sm-f-cur', fmt(position));
put('sm-f-dur', fmt(duration));
const floatFill = byId('sm-f-fill');
if (floatFill) floatFill.style.width = pct + '%';
['mw-play-ico', 'sm-play-ico', 'sm-f-play-ico', 'sm-f-mini-play-ico'].forEach(id => {
const icon = byId(id);
if (icon) icon.innerHTML = state.playing ? playingPath : pausedPath;
});
const bars = byId('mw-bars');
if (bars) { bars.classList.toggle('playing', !!state.playing); bars.classList.remove('buffering'); }
renderFavoriteButtons();
}
window.mochiNeteaseRenderShared = renderShared;
function renderRemoteQueue() {
const container = byId('netease-queue-list');
if (!container) return;
if (!state || !state.active) { container.textContent = '等待网易云音乐播放'; return; }
const localQueue = localQueuedTracks();
const renderKey = queueRevision + ':' + currentTrackKey + ':' + localQueue.map(item => item.id).join(',');
if (container.dataset.renderKey === renderKey) return;
container.dataset.renderKey = renderKey;
const currentMediaId = String(state.mediaId || '');
const currentTitle = String(state.title || '');
let marked = false;
let html = '<div class="sm-req-hint" style="font-weight:700">CiCi 待播队列</div>';
if (localQueue.length) html += localQueue.map(item =>
'<div class="sm-song" data-local-qid="' + escapeHtml(item.id) + '"><div class="sm-song-info">' +
'<div class="sm-song-name">' + escapeHtml(item.title) + '</div><div class="sm-song-sub">' + escapeHtml(item.artist || '未知歌手') + ' · CiCi</div></div>' +
'<button class="sm-song-more" type="button" data-local-rm="' + escapeHtml(item.id) + '" title="移出 CiCi 队列">移除</button></div>'
).join('');
else html += '<p class="sm-req-hint">暂无 CiCi 待播歌曲</p>';
if (remoteReservations.length) {
html += '<div class="sm-req-hint" style="font-weight:700">TA 预订的网易云歌曲</div>';
html += remoteReservations.map(id => {
const item = remoteQueue.find(x => queueIdOf(x) === id);
if (!item) return '';
return '<div class="sm-song" data-remote-qid="' + escapeHtml(id) + '"><div class="sm-song-info">' +
'<div class="sm-song-name">' + escapeHtml(item.title || '未知歌曲') + '</div><div class="sm-song-sub">' + escapeHtml(item.artist || '未知歌手') + ' · 网易云优先播放</div></div>' +
'<button class="sm-song-more" type="button" data-remote-rm="' + escapeHtml(id) + '" title="取消预订">移除</button></div>';
}).join('');
}
html += '<div class="sm-req-hint" style="font-weight:700">' + escapeHtml(remoteQueueTitle || '网易云当前播放列表') + '</div>';
if (remoteQueue.length) {
html += remoteQueue.filter(item => !remoteReservations.includes(queueIdOf(item))).map(item => {
const id = queueIdOf(item);
const match = !marked && ((currentQueueId() !== '-1' && id === currentQueueId()) || (currentMediaId && item.mediaId === currentMediaId) ||
((!currentMediaId || !item.mediaId) && item.title === currentTitle && (!state.artist || item.artist === state.artist)));
if (match) marked = true;
return '<div class="sm-song' + (match ? ' active' : '') + '" data-remote-qid="' + escapeHtml(id) + '">' +
'<div class="sm-song-info"><div class="sm-song-name">' + escapeHtml(item.title || '未知歌曲') + '</div>' +
'<div class="sm-song-sub">' + escapeHtml(item.artist || '未知歌手') + (match ? ' · 正在播放' : '') + '</div></div></div>';
}).join('');
html += '<p class="sm-req-hint">这里显示网易云向安卓系统提供的播放队列，可能只包含部分歌曲。</p>';
if (remoteQueueCount > remoteQueue.length) html += '<p class="sm-req-hint">系统队列较长，当前显示前 ' + remoteQueue.length + ' 首。</p>';
if (!canSelectQueueItem()) html += '<p class="sm-req-hint">网易云当前未开放按队列歌曲跳转，列表暂时只能查看。</p>';
} else {
html += '<div class="sm-song active"><div class="sm-song-info"><div class="sm-song-name">' + escapeHtml(currentTitle || '未知歌曲') + '</div>' +
'<div class="sm-song-sub">' + escapeHtml(state.artist || '未知歌手') + ' · 当前歌曲</div></div></div>' +
'<p class="sm-req-hint">网易云当前没有向安卓媒体会话提供播放队列，CiCi 暂时无法读取完整歌单。请在网易云音乐中查看完整列表。</p>';
}
container.innerHTML = html;
}
function openRemoteQueue() {
if (!activeShared() || !window.openTCPanel) return;
window.openTCPanel('网易云播放列表', '<div id="netease-queue-list"></div><div class="mail-actions"><button class="cc-tool" id="netease-queue-close">关闭</button></div>');
renderRemoteQueue();
const close = byId('netease-queue-close');
if (close) close.addEventListener('click', () => { const mask = byId('tc-mask'); if (mask) mask.hidden = true; });
}
window.mochiNeteaseOpenQueue = openRemoteQueue;
document.addEventListener('click', event => {
const container = byId('netease-queue-list');
if (!container || !container.contains(event.target)) return;
const localRemove = event.target.closest('[data-local-rm]');
if (localRemove) {
if (window.mochiMusicRemoveQueuedTrack) window.mochiMusicRemoveQueuedTrack(localRemove.dataset.localRm);
renderRemoteQueue();
return;
}
const remoteRemove = event.target.closest('[data-remote-rm]');
if (remoteRemove) {
remoteReservations = remoteReservations.filter(id => id !== remoteRemove.dataset.remoteRm);
queueRevision++;
renderRemoteQueue();
return;
}
const localRow = event.target.closest('[data-local-qid]');
if (localRow) {
if (playLocalQueued(localRow.dataset.localQid)) {
const mask = byId('tc-mask'); if (mask) mask.hidden = true;
}
return;
}
const remoteRow = event.target.closest('[data-remote-qid]');
if (remoteRow && selectQueueItem(remoteRow.dataset.remoteQid)) {
const mask = byId('tc-mask'); if (mask) mask.hidden = true;
}
});
const remoteQueueButtons = new Set(['mw-queue', 'sm-queue', 'sm-f-queue', 'sm-lib-queue', 'netease-remote-queue']);
document.addEventListener('click', event => {
const button = event.target.closest && event.target.closest('button');
if (!button || !remoteQueueButtons.has(button.id) || !activeShared()) return;
event.preventDefault();
event.stopImmediatePropagation();
openRemoteQueue();
}, true);
function activateRemote() {
if (!state || !state.access || !state.active) return false;
adoptedQueueForTakeover = false;
sourceChoice = 'remote';
try { if (window.mochiMusicStopForRemote) window.mochiMusicStopForRemote(); } catch (e) {}
renderShared();
return true;
}
window.mochiNeteasePlayCurrent = () => {
if (!activateRemote()) return false;
if (state.playing) return true;
return call('command', 'play');
};
function command(action, manual = true) {
if (action === 'next' && activeShared() && localQueuedTracks().length && playLocalQueued()) return;
if (!activateRemote()) return;
if (manual) markManual();
if (manual && (action === 'pause' || (action === 'toggle' && state.playing)) && window.mochiMusicTogetherPause)
window.mochiMusicTogetherPause();
call('command', action === 'toggle' ? (state.playing ? 'pause' : 'play') : action);
}
const sharedButtons = {
'mw-play': 'toggle', 'mw-prev': 'previous', 'mw-next': 'next',
'sm-play': 'toggle', 'sm-prev': 'previous', 'sm-next': 'next',
'sm-f-play': 'toggle', 'sm-f-mini-play': 'toggle', 'sm-f-prev': 'previous', 'sm-f-next': 'next'
};
Object.keys(sharedButtons).forEach(id => {
const button = byId(id);
if (button) button.addEventListener('click', event => {
if (!activeShared()) return;
event.preventDefault();
event.stopImmediatePropagation();
command(sharedButtons[id]);
}, true);
});
['mw-heart', 'sm-pb-heart', 'sm-f-heart'].forEach(id => {
const button = byId(id);
if (button) button.addEventListener('click', event => {
if (!activeShared()) return;
event.preventDefault();
event.stopImmediatePropagation();
markManual();
toggleFavorite();
}, true);
});
const widgetBar = byId('mw-bar');
if (widgetBar) widgetBar.addEventListener('click', event => {
if (!activeShared()) return;
event.preventDefault();
event.stopImmediatePropagation();
markManual();
if (!(state.duration > 0)) return;
const rect = widgetBar.getBoundingClientRect();
if (rect.width > 0) call('seekTo', Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * state.duration));
}, true);
function paint(raw) {
let next;
try { next = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return; }
if (!next || typeof next !== 'object') return;
const previousState = state;
const previousKey = currentTrackKey;
const previousQueueId = currentQueueId();
const wasRemotePlaying = activeShared() && state.playing;
const now = Date.now();
if (wasRemotePlaying && musicSettings().neteaseAutoEn) noteNearEnd(previousState, previousKey, now);
state = next;
if (sourceChoice === 'local' && next.access && next.active) {
if (!next.playing) localPauseObserved = true;
else if (window.mochiMusicHasLocalPlayback && window.mochiMusicHasLocalPlayback()) {
const remoteChanged = !!((localTakeoverMediaId && next.mediaId && localTakeoverMediaId !== String(next.mediaId)) ||
(localTakeoverQueueId && localTakeoverQueueId !== '-1' && next.activeQueueId &&
localTakeoverQueueId !== String(next.activeQueueId)) ||
(localTakeoverTitle && next.title && localTakeoverTitle !== String(next.title)));
if (!localPauseObserved && !remoteChanged && localPauseRetries < 2 && now - localPauseRetryAt >= 2000) {
localPauseRetries++;
localPauseRetryAt = now;
call('command', 'pause');
}
if (localPauseObserved || remoteChanged || now - localTakeoverAt > 7000) {
sourceChoice = 'remote';
adoptedQueueForTakeover = false;
try { if (window.mochiMusicStopForRemote) window.mochiMusicStopForRemote(); } catch (e) {}
}
}
}
if (pendingReservationResume) {
if (!next.access || !next.active) finishReservationResume(false);
else if (next.playing && Date.now() - pendingReservationResume.startedAt >= 400) finishReservationResume(true);
}
const granted = !!next.access;
const available = granted && !!next.active;
if (pendingQueueJump) {
if (!available) finishQueueJump(false);
else if (queueJumpPlaying(next, pendingQueueJump)) finishQueueJump(true);
}
if (!available && sourceChoice === 'remote') {
resetAutoChecks();
sourceChoice = 'auto';
adoptedQueueForTakeover = false;
document.body.classList.remove('netease-shared');
if (window.mochiMusicTogetherUpdate) window.mochiMusicTogetherUpdate('', '', false);
if (window.mochiMusicRestoreLocalUI) window.mochiMusicRestoreLocalUI();
}
if (available && sourceChoice === 'auto') {
sourceChoice = window.mochiMusicHasLocalPlayback && window.mochiMusicHasLocalPlayback() ? 'local' : 'remote';
}
if (Object.prototype.hasOwnProperty.call(next, 'cover')) lastCover = next.cover || '';
if (Object.prototype.hasOwnProperty.call(next, 'queue')) {
remoteQueue = Array.isArray(next.queue) ? next.queue : [];
remoteQueueCount = Number(next.queueCount || 0);
remoteQueueTitle = String(next.queueTitle || '');
if (sourceChoice === 'local' && adoptedQueueForTakeover && window.mochiMusicRefreshAdoptedQueue)
window.mochiMusicRefreshAdoptedQueue(next);
const missingReservations = remoteReservations.filter(id => !remoteQueue.some(item => queueIdOf(item) === id));
remoteReservations = remoteReservations.filter(id => !missingReservations.includes(id));
if (missingReservations.length) playbackPrompt('需要手动播放哦');
queueRevision++;
} else if (!available) {
remoteQueue = []; remoteQueueCount = 0; remoteQueueTitle = '';
queueRevision++;
}
currentTrackKey = available && next.title ? trackKey(next) : '';
reconcileRemoteTaPause();
if (available && next.playing) {
lastObservedPosition = Number(next.position || 0);
lastObservedAt = now;
}
const queueChanged = previousQueueId && previousQueueId !== '-1' && currentQueueId() !== previousQueueId;
const trackChanged = previousKey && currentTrackKey && (queueChanged || currentTrackKey !== previousKey);
const identityChanged = !!(queueChanged || (previousState && (
(previousState.mediaId && next.mediaId && previousState.mediaId !== next.mediaId) ||
previousState.title !== next.title || previousState.artist !== next.artist)));
if (pendingTaSongChange) {
const action = pendingTaSongChange;
const changed = action.kind === 'random'
? (String(next.activeQueueId || '') === action.id ||
(action.mediaId && String(next.mediaId || '') === action.mediaId) ||
((!next.activeQueueId || String(next.activeQueueId) === '-1') && !next.mediaId && next.title === action.title))
: (currentTrackKey && currentTrackKey !== action.previousKey) ||
(action.previousQueueId && currentQueueId() !== action.previousQueueId);
if (now - action.at > 12000 || !available) pendingTaSongChange = null;
else if (next.playing && changed) {
pendingTaSongChange = null;
const name = window.chatPartnerName ? window.chatPartnerName() : 'TA';
const verb = action.kind === 'random' ? ' 随机挑了一首《' : ' 切到了下一首《';
try { if (window.chatAddSystem) window.chatAddSystem(name + verb + (next.title || '未知歌曲') + '》', { silent: true, nightAllow: true }); } catch (e) {}
}
}
const naturalEnd = identityChanged && completedNaturally(previousKey, previousQueueId, now) && !!next.playing;
const nearTrackEnd = Number(previousState && previousState.duration || 0) >= 10000 &&
Number(previousState && previousState.position || 0) >= Number(previousState.duration) - 3000;
if (wasRemotePlaying && !next.playing && !trackChanged && !nearTrackEnd &&
!(taPausePhase && taPausePhase.stage !== 'scheduled') && window.mochiMusicTogetherPause)
window.mochiMusicTogetherPause();
if (trackChanged && (wasRemotePlaying || naturalEnd) && appForeground && !document.hidden) {
const manualJumpPending = !!(manualQueueJumpId && now - manualQueueJumpAt < 30000);
if (manualQueueJumpId && (currentQueueId() === manualQueueJumpId || !manualJumpPending)) manualQueueJumpId = '';
if (autoReservationTarget && currentQueueId() === autoReservationTarget) autoReservationTarget = '';
else if (autoReservationTarget && now - autoReservationAt > 5000) autoReservationTarget = '';
else if (!manualJumpPending && !autoReservationTarget && now - lastManualAt > 2000) {
if (localQueuedTracks().length) playLocalQueued();
else if (remoteReservations.length) {
const target = remoteReservations[0];
if (target === currentQueueId()) remoteReservations.shift();
else if (selectQueueItem(target, false)) { autoReservationTarget = target; autoReservationAt = now; }
} else if (naturalEnd) maybeAutoActionAfterSong();
}
}
if (trackChanged) resetAutoChecks();
access.hidden = granted;
el('status').textContent = granted ? (available ? (next.playing ? '正在播放' : '已暂停') : '等待网易云播放') : '需要系统授权';
el('help').textContent = granted
? (available ? '正在控制网易云音乐 App；歌单及会员歌曲仍由网易云播放。' : '先在网易云音乐中打开歌单并播放，然后返回 CiCi 点「刷新」。')
: '点下方按钮，进入系统设置开启 CiCi 的通知使用权，然后返回此页。';
el('track').hidden = !available;
el('progress').hidden = !available || !(next.duration > 0);
controls.forEach(id => { el(id).disabled = !available; });
if (el('queue')) el('queue').disabled = !available;
renderFavoriteButtons();
el('play').textContent = next.playing ? '暂停' : '播放';
if (!available) return;
el('title').textContent = next.title || '未知歌曲';
el('artist').textContent = next.artist || '网易云音乐';
const cover = el('cover');
if (Object.prototype.hasOwnProperty.call(next, 'cover')) {
if (next.cover) { if (cover.src !== next.cover) cover.src = next.cover; cover.hidden = false; }
else { cover.removeAttribute('src'); cover.hidden = true; }
}
el('duration').textContent = fmt(next.duration);
if (!dragging) {
const position = Math.min(Math.max(Number(next.position || 0), 0), Number(next.duration || 0));
seek.value = next.duration > 0 ? String(Math.round(position / next.duration * 1000)) : '0';
el('current').textContent = fmt(position);
}
renderShared();
renderRemoteQueue();
autoTick();
}
window.mochiNeteaseUpdate = paint;
access.addEventListener('click', () => call('requestAccess'));
el('refresh').addEventListener('click', () => call('refresh'));
controls.forEach(id => el(id).addEventListener('click', () => {
if (!state || !state.active) return;
command(id === 'play' ? 'toggle' : id === 'prev' ? 'previous' : 'next');
}));
el('favorite').addEventListener('click', () => { markManual(); toggleFavorite(); });
seek.addEventListener('input', () => {
dragging = true;
if (state && state.duration) el('current').textContent = fmt(Number(seek.value) / 1000 * state.duration);
});
seek.addEventListener('change', () => {
if (state && state.active && state.duration && activateRemote()) { markManual(); call('seekTo', Math.round(Number(seek.value) / 1000 * state.duration)); }
dragging = false;
});
let lastPeriodicRefreshAt = Date.now();
document.addEventListener('visibilitychange', () => {
if (document.hidden) { resetAutoChecks(); return; }
call('refresh');
if (Date.now() - lastPeriodicRefreshAt >= 10 * 60 * 1000) {
lastPeriodicRefreshAt = Date.now();
if (window.mochiMusicRefreshRecommendation) window.mochiMusicRefreshRecommendation();
}
});
window.addEventListener('pageshow', () => call('refresh'));
setInterval(() => {
if (document.hidden) return;
lastPeriodicRefreshAt = Date.now();
call('refresh');
if (window.mochiMusicRefreshRecommendation) window.mochiMusicRefreshRecommendation();
}, 10 * 60 * 1000);
call('refresh');
})();
if (window.__mochiLoaded) window.__mochiLoaded.push("netease-remote.js");
} catch (__e) { if (window.__mochiErrLoaded) window.__mochiErrLoaded.push("netease-remote.js"); try { console.error("[JS] netease-remote.js", __e && __e.message || __e); } catch (x) {} if (window.__jsErrors) window.__jsErrors.push("[netease-remote.js] " + String(__e && __e.message || __e)); } })();