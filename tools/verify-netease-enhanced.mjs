import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const code = readFileSync(join(root, 'src/js/netease-enhanced.js'), 'utf8');
const calls = [];
let loggedIn = true;
let streamTrial = false;
const window = { toast() {} };
window.CiCiNeteaseEnhanced = {
  request(token, action, raw) {
    const payload = JSON.parse(raw);
    calls.push({ action, payload });
    let data;
    if (action === 'status') data = { configured: true, loggedIn, playlistId: loggedIn ? 'mine' : '' };
    else if (action === 'searchSong') data = { result: { songs: [
      { id: 'bad', name: '测试曲', playFlag: false },
      { id: 'first', name: '测试曲', playFlag: true },
      { id: 'second', name: '测试曲', playFlag: true }
    ] } };
    else if (action === 'searchPlaylist') data = { result: { playlists: [{ id: 'broken' }, { id: 'good' }] } };
    else if (action === 'playlistSongs' && payload.playlistId === 'broken') {
      queueMicrotask(() => window.ciciNeteaseEnhancedResponse(token, JSON.stringify({ ok: false, error: '临时失败' })));
      return;
    } else if (action === 'playlistSongs') data = { tracks: [{ id: 'style', name: '风格歌曲', playFlag: true }] };
    else if (action === 'heartSeed') data = { songId: payload.songId || 'liked-first', playlistId: 'liked' };
    else if (action === 'heartSongs') data = { code: 200, data: [{ songInfo: { id: 300, name: '心动曲', ar: [{ name: '歌手' }], dt: 180000 } }] };
    else if (action === 'dailySongs') data = { code: 200, data: { dailySongs: [{ id: 200, name: '每日曲', ar: [{ name: '歌手' }], dt: 200000 }] } };
    else if (action === 'songUrl') data = { data: [{ url: 'https://example.com/song.mp3', time: streamTrial ? 30000 : 180000 }] };
    else if (action === 'fallbackUrl') data = { url: 'https://example.com/backup.mp3', time: 180000, source: 'migu' };
    else if (action === 'songDetail') data = { songs: [{ id: payload.songId, name: '队列歌曲', dt: 180000 }] };
    else if (action === 'addSong' && payload.songId === 'first') {
      queueMicrotask(() => window.ciciNeteaseEnhancedResponse(token, JSON.stringify({ ok: false, error: '不能加入' })));
      return;
    } else if (action === 'addSong') data = { code: 200 };
    queueMicrotask(() => window.ciciNeteaseEnhancedResponse(token, JSON.stringify({ ok: true, data })));
  }
};
vm.runInNewContext(code, { window, setTimeout, clearTimeout, setInterval, clearInterval, Math, document: { getElementById: () => null } });
const api = window.ciciNeteaseEnhanced;
assert.ok(api);
await api.refresh();
const named = await api.addRequestedSong('named', '测试曲');
assert.equal(named.song.id, 'second');
assert.deepEqual(calls.filter(call => call.action === 'addSong').map(call => call.payload.songId), ['first', 'second']);
calls.length = 0;
const style = await api.addRequestedSong('keyword', '幸福');
assert.equal(style.song.id, 'style');
assert.deepEqual(calls.filter(call => call.action === 'playlistSongs').map(call => call.payload.playlistId), ['broken', 'good']);
calls.length = 0;
assert.equal((await api.recommendations('daily'))[0].name, '每日曲');
assert.equal((await api.recommendations('heart', { songId: '123' }))[0].name, '心动曲');
assert.equal(calls.find(call => call.action === 'heartSeed').payload.songId, '123');
assert.deepEqual(calls.find(call => call.action === 'heartSongs').payload, { songId: '123', playlistId: 'liked' });
calls.length = 0;
const refreshedHeart = await api.recommendations('heart', { songId: '300', playlistId: 'liked' });
assert.equal(refreshedHeart.playlistId, 'liked');
assert.deepEqual(calls.filter(call => call.action === 'heartSeed'), []);
assert.deepEqual(calls.find(call => call.action === 'heartSongs').payload, { songId: '300', playlistId: 'liked' });
assert.equal((await api.resolveSong('300', 180000)).time, 180000);
assert.equal((await api.resolveTrack({ neteaseId: '300', duration: 0 })).songId, '300');
assert.equal((await api.resolveTrack({ neteaseId: '300', name: '队列歌曲',
  playlistId: 'cici_netease_remote', duration: 0 })).songId, '300');
assert.ok(calls.some(call => call.action === 'songDetail' && call.payload.songId === '300'));
calls.length = 0;
streamTrial = true;
const recovered = await api.onlineSongJson('url', { id: '300', name: '队列歌曲', artists: '歌手', duration: 180000 });
assert.equal(recovered.data[0].url, 'https://example.com/backup.mp3');
assert.deepEqual(calls.filter(call => call.action === 'songUrl' || call.action === 'fallbackUrl')
  .map(call => call.action), ['songUrl', 'fallbackUrl']);
assert.equal(calls.find(call => call.action === 'fallbackUrl').payload.duration, 180000);
calls.length = 0;
loggedIn = false;
await api.refresh();
const unconfigured = await api.addRequestedSong('named', '测试曲');
assert.equal(unconfigured.handled, false);
assert.equal(calls.some(call => call.action === 'searchSong' || call.action === 'addSong'), false);
console.log('网易云账号歌单桥接流程：搜索、候选重试、试听后备用音源、歌单失败回退、未授权保护均通过');
