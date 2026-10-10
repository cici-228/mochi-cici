// Second-page lyric display and single-line favorites for CiCi and NetEase playback.
(() => {
  const card = document.getElementById('music-lyric-card');
  const original = document.getElementById('week-original');
  const lineNode = document.getElementById('music-lyric-line');
  const saveButton = document.getElementById('music-lyric-save');
  if (!card || !original || !lineNode || !saveButton) return;

  const store = window.activeStore();
  const keys = { mine: 'music-lyric-favs-mine', ta: 'music-lyric-favs-ta' };
  let activeKey = '';
  let current = null;
  let lines = [];
  let shownLine = null;
  let lookupSerial = 0;
  let taDueAt = 0;
  let taChecked = false;
  const taLastFavoriteAt = new Map(); // 各联系人独立计时，切桌面不占用另一位 TA 的收藏机会。
  let displayedCid = window.__activeCid || 'default';
  const cache = new Map();

  function favorites(who) {
    try {
      const saved = JSON.parse(store.get(keys[who]) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (e) { return []; }
  }
  function favoriteKey(song, line) {
    return [song.title.trim(), song.artist.trim(), line.text.trim()].join('\u001f').toLocaleLowerCase();
  }
  function parseLrc(raw) {
    const result = [];
    String(raw || '').split(/\r?\n/).forEach(row => {
      const stamps = Array.from(row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g));
      const text = row.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim();
      if (!text) return;
      stamps.forEach(match => {
        const fraction = match[3] || '';
        const ms = (Number(match[1]) * 60 + Number(match[2])) * 1000 +
          (fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0);
        result.push({ ms, text });
      });
    });
    return result.sort((a, b) => a.ms - b.ms);
  }
  const normalize = value => String(value || '').toLocaleLowerCase().replace(/[\s·•._\-/]/g, '');
  async function findLyrics(song) {
    const request = window.ciciMusicLyricRequest;
    if (song.lrc) return parseLrc(song.lrc);
    if (typeof request !== 'function') return [];
    let id = /^\d{1,20}$/.test(song.mediaId) ? song.mediaId : '';
    if (id) {
      try {
        const result = await request('lyric', id);
        const direct = parseLrc(result.data && result.data.lrc);
        if (direct.length) return direct;
      } catch (e) {}
    }
    for (const query of [[song.title, song.artist].filter(Boolean).join(' '), song.title]) {
      const result = await request('search', query);
      const candidates = result.data && result.data.songs;
      const matched = (Array.isArray(candidates) ? candidates : []).find(item => {
        const artist = normalize(item.artists);
        return normalize(item.name) === normalize(song.title) &&
          (!song.artist || !!artist && (artist.includes(normalize(song.artist)) || normalize(song.artist).includes(artist)));
      });
      if (!matched || !/^\d{1,20}$/.test(String(matched.id))) continue;
      id = String(matched.id);
      const lyrics = await request('lyric', id);
      return parseLrc(lyrics.data && lyrics.data.lrc);
    }
    return [];
  }
  function renderFavorites(who) {
    const listNode = document.getElementById('music-lyric-fav-' + who);
    if (!listNode) return;
    listNode.replaceChildren();
    const entries = favorites(who);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'ta-empty';
      empty.textContent = '还没有收藏歌词';
      listNode.appendChild(empty);
      return;
    }
    entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'music-lyric-favorite-row' + (who === 'mine' ? ' mine-selectable' : '');
      if (who === 'mine') {
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', '发送歌词到聊天：' + entry.text);
        row.addEventListener('click', event => {
          if (event.target === remove) return;
          openSendLyricPanel(entry);
        });
        row.addEventListener('keydown', event => {
          if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          openSendLyricPanel(entry);
        });
      }
      const content = document.createElement('span');
      content.textContent = entry.text;
      const detail = document.createElement('small');
      detail.textContent = '《' + entry.title + '》' + (entry.artist ? ' · ' + entry.artist : '');
      content.appendChild(detail);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = '移除这句歌词';
      remove.setAttribute('aria-label', '移除这句歌词');
      remove.textContent = '×';
      remove.addEventListener('click', event => {
        event.stopPropagation();
        store.set(keys[who], JSON.stringify(favorites(who).filter(item => item.key !== entry.key)));
        renderFavorites(who);
        renderCurrentLine();
      });
      row.append(content, remove);
      listNode.appendChild(row);
    });
  }
  function openSendLyricPanel(entry) {
    if (!entry || !String(entry.text || '').trim() || !window.openTCPanel) return;
    const cid = window.__activeCid || 'default';
    window.openTCPanel('发送歌词', '<div class="sm-req-detail" id="music-lyric-send-preview"></div>' +
      '<div class="mail-actions"><button class="cc-tool" id="music-lyric-send-cancel">取消</button>' +
      '<button class="cc-tool" id="music-lyric-send-confirm">发送到聊天</button></div>');
    const preview = document.getElementById('music-lyric-send-preview');
    const cancel = document.getElementById('music-lyric-send-cancel');
    const confirm = document.getElementById('music-lyric-send-confirm');
    if (!preview || !cancel || !confirm) return;
    preview.textContent = '“' + entry.text + '”';
    const close = () => { const mask = document.getElementById('tc-mask'); if (mask) mask.hidden = true; };
    cancel.addEventListener('click', close);
    confirm.addEventListener('click', () => {
      if ((window.__activeCid || 'default') !== cid) { close(); return; }
      if (!window.chatSendQuotedLyric || !window.chatSendQuotedLyric(entry.text)) {
        if (window.toast) window.toast('发送失败，请稍后再试');
        return;
      }
      close();
      if (window.toast) window.toast('已发送到聊天');
    });
  }
  function saveFavorite(who) {
    if (!current || !shownLine) return false;
    const key = favoriteKey(current, shownLine);
    const list = favorites(who);
    if (list.some(entry => entry.key === key)) return false;
    list.unshift({ key, title: current.title, artist: current.artist, text: shownLine.text,
      offsetMs: shownLine.ms, savedAt: Date.now() });
    store.set(keys[who], JSON.stringify(list.slice(0, 500)));
    renderFavorites(who);
    renderCurrentLine();
    return true;
  }
  function renderCurrentLine() {
    if (!current) return;
    let line = null;
    for (const item of lines) {
      if (item.ms > current.position) break;
      line = item;
    }
    shownLine = line;
    lineNode.textContent = line ? line.text : (lines.length ? '♪' : '暂无同步歌词');
    saveButton.disabled = !line;
    saveButton.classList.toggle('liked', !!(line && favorites('mine').some(item => item.key === favoriteKey(current, line))));
  }
  function snapshot() {
    const remote = window.mochiNeteaseLyricSnapshot && window.mochiNeteaseLyricSnapshot();
    if (remote) return { ...remote, source: 'netease' };
    const local = window.mochiMusicLocalLyricSnapshot && window.mochiMusicLocalLyricSnapshot();
    return local ? { ...local, source: 'cici' } : null;
  }
  function tick() {
    const cid = window.__activeCid || 'default';
    if (cid !== displayedCid) {
      displayedCid = cid;
      renderFavorites('mine');
      renderFavorites('ta');
    }
    const song = snapshot();
    original.hidden = !!song;
    card.hidden = !song;
    if (!song) { current = null; shownLine = null; activeKey = ''; lookupSerial++; return; }
    const key = cid + ':' + song.source + ':' + song.key;
    if (key !== activeKey) {
      activeKey = key;
      current = song;
      shownLine = null;
      lines = [];
      taDueAt = Date.now() + 10000 + Math.floor(Math.random() * 15000);
      taChecked = false;
      lineNode.textContent = '正在查找歌词…';
      saveButton.disabled = true;
      const serial = ++lookupSerial;
      if (cache.has(key)) lines = cache.get(key);
      else findLyrics(song).then(found => {
        if (serial !== lookupSerial) return;
        lines = found;
        cache.set(key, found);
        renderCurrentLine();
      }).catch(() => {
        if (serial !== lookupSerial) return;
        lines = [];
        renderCurrentLine();
      });
    }
    current = song;
    if (cache.has(key)) { lines = cache.get(key); renderCurrentLine(); }
    if (document.hidden || taChecked || Date.now() < taDueAt ||
        Date.now() - (taLastFavoriteAt.get(cid) || 0) < 90000 || !shownLine ||
        !(window.mochiMusicTogetherVisible && window.mochiMusicTogetherVisible())) return;
    taChecked = true;
    const settings = window.mochiMusicGetSettings ? window.mochiMusicGetSettings() : {};
    const chance = Math.max(1, Math.min(100, Number(settings.taLyricFavProb ?? 20) || 20));
    if (Math.random() * 100 >= chance || !saveFavorite('ta')) return;
    taLastFavoriteAt.set(cid, Date.now());
    const name = window.chatPartnerName ? window.chatPartnerName() : 'TA';
    if (window.chatAddIn) window.chatAddIn('"' + shownLine.text + '"',
      { silent: true, nightAllow: true, rateAllow: true });
    if (window.toast) window.toast(name + ' 收藏了这句歌词');
  }
  saveButton.addEventListener('click', () => {
    if (saveFavorite('mine') && window.toast) window.toast('已收藏这句歌词');
  });
  renderFavorites('mine');
  renderFavorites('ta');
  window.ciciMusicLyricsTick = tick;
  setInterval(tick, 1000);
  tick();
})();
