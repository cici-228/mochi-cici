import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const code = readFileSync(join(root, 'src/js/quote-cards.js'), 'utf8');
const desks = new Map();
let cid = 'a';
let day = 1;
const desk = () => {
  if (!desks.has(cid)) desks.set(cid, new Map());
  return desks.get(cid);
};
const window = {
  activePrefix: () => 'xy-home-v2:' + cid,
  activeStore: () => ({ get: key => desk().get(key) ?? null, set: (key, value) => desk().set(key, value) })
};
const FixedDate = class extends Date {
  constructor(...args) { super(...(args.length ? args : [2026, 9, day])); }
};
const document = { getElementById: () => null };
vm.runInNewContext(code, { window, document, Date: FixedDate, setTimeout });

desk().set('quote-cards-default', '0');
desk().set('music-lyric-favs-mine', JSON.stringify([{ text: '第一句' }]));
desk().set('music-lyric-favs-ta', JSON.stringify([{ text: '第一句' }]));
assert.equal(window.getQuoteOfDay(), '“第一句”');

cid = 'b';
desk().set('quote-cards-default', '0');
desk().set('music-lyric-favs-ta', JSON.stringify([{ text: '第二句' }]));
assert.equal(window.getQuoteOfDay(), '“第二句”');
cid = 'c';
desk().set('quote-cards-default', '0');
assert.equal(window.getQuoteOfDay(), '');
cid = 'a';
assert.equal(window.getQuoteOfDay(), '“第一句”');
console.log('今日情话按联系人读取我的/TA 歌词收藏，切换桌面不会串用');

desk().set('quote-cards-default', '1');
let pickedLyric = false;
for (day = 1; day <= 366; day++) {
  if (window.getQuoteOfDay() === '“第一句”') { pickedLyric = true; break; }
}
assert.ok(pickedLyric, '开启系统情话时歌词仍应进入每日候选池');
console.log('系统情话开启时，收藏歌词也能被每日选中');
