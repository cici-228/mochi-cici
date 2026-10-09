(function () { try {
(function () {
const native = window.CiCiNeteaseEnhanced;
if (!native) return;
const recommendationsBar = document.getElementById('cici-netease-recommendations');
if (recommendationsBar) recommendationsBar.hidden = false;
const pending = new Map();
let serial = 0;
let status = null;
let loginTimer = null;
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g,
char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const prompt = message => {
if (window.mochiMusicPlaybackPrompt) window.mochiMusicPlaybackPrompt(message);
else if (window.toast) window.toast(message);
};
function request(action, payload) {
return new Promise((resolve, reject) => {
const token = 'enhanced_' + Date.now() + '_' + ++serial;
const timer = setTimeout(() => {
pending.delete(token);
reject(new Error('网易云接口响应超时'));
}, action === 'fallbackUrl' ? 90000 : 35000);
pending.set(token, { resolve, reject, timer });
try { native.request(token, action, JSON.stringify(payload || {})); }
catch (error) { clearTimeout(timer); pending.delete(token); reject(error); }
});
}
window.ciciNeteaseEnhancedResponse = function (token, raw) {
const item = pending.get(token);
if (!item) return;
pending.delete(token);
clearTimeout(item.timer);
try {
const answer = JSON.parse(raw);
if (!answer.ok) throw new Error(answer.error || '网易云接口调用失败');
item.resolve(answer.data);
} catch (error) { item.reject(error); }
};
async function refresh() { status = await request('status'); return status; }
const enabled = () => !!(status && status.loggedIn && status.playlistId);
const ready = enabled;
const loggedIn = () => !!(status && status.loggedIn);
const tracks = data => {
if (!data) return [];
if (Array.isArray(data.records)) return data.records;
if (Array.isArray(data.songs)) return data.songs;
if (Array.isArray(data.tracks)) return data.tracks;
if (data.result) return tracks(data.result);
if (data.playlist) return tracks(data.playlist);
return [];
};
const usable = song => song && song.id && song.playFlag !== false && song.visible !== false &&
!(song.privilege && song.privilege.st < 0);
function shuffle(items) {
const list = items.slice();
for (let i = list.length - 1; i > 0; i--) {
const j = Math.floor(Math.random() * (i + 1));
[list[i], list[j]] = [list[j], list[i]];
}
return list;
}
const normalizeSong = song => {
if (!song || !song.id) return null;
const artists = song.artists || song.ar || [];
const album = song.album || song.al || {};
return {
id: String(song.id), name: String(song.name || ''),
artists: Array.isArray(artists) ? artists.map(item => item.name || '').filter(Boolean).join(' / ') : String(artists || ''),
picUrl: String(song.picUrl || album.picUrl || ''),
duration: Number(song.duration || song.dt || 0), fee: song.fee,
privilege: song.privilege || null
};
};
const artistParts = value => String(value || '').normalize('NFKC').toLocaleLowerCase()
.split(/[\/／,，、&＆+＋]|\s+(?:feat\.?|ft\.?|with)\s+/i)
.map(part => part.replace(/[^\p{L}\p{N}]/gu, ''))
.filter(part => part.length >= 2);
function matchingArtistSong(songs, title, artist) {
const wantedTitle = String(title || '').trim().normalize('NFKC').toLocaleLowerCase();
const wantedArtists = artistParts(artist);
let best = null;
let bestScore = 0;
for (const song of songs) {
if (String(song.name || '').trim().normalize('NFKC').toLocaleLowerCase() !== wantedTitle) continue;
if (!wantedArtists.length) return song;
const actualArtists = artistParts(song.artists);
const score = wantedArtists.filter(wanted => actualArtists.some(actual =>
wanted === actual || (wanted.length >= 4 && actual.length >= 4 &&
(wanted.includes(actual) || actual.includes(wanted))))).length;
if (score > bestScore) { best = song; bestScore = score; }
}
return best;
}
async function findCandidates(kind, query, maximum = 3) {
if (kind !== 'keyword') {
const result = await request('searchSong', { query });
const all = tracks(result).filter(usable);
const exact = all.filter(song => String(song.name || '').trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase());
return (exact.length ? exact : all).slice(0, maximum).map(normalizeSong).filter(Boolean);
}
const playlistResponse = await request('searchPlaylist', { query });
const playlists = Array.isArray(playlistResponse && playlistResponse.result && playlistResponse.result.playlists)
? playlistResponse.result.playlists : tracks(playlistResponse);
const candidates = [];
for (const playlist of playlists.slice(0, 3)) {
if (!playlist.id) continue;
try {
const songs = tracks(await request('playlistSongs', { playlistId: playlist.id }));
candidates.push(...shuffle(songs.filter(usable)));
} catch (error) { continue; }
if (candidates.length >= maximum) break;
}
return shuffle(candidates).slice(0, maximum).map(normalizeSong).filter(Boolean);
}
async function resolveSong(songId, fullDurationMs) {
const response = await request('songUrl', { songId: String(songId) });
const item = response && response.data && response.data[0];
const url = String(item && item.url || '').replace(/^http:\/\//i, 'https://');
if (!/^https:\/\//i.test(url)) throw new Error('网易云没有返回可播放音源');
const streamMs = Number(item.time || 0);
const fullMs = Number(fullDurationMs || 0);
if (item.freeTrialInfo || (streamMs > 0 && streamMs <= 65000 &&
(fullMs <= 0 || (fullMs >= 90000 && streamMs < fullMs * 0.6))))
throw new Error('网易云只返回试听片段');
return { url, time: streamMs, source: 'netease' };
}
async function fallbackTrack(track, metadata) {
const result = await request('fallbackUrl', {
name: String(metadata && metadata.name || track && track.name || ''),
artist: String(metadata && metadata.artists || track && track.artist || ''),
duration: Number(metadata && metadata.duration || 0) || Number(track && track.duration || 0) * 1000
});
if (!result || !/^https:\/\//i.test(String(result.url || '')))
throw new Error('没有取得可完整播放的备用音源');
return result;
}
async function resolveTrack(track) {
if (!loggedIn()) throw new Error('请先登录网易云');
let songId = String(track && track.neteaseId || '');
let metadata = null;
const remoteQueueTrack = track && track.playlistId === 'cici_netease_remote';
if (/^\d+$/.test(songId)) {
try {
const response = await request('songDetail', { songId });
const songs = response && response.songs;
metadata = Array.isArray(songs) && songs[0] ? normalizeSong(songs[0]) : null;
} catch (error) { metadata = null; }
if (remoteQueueTrack && (!metadata || metadata.name.trim().toLocaleLowerCase() !==
String(track.name || '').trim().toLocaleLowerCase())) {
songId = '';
metadata = null;
}
}
if (!/^\d+$/.test(songId)) {
const title = String(track && track.name || '').trim();
if (!title) throw new Error('歌曲名称为空');
let matches = [];
try { matches = await findCandidates('named', title, 30); } catch (error) {}
const expectedArtist = String(track && track.artist || '').trim();
metadata = matchingArtistSong(matches, title, expectedArtist);
if (!metadata && expectedArtist) {
const firstArtist = String(expectedArtist).split(/[\/／,，、&＆+＋]/)[0].trim();
if (firstArtist) {
try {
const refined = tracks(await request('searchSong', { query: title + ' ' + firstArtist }))
.filter(usable).map(normalizeSong).filter(Boolean);
metadata = matchingArtistSong(refined, title, expectedArtist);
} catch (error) {}
}
}
if (metadata) songId = metadata.id;
}
const fullDuration = Number(metadata && metadata.duration || 0) || Number(track && track.duration || 0) * 1000;
if (/^\d+$/.test(songId)) {
try {
const reliableDuration = metadata || fullDuration > 65000 ? fullDuration : 0;
const stream = await resolveSong(songId, reliableDuration);
return { ...stream, songId, metadata };
} catch (error) { /* 网易云无完整音源或只给试听时再试 Mei 备用源。 */ }
}
const fallback = await fallbackTrack(track, metadata);
return { ...fallback, songId, metadata };
}
async function onlineSongJson(type, value) {
if (!loggedIn()) throw new Error('请先登录网易云');
if (type === 'search' || type === 'style') {
const songs = await findCandidates(type === 'style' ? 'keyword' : 'named', String(value), type === 'style' ? 30 : 3);
return { code: 200, data: { songs } };
}
if (type === 'url') {
const song = value && typeof value === 'object' ? value : { id: String(value) };
const resolved = await resolveTrack({ neteaseId: String(song.id || ''), name: String(song.name || ''),
artist: String(song.artists || ''), duration: Number(song.duration || 0) / 1000 });
return { code: 200, data: [{ url: resolved.url, time: resolved.time, source: resolved.source }] };
}
if (type === 'lyric') {
const result = await request('songLyric', { songId: String(value) });
return { code: 200, data: { lrc: String(result && result.lrc && result.lrc.lyric || '') } };
}
throw new Error('不支持的歌曲请求');
}
async function recommendations(mode, seed) {
if (!loggedIn()) throw new Error('请先在音乐设置中扫码登录网易云');
let response;
if (mode === 'daily') response = await request('dailySongs');
else {
const starting = seed && seed.playlistId && seed.songId
? { songId: seed.songId, playlistId: seed.playlistId }
: await request('heartSeed', { songId: seed && seed.songId || '' });
response = await request('heartSongs', starting);
if (response && typeof response === 'object') response.ciciHeartPlaylistId = String(starting.playlistId || '');
}
const list = mode === 'daily' ? response && response.data && response.data.dailySongs
: response && response.data;
if (Number(response && response.code) !== 200) throw new Error(response && response.message || '网易云没有返回推荐歌曲');
const songs = (Array.isArray(list) ? list : []).map(item => normalizeSong(item.songInfo || item)).filter(item => item && item.name);
if (mode === 'heart') songs.playlistId = String(response.ciciHeartPlaylistId || '');
return songs;
}
async function addRequestedSong(kind, query) {
if (!status) await refresh();
if (!ready()) return { handled: false, reason: '请先在音乐设置中登录网易云并选择自己的歌单' };
const candidates = await findCandidates(kind, String(query || '').trim());
for (const song of candidates) {
try {
const result = await request('addSong', { songId: String(song.id) });
if (!result || result.code !== 200) continue;
return { handled: true, song, added: true };
} catch (error) {
}
}
return { handled: true, added: false, reason: '没有找到可加入歌单的歌曲' };
}
window.ciciNeteaseEnhanced = { request, refresh, enabled, ready, loggedIn, addRequestedSong,
findCandidates, resolveSong, resolveTrack, fallbackTrack, onlineSongJson, recommendations };
function stopPolling() { if (loginTimer) clearInterval(loginTimer); loginTimer = null; }
function showError(error) { prompt(error && error.message || '网易云接口调用失败'); }
async function render() {
stopPolling();
await refresh();
const loggedIn = !!status.loggedIn;
window.openTCPanel('网易云账号',
'<div class="sm-set-hint">CiCi 在手机上直接连接网易云，不需要部署服务器。扫码登录后可在音乐页播放每日推荐和心动模式；会员音源以网易云实际返回为准。登录凭证加密保存在本机。</div>' +
'<div class="mail-actions"><button class="cc-tool" id="nco-test">测试连接</button><button class="cc-tool" id="nco-login">扫码登录</button></div>' +
'<div class="sm-set-hint">账号：' + (loggedIn ? '已授权' : '未授权') + '；目标歌单：' + (status.playlistId ? esc(status.playlistId) : '未选择') + '</div>' +
'<div class="mail-actions"><button class="cc-tool" id="nco-playlists"' + (!loggedIn ? ' disabled' : '') + '>选择我的歌单</button><button class="cc-tool" id="nco-logout"' + (!loggedIn ? ' disabled' : '') + '>退出授权</button></div>');
document.getElementById('nco-test').onclick = async () => {
try { await request('test'); prompt('网易云连接成功'); }
catch (error) { showError(error); }
};
document.getElementById('nco-login').onclick = async () => {
try {
const login = await request('beginLogin');
const key = String(login.key || '');
const url = String(login.qrurl || '');
if (!key || !/^https:\/\//i.test(url)) throw new Error('网易云未返回有效登录二维码');
if (typeof window.qrcode !== 'function') throw new Error('二维码组件未加载，请重新打开音乐设置');
const qr = window.qrcode(0, 'M');
qr.addData(url); qr.make();
window.openTCPanel('扫码授权网易云', '<div class="sm-set-hint">用网易云音乐扫描二维码并确认授权；同一部手机可截图后在网易云扫码页从相册选择。</div>' +
'<div style="text-align:center;background:white;padding:12px;margin:12px auto;width:max-content;max-width:100%">' + qr.createSvgTag(4, 4) + '</div>' +
'<div class="sm-set-hint">二维码有效期 5 分钟</div><div class="mail-actions"><button class="cc-tool" id="nco-login-back">返回</button></div>');
document.getElementById('nco-login-back').onclick = () => { stopPolling(); render().catch(showError); };
const started = Date.now();
let polling = false;
loginTimer = setInterval(async () => {
if (polling || !document.getElementById('nco-login-back')) { if (!document.getElementById('nco-login-back')) stopPolling(); return; }
if (Date.now() - started > 300000) { stopPolling(); prompt('二维码已过期，请重新获取'); return; }
polling = true;
try {
const result = await request('pollLogin', { key });
if (result.loggedIn) { stopPolling(); prompt('网易云账号已授权'); await render(); }
else if (result.status === 800 || result.status === 804) { stopPolling(); prompt(result.message || '请重新获取登录二维码'); }
} catch (error) { stopPolling(); showError(error); }
finally { polling = false; }
}, 3000);
} catch (error) { showError(error); }
};
document.getElementById('nco-playlists').onclick = async () => {
try {
const list = tracks(await request('playlists')).filter(item => item && item.id);
window.openTCPanel('选择网易云歌单', '<div class="sm-set-hint">仅能添加到自己创建的歌单。</div>' +
(list.length ? list.map(item => '<button class="cc-tool" data-nco-playlist="' + esc(item.id) + '" style="display:block;width:100%;margin:8px 0;text-align:left">' + esc(item.name || item.id) + '</button>').join('') : '<div class="sm-set-hint">未找到自己创建的歌单</div>'));
document.querySelectorAll('[data-nco-playlist]').forEach(button => button.onclick = async () => {
try { await request('choosePlaylist', { playlistId: button.dataset.ncoPlaylist }); prompt('已选择网易云歌单'); await render(); }
catch (error) { showError(error); }
});
} catch (error) { showError(error); }
};
document.getElementById('nco-logout').onclick = async () => {
try { await request('logout'); await render(); } catch (error) { showError(error); }
};
}
window.ciciNeteaseEnhancedSettings = () => render().catch(showError);
refresh().catch(() => {});
})();
if (window.__mochiLoaded) window.__mochiLoaded.push("netease-enhanced.js");
} catch (__e) { if (window.__mochiErrLoaded) window.__mochiErrLoaded.push("netease-enhanced.js"); try { console.error("[JS] netease-enhanced.js", __e && __e.message || __e); } catch (x) {} if (window.__jsErrors) window.__jsErrors.push("[netease-enhanced.js] " + String(__e && __e.message || __e)); } })();