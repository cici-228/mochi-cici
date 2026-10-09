import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/js/music-lyrics.js'), 'utf8');
const values = new Map();
const events = [];
let now = 100000;
let remote = null;
let together = false;
const requests = [];

function node() {
  const handlers = {};
  const classes = new Set();
  return {
    hidden: false, disabled: false, textContent: '', children: [],
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    setAttribute() {}, addEventListener(name, fn) { handlers[name] = fn; },
    click() { handlers.click?.(); }, append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); }, replaceChildren() { this.children = []; }
  };
}
const ids = Object.fromEntries([
  'music-lyric-card', 'week-original', 'music-lyric-line', 'music-lyric-save',
  'music-lyric-fav-mine', 'music-lyric-fav-ta'
].map(id => [id, node()]));
const window = {
  __activeCid: 'test', activeStore: () => ({ get: key => values.get(key), set: (key, value) => values.set(key, value) }),
  mochiNeteaseLyricSnapshot: () => remote,
  mochiMusicLocalLyricSnapshot: () => null,
  mochiMusicTogetherVisible: () => together,
  mochiMusicGetSettings: () => ({ taLyricFavProb: 100 }),
  chatPartnerName: () => '测试联系人',
  chatAddIn: (message, options) => events.push({ message, options }),
  chatAddSystem: message => events.push({ system: message }),
  ciciMusicLyricRequest: async (type, value) => {
    requests.push({ type, value });
    if (type === 'search') return { data: { songs: [
      { id: 91, name: '同名歌', artists: '其他歌手' },
      { id: 92, name: '同名歌', artists: '原唱歌手' }
    ] } };
    return { data: { lrc: '[00:00.00]第一句\n[00:10.50]第二句\n[00:20.00]第三句' } };
  }
};
const fakeMath = Object.create(Math);
fakeMath.random = () => 0;
vm.runInNewContext(source, {
  window, document: { hidden: false, getElementById: id => ids[id], createElement: node },
  Date: { now: () => now }, Math: fakeMath, setInterval() {}
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function check(label, condition) {
  if (!condition) throw new Error(label);
  console.log('PASS ' + label);
}

remote = { key: 'song-1', title: '测试歌曲', artist: '原唱歌手', mediaId: '123', position: 12000 };
window.ciciMusicLyricsTick();
await flush();
window.ciciMusicLyricsTick();
check('播放时本周日常改为当前歌词', ids['week-original'].hidden &&
  ids['music-lyric-line'].textContent === '第二句');
check('有歌曲 ID 时直接取歌词', requests.length === 1 && requests[0].type === 'lyric' && requests[0].value === '123');
ids['music-lyric-save'].click();
check('我的收藏只保存当前一句', JSON.parse(values.get('music-lyric-favs-mine')).length === 1 &&
  JSON.parse(values.get('music-lyric-favs-mine'))[0].text === '第二句');
now += 10001;
window.ciciMusicLyricsTick();
check('没有陪听提示时 TA 不收藏', !values.has('music-lyric-favs-ta'));
together = true;
window.ciciMusicLyricsTick();
check('陪听时按概率收藏当时的一句', JSON.parse(values.get('music-lyric-favs-ta'))[0].text === '第二句' &&
  events.length === 1 && events[0].message === '"第二句"' &&
  events[0].options.silent === true && events[0].options.rateAllow === true && !events[0].system);
window.ciciMusicLyricsTick();
check('同一首歌不会重复收藏', JSON.parse(values.get('music-lyric-favs-ta')).length === 1);
remote = null;
window.ciciMusicLyricsTick();
check('停止后恢复本周日常', !ids['week-original'].hidden && ids['music-lyric-card'].hidden);
remote = { key: 'song-2', title: '同名歌', artist: '原唱歌手', mediaId: '', position: 21000 };
together = false;
window.ciciMusicLyricsTick();
await flush();
window.ciciMusicLyricsTick();
check('无歌曲 ID 时核对歌名和歌手', requests.some(item => item.type === 'lyric' && item.value === '92') &&
  ids['music-lyric-line'].textContent === '第三句');
