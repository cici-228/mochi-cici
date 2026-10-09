// 黑屏模拟播放器：仅计时和移动进度，不加载或播放视频。
(function () {
  const page = document.getElementById('page-movie');
  const app = document.querySelector('.app[data-app="movie"]');
  const button = document.getElementById('movie-toggle');
  const stop = document.getElementById('movie-stop');
  const progress = document.getElementById('movie-progress');
  const elapsed = document.getElementById('movie-elapsed');
  const durationLabel = document.getElementById('movie-duration');
  const back = document.getElementById('movie-back');
  const title = document.getElementById('movie-title');
  const companion = document.getElementById('movie-companion');
  const comment = document.getElementById('movie-comment');
  const commentInner = document.getElementById('movie-comment-inner');
  const writeButton = document.getElementById('movie-write');
  const composer = document.getElementById('movie-composer');
  const commentInput = document.getElementById('movie-comment-input');
  const commentSend = document.getElementById('movie-comment-send');
  const settingsBtn = document.getElementById('movie-settings');
  const player = document.getElementById('movie-player');
  const choice = document.getElementById('movie-choice');
  const library = document.getElementById('movie-library');
  const libraryList = document.getElementById('movie-library-list');
  const hallTab = document.getElementById('movie-tab-hall');
  const libraryTab = document.getElementById('movie-tab-library');
  const fullscreen = document.getElementById('movie-fullscreen');
  const phone = document.querySelector('.phone');
  const floatBox = document.getElementById('movie-float');
  const floatTitle = document.getElementById('movie-float-title');
  const floatTime = document.getElementById('movie-float-time');
  const floatProgress = document.getElementById('movie-float-progress');
  const floatToggle = document.getElementById('movie-float-toggle');
  const floatReturn = document.getElementById('movie-float-return');
  if (!page || !app || !button || !stop || !progress || !elapsed || !durationLabel || !back || !title || !companion || !comment || !commentInner || !writeButton || !composer || !commentInput || !commentSend || !settingsBtn || !player || !choice || !library || !libraryList || !hallTab || !libraryTab || !fullscreen || !phone || !floatBox || !floatTitle || !floatTime || !floatProgress || !floatToggle || !floatReturn) return;

  const COMMENT_SETTINGS = {
    prob: { key: 'movie-comment-prob', label: '评论出现概率（%）', min: 0, max: 100, defaultValue: 20 },
    retry: { key: 'movie-comment-retry', label: '未出现时重试间隔（分钟）', min: 1, max: 120, defaultValue: 10 },
    chatShare: { key: 'movie-comment-chat-share', label: '普通聊天字卡占比（%）', min: 0, max: 100, defaultValue: 20 },
    replyProb: { key: 'movie-comment-reply-prob', label: '我评论后 TA 回复概率（%）', min: 0, max: 100, defaultValue: 20 }
  };
  const INVITE_SETTINGS = {
    inviteProb: { key: 'movie-invite-prob', label: 'TA 邀请看电影概率（0.1%～100%）', min: 0.1, max: 100, step: 0.1, defaultValue: 5 },
    companionProb: { key: 'movie-companion-prob', label: '自行播放时 TA 陪看概率（%）', min: 0, max: 100, step: 1, defaultValue: 50 }
  };
  const INVITE_COOLDOWN_KEY = 'movie-invite-declined-at';
  const INVITE_ACCEPTED_KEY = 'movie-invite-accepted';
  const INVITE_COOLDOWN_MS = 12 * 60 * 60 * 1000;
  const BUBBLE_COLORS = [
    { color: '#111111', label: '默认黑' }, { color: '#ffffff', label: '白色' },
    { color: '#3a3a3a', label: '炭灰' }, { color: '#ffd6e0', label: '樱花粉' },
    { color: '#d6e4ff', label: '雾霭蓝' }, { color: '#d8f5e0', label: '薄荷绿' },
    { color: '#fff3d6', label: '奶油黄' }, { color: '#e8dcff', label: '淡紫' },
    { color: '#ffdcc0', label: '暖橘' }
  ];
  const BUBBLE_STYLE = {
    inBg: { key: 'movie-bubble-in-bg', label: 'TA 的气泡颜色', defaultValue: '#ffffff' },
    outBg: { key: 'movie-bubble-out-bg', label: '我的气泡颜色', defaultValue: '#111111' }
  };
  const BUBBLE_OPACITY_KEY = 'movie-bubble-opacity';
  let imported = false; // 仅本次启动有效，重新打开 CiCi 后需再次输入链接
  let pendingTitleUrl = '';
  let sourceDurationSec = 0;
  let shareRequestSerial = 0;
  let nativeVideoSerial = 0;
  const nativeVideoPending = new Map();
  let seconds = 0;
  let playing = false;
  let startedAt = 0;
  let timer = null;
  let commentTimer = null;
  const replyTimers = new Set();
  let movieSession = 0;
  let previousComment = '';
  let watchStartedAt = 0;
  let companionChosen = false;
  let companionActive = false;
  let inviteForced = false;
  let recordSerial = 0;
  let view = 'menu';
  const HISTORY_KEY = 'movie-history';

  function settingValue(name) {
    const config = COMMENT_SETTINGS[name];
    try {
      const raw = window.activeStore().get(config.key);
      if (raw !== null && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return Math.max(config.min, Math.min(config.max, Math.round(n)));
      }
    } catch (e) {}
    return config.defaultValue;
  }
  function saveSetting(name, raw) {
    const config = COMMENT_SETTINGS[name];
    const n = Number(raw);
    const value = Math.max(config.min, Math.min(config.max, Number.isFinite(n) ? Math.round(n) : settingValue(name)));
    try { window.activeStore().set(config.key, String(value)); } catch (e) {}
    return value;
  }
  function inviteSetting(name) {
    const config = INVITE_SETTINGS[name];
    try {
      const raw = window.activeStore().get(config.key);
      if (raw !== null && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n)) return normalizeInviteSetting(config, n);
      }
    } catch (e) {}
    return config.defaultValue;
  }
  function normalizeInviteSetting(config, raw) {
    const decimals = config.step < 1 ? 1 : 0;
    const rounded = Number((Math.round(raw / config.step) * config.step).toFixed(decimals));
    return Math.max(config.min, Math.min(config.max, rounded));
  }
  function saveInviteSetting(name, raw) {
    const config = INVITE_SETTINGS[name];
    const n = Number(raw);
    const value = Number.isFinite(n) ? normalizeInviteSetting(config, n) : inviteSetting(name);
    try { window.activeStore().set(config.key, String(value)); } catch (e) {}
    return value;
  }
  function movieSay(text, inbound) {
    try {
      if (inbound && window.chatAddIn) window.chatAddIn(text, { silent: true });
      else if (window.chatAddSystem) window.chatAddSystem(text, { silent: true, rateAllow: true, nightAllow: true });
    } catch (e) {}
  }
  function partnerName() {
    try { return window.chatPartnerName ? window.chatPartnerName() : 'TA'; } catch (e) { return 'TA'; }
  }
  function startCompanion() {
    inviteForced = true;
    companionChosen = true;
    companionActive = true;
    render();
    if (playing) tryComment();
  }
  function restoreCompanionInvite() {
    let accepted = false;
    try { accepted = window.activeStore().get(INVITE_ACCEPTED_KEY) === '1'; } catch (e) {}
    inviteForced = accepted;
    companionChosen = accepted;
    companionActive = accepted;
    render();
  }
  window.movieInviteAcceptedFor = function (cid) {
    try { window.storeForCid(cid).set(INVITE_ACCEPTED_KEY, '1'); } catch (e) {}
    if ((window.__activeCid || 'default') === cid) startCompanion();
  };
  window.maybeMovieRequest = function () {
    const chatPage = document.getElementById('page-chat');
    const mask = document.getElementById('tc-mask');
    if (document.hidden || !chatPage || chatPage.hidden || !window.openTCPanel ||
        (mask && !mask.hidden) || playing || watchStartedAt || inviteForced) return false;
    let declinedAt = 0;
    try { declinedAt = Number(window.activeStore().get(INVITE_COOLDOWN_KEY)) || 0; } catch (e) {}
    if (Date.now() - declinedAt < INVITE_COOLDOWN_MS) return false;
    const chance = inviteSetting('inviteProb');
    if (Math.random() * 100 >= chance) return false;
    const card = window.taInvitePickKind ? window.taInvitePickKind('movie') : null;
    if (!card || !String(card.text || '').trim()) return false;
    const cid = window.__activeCid || 'default';
    const name = partnerName();
    const inviteLine = name + '对你发送了看电影邀请~';
    window.openTCPanel('看电影',
      '<div class="sm-req"><div class="sm-req-hint" id="movie-invite-line"></div>' +
      '<div class="sm-req-detail" id="movie-invite-detail"></div></div>' +
      '<div class="mail-actions"><button class="cc-tool" id="movie-invite-later" type="button">下次再说</button>' +
      '<button class="cc-tool" id="movie-invite-accept" type="button">同意</button></div>');
    document.getElementById('movie-invite-line').textContent = name + '对你发送了看电影邀请~';
    document.getElementById('movie-invite-detail').textContent = String(card.text).trim();
    try { if (window.chatAddIn) window.chatAddIn(inviteLine, { special: 'poke', initiative: true, silent: true }); } catch (e) {}
    const close = () => { const panel = document.getElementById('tc-mask'); if (panel) panel.hidden = true; };
    document.getElementById('movie-invite-later').addEventListener('click', () => {
      close();
      if ((window.__activeCid || 'default') !== cid) return;
      try { window.activeStore().set(INVITE_COOLDOWN_KEY, String(Date.now())); } catch (e) {}
      movieSay('你对 ' + name + ' 的看电影邀请说了下次再说');
      if (window.chatInviteDecline) window.chatInviteDecline('movie');
    });
    document.getElementById('movie-invite-accept').addEventListener('click', () => {
      close();
      if ((window.__activeCid || 'default') !== cid) return;
      window.movieInviteAcceptedFor(cid);
      movieSay('你同意了 ' + name + ' 的看电影邀请');
      app.click();
      hallTab.click();
    });
    return true;
  };
  function bubbleColor(name) {
    const config = BUBBLE_STYLE[name];
    let color = null;
    try { color = window.activeStore().get(config.key); } catch (e) {}
    return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : config.defaultValue;
  }
  function bubbleOpacity() {
    let raw = null;
    try { raw = window.activeStore().get(BUBBLE_OPACITY_KEY); } catch (e) {}
    if (raw === null || raw === '') return 100;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 100;
  }
  function applyBubbleStyle() {
    const opacity = bubbleOpacity() / 100;
    Object.keys(BUBBLE_STYLE).forEach(name => {
      const hex = bubbleColor(name);
      const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      const side = name === 'inBg' ? 'in' : 'out';
      const surface = rgb.map(channel => Math.round(channel * opacity + 5 * (1 - opacity)));
      const lightness = (surface[0] * 299 + surface[1] * 587 + surface[2] * 114) / 1000;
      page.style.setProperty('--movie-' + side + '-bg', 'rgba(' + rgb.join(',') + ',' + opacity + ')');
      page.style.setProperty('--movie-' + side + '-ink', lightness >= 145 ? '#111111' : '#ffffff');
    });
  }
  function stopCommentChecks() {
    if (commentTimer) clearTimeout(commentTimer);
    commentTimer = null;
  }
  function clearConversation() {
    movieSession++;
    stopCommentChecks();
    replyTimers.forEach(id => clearTimeout(id));
    replyTimers.clear();
    previousComment = '';
    commentInner.replaceChildren();
    comment.hidden = true;
    commentInput.value = '';
    composer.hidden = true;
  }
  function appendComment(side, text) {
    const row = document.createElement('div');
    row.className = 'msg ' + (side === 'out' ? 'msg-out' : 'msg-in') + ' msg-enter';
    const details = document.createElement('div');
    details.className = 'msg-side';
    const avatar = document.createElement('div');
    avatar.className = 'msg-av';
    const stamp = document.createElement('span');
    stamp.className = 'msg-time';
    stamp.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    details.append(avatar, stamp);
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;
    if (side === 'out') row.append(bubble, details);
    else row.append(details, bubble);
    commentInner.appendChild(row);
    if (window.fillAvatar) window.fillAvatar(avatar, side === 'out' ? 'cs-avatar-user' : 'cs-avatar-partner');
    comment.hidden = false;
    requestAnimationFrame(() => { comment.scrollTop = comment.scrollHeight; });
  }
  function pickReplyCard() {
    let pool = [];
    try { pool = window.getLibPool ? window.getLibPool('movie', 'TA 回应观影评论', []) : []; } catch (e) {}
    const cards = Array.isArray(pool) ? pool.filter(s => typeof s === 'string' && s.trim()) : [];
    if (!cards.length) return '';
    const others = cards.filter(s => s !== previousComment);
    const available = others.length ? others : cards;
    return available[Math.floor(Math.random() * available.length)];
  }
  function pickComment() {
    let chat = [];
    try {
      const pool = window.getPool && window.getPool();
      if (pool && Array.isArray(pool.text)) chat = pool.text.filter(s =>
        window.ccTextCardOnly ? window.ccTextCardOnly(s) : typeof s === 'string' && s.trim());
    } catch (e) {}
    let movie = [];
    try { movie = window.getLibPool ? window.getLibPool('movie', 'TA 陪看评论', []) : []; } catch (e) {}
    const useChat = Math.random() * 100 < settingValue('chatShare');
    let pool = useChat ? chat : movie;
    if (!pool.length) pool = useChat ? movie : chat;
    const others = pool.filter(s => s !== previousComment);
    const available = others.length ? others : pool;
    return available.length ? available[Math.floor(Math.random() * available.length)] : '';
  }
  function tryComment() {
    if (!playing || !companionActive || document.hidden) return;
    if (commentTimer) clearTimeout(commentTimer);
    commentTimer = null;
    const chance = settingValue('prob');
    if (!chance) { stopCommentChecks(); return; }
    if (Math.random() * 100 < chance) {
      const line = pickComment();
      if (line) {
        previousComment = line;
        const session = movieSession;
        const delay = 30 + Math.floor(Math.random() * 131);
        commentTimer = setTimeout(function () {
          commentTimer = null;
          if (!playing || !companionActive || document.hidden || session !== movieSession) return;
          appendComment('in', window.taFit ? window.taFit(line) : line);
          tryComment();
        }, delay * 1000);
        return;
      }
    }
    commentTimer = setTimeout(tryComment, settingValue('retry') * 60000);
  }
  function openSettings() {
    if (!window.openTCPanel) return;
    const rowHtml = (name, config, group = 'comment') =>
      '<div class="gs-row"><span>' + config.label + '</span><div class="stepper" id="movie-' + group + '-' + name + '-step" data-min="' + config.min + '" data-max="' + config.max + '" data-step="' + (config.step || 1) + '">' +
      '<button class="stp-min" type="button">−</button><input class="stp-val" id="movie-' + group + '-' + name + '-val" type="number" min="' + config.min + '" max="' + config.max + '" step="' + (config.step || 1) + '" inputmode="decimal"><button class="stp-max" type="button">+</button></div></div>';
    const bubbleRowHtml = name => '<div class="gs-row"><span>' + BUBBLE_STYLE[name].label + '</span>' +
      '<button class="movie-color-choice" id="movie-color-' + name + '" type="button"><i></i><span></span></button></div>';
    window.openTCPanel('看电影设置',
      '<div class="gs-title">看电影邀请与陪看</div>' +
      Object.entries(INVITE_SETTINGS).map(([name, config]) => rowHtml(name, config, 'invite')).join('') +
      '<div class="sm-set-hint">邀请概率可直接输入 0.1～100，或按 0.1% 调整。</div>' +
      '<div class="sm-set-hint">TA 回复聊天约 2 秒后判断邀请；你点“下次再说”后，12 小时内不会再收到 TA 的看电影邀请。自行播放时只在本次观影首次播放时判断是否陪看；接受邀请后必定陪看。只有显示“TA在一起看电影”时，TA 才会发评论或回复你的评论。</div>' +
      '<div class="gs-title">观影评论</div>' +
      Object.entries(COMMENT_SETTINGS).map(([name, config]) => rowHtml(name, config)).join('') +
      '<div class="sm-set-hint">播放后立即判断；命中后随机等待 30～160 秒显示评论，未命中按设置间隔重试。评论气泡保留至结束播放。电影字卡占比自动补足至 100%；你发送评论后的 TA 回复单独按概率判断。</div>' +
      '<div class="gs-title">观影气泡外观</div>' +
      bubbleRowHtml('inBg') + bubbleRowHtml('outBg') +
      '<div class="gs-row"><span>气泡底色不透明度</span><button class="movie-color-choice" id="movie-color-opacity" type="button"><span></span></button></div>' +
      '<div class="sm-set-hint">0% 全透明，100% 不透明；只改变气泡底色，文字保持清晰。这里的设置只作用于看电影。</div>' +
      '<div class="mail-actions"><button class="cc-tool" id="movie-settings-close" type="button">关闭</button></div>');
    Object.keys(BUBBLE_STYLE).forEach(name => {
      const el = document.getElementById('movie-color-' + name);
      if (!el) return;
      const update = () => {
        const color = bubbleColor(name);
        el.querySelector('i').style.background = color;
        el.querySelector('span').textContent = color;
      };
      update();
      el.addEventListener('click', () => {
        if (!window.openModal) return;
        const cid = window.activePrefix();
        window.openModal(BUBBLE_STYLE[name].label, '', value => {
          if (window.activePrefix() !== cid) return;
          const color = typeof value === 'number' && BUBBLE_COLORS[value] ? BUBBLE_COLORS[value].color : value;
          if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) return;
          window.activeStore().set(BUBBLE_STYLE[name].key, color.toLowerCase());
          applyBubbleStyle();
          update();
        }, { colorPicker: true, color: bubbleColor(name), swatches: BUBBLE_COLORS });
      });
    });
    const opacityButton = document.getElementById('movie-color-opacity');
    if (opacityButton) {
      const update = () => { opacityButton.querySelector('span').textContent = bubbleOpacity() + '%'; };
      update();
      opacityButton.addEventListener('click', () => {
        if (!window.openModal) return;
        const cid = window.activePrefix();
        window.openModal('观影气泡透明度', '', value => {
          if (window.activePrefix() !== cid) return;
          const n = Number(value);
          if (!Number.isFinite(n)) return;
          window.activeStore().set(BUBBLE_OPACITY_KEY, String(Math.max(0, Math.min(100, Math.round(n)))));
          applyBubbleStyle();
          update();
        }, {
          noInput: true,
          slider: { min: 0, max: 100, step: 1, value: bubbleOpacity(), unit: '%', label: '0% 全透明 · 100% 不透明；确认后生效' },
          pills: [{ label: '恢复默认', value: 100 }]
        });
      });
    }
    Object.keys(INVITE_SETTINGS).forEach(name => {
      const config = INVITE_SETTINGS[name];
      const value = document.getElementById('movie-invite-' + name + '-val');
      const row = document.getElementById('movie-invite-' + name + '-step');
      if (!value || !row) return;
      value.value = String(inviteSetting(name));
      const commit = raw => { value.value = String(saveInviteSetting(name, raw)); };
      row.querySelector('.stp-min').addEventListener('click', () => commit(Number(value.value) - config.step));
      row.querySelector('.stp-max').addEventListener('click', () => commit(Number(value.value) + config.step));
      value.addEventListener('change', () => commit(value.value));
    });
    Object.keys(COMMENT_SETTINGS).forEach(name => {
      const value = document.getElementById('movie-comment-' + name + '-val');
      const row = document.getElementById('movie-comment-' + name + '-step');
      if (!value || !row) return;
      value.value = String(settingValue(name));
      const commit = raw => {
        value.value = String(saveSetting(name, raw));
        if (name === 'prob' || name === 'retry' || name === 'chatShare') {
          stopCommentChecks();
          if (playing) tryComment();
        }
      };
      row.querySelector('.stp-min').addEventListener('click', () => commit(Number(value.value) - 1));
      row.querySelector('.stp-max').addEventListener('click', () => commit(Number(value.value) + 1));
      value.addEventListener('change', () => commit(value.value));
    });
    document.getElementById('movie-settings-close').addEventListener('click', () => {
      document.getElementById('tc-mask').hidden = true;
    });
  }

  function historyLoad() {
    try {
      const store = window.activeStore();
      const data = JSON.parse(store.get(HISTORY_KEY) || '[]');
      if (!Array.isArray(data)) return [];
      let changed = false;
      data.forEach(record => {
        if (record && Object.prototype.hasOwnProperty.call(record, 'sourceDurationSec')) {
          delete record.sourceDurationSec;
          changed = true;
        }
      });
      if (changed) { try { store.set(HISTORY_KEY, JSON.stringify(data)); } catch (e) {} }
      return data;
    } catch (e) { return []; }
  }
  function historyAdd(record) {
    try {
      const store = window.activeStore();
      const list = historyLoad();
      list.unshift(record);
      store.set(HISTORY_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      if (window.toast) window.toast('观影记录暂时无法保存');
      return false;
    }
  }
  function renderLibrary() {
    libraryList.replaceChildren();
    const records = historyLoad().filter(record => record && record.id)
      .sort((a, b) => Number(b.stoppedAt || 0) - Number(a.stoppedAt || 0));
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'movie-empty';
      empty.textContent = '还没有观影记录';
      libraryList.appendChild(empty);
      return;
    }
    records.forEach(record => {
      const entry = document.createElement('article');
      entry.className = 'movie-entry';
      entry.dataset.recordId = String(record.id);
      const name = document.createElement('div');
      name.className = 'movie-entry-title';
      name.textContent = String(record.title || '未命名影片');
      const meta = document.createElement('div');
      meta.className = 'movie-entry-meta';
      const date = document.createElement('span');
      const when = new Date(Number(record.stoppedAt || record.startedAt));
      date.textContent = '日期：' + (Number.isNaN(when.getTime()) ? '—' : when.toLocaleString('zh-CN'));
      const watched = document.createElement('span');
      watched.textContent = '观看时长：' + timeText(Math.max(0, Number(record.watchedMs || 0)) / 1000);
      meta.append(date, watched);
      entry.append(name, meta);
      const review = window.mailMovieReviewFor ? window.mailMovieReviewFor(record.id) : '';
      if (review) {
        const details = document.createElement('details');
        details.className = 'movie-entry-review';
        const summary = document.createElement('summary');
        summary.textContent = '观后感 · 点击查看';
        const body = document.createElement('div');
        body.className = 'movie-entry-review-text';
        body.textContent = review;
        details.append(summary, body);
        entry.appendChild(details);
      } else {
        const none = document.createElement('div');
        none.className = 'movie-entry-review';
        none.textContent = '观后感：无';
        entry.appendChild(none);
      }
      libraryList.appendChild(entry);
    });
  }
  function showView(next) {
    view = next;
    choice.hidden = next !== 'menu';
    player.hidden = next !== 'hall';
    library.hidden = next !== 'library';
    hallTab.classList.toggle('sel', next === 'hall');
    libraryTab.classList.toggle('sel', next === 'library');
    hallTab.setAttribute('aria-selected', next === 'hall' ? 'true' : 'false');
    libraryTab.setAttribute('aria-selected', next === 'library' ? 'true' : 'false');
    renderFloat();
    if (next === 'library') renderLibrary();
  }
  function fullscreenActive() {
    return phone.classList.contains('movie-shell-fullscreen') || document.fullscreenElement === player;
  }
  function leaveFullscreen() {
    phone.classList.remove('movie-shell-fullscreen');
    page.classList.remove('movie-page-fullscreen');
    fullscreen.textContent = '⛶';
    fullscreen.setAttribute('aria-label', '全屏播放');
    fullscreen.title = '全屏播放';
    if (document.fullscreenElement === player && document.exitFullscreen) {
      try { return document.exitFullscreen().catch(() => {}); } catch (e) {}
    }
    return Promise.resolve();
  }
  function enterFullscreen() {
    phone.classList.add('movie-shell-fullscreen');
    page.classList.add('movie-page-fullscreen');
    fullscreen.textContent = '×';
    fullscreen.setAttribute('aria-label', '退出全屏');
    fullscreen.title = '退出全屏';
    if (player.requestFullscreen) {
      try { player.requestFullscreen().catch(() => {}); } catch (e) {}
    }
  }

  function parseShare(text) {
    const raw = String(text || '').trim();
    const match = raw.match(/https?:\/\/[^\s<>"“”]+/i);
    if (!match) return null;
    let url;
    try { url = new URL(match[0].replace(/[，。！？,;；）)】\]]+$/, '')); } catch (e) { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    let name = '';
    const quoted = raw.match(/《([^》]{1,80})》/);
    if (quoted) name = quoted[1].trim();
    if (!name) {
      for (const key of ['title', 'video_title', 'videoTitle', 'name', 'share_title', 'desc']) {
        const value = url.searchParams.get(key);
        if (value && value.trim()) { name = value.trim(); break; }
      }
    }
    if (!name) {
      let last = url.pathname.split('/').filter(Boolean).pop() || '';
      try { last = decodeURIComponent(last); } catch (e) {}
      const slug = last.replace(/\.(mp4|mov|m4v|webm|html?)$/i, '').replace(/[-_]+/g, ' ').trim();
      if (slug && /[\u4e00-\u9fff]|\s/.test(slug) && slug.length <= 80) name = slug;
    }
    return { url: url.href, name: name.slice(0, 80) };
  }

  // 安卓桥接只返回片名和秒数；解析器不会把视频地址交给模拟播放器。
  window.ciciVideoInfoResponse = function (token, raw) {
    const pending = nativeVideoPending.get(String(token));
    if (!pending) return;
    nativeVideoPending.delete(String(token));
    clearTimeout(pending.timer);
    try { pending.resolve(JSON.parse(raw)); } catch (e) { pending.resolve(null); }
  };
  function lookupVideoInfo(url) {
    if (!window.CiCiVideoInfo || typeof window.CiCiVideoInfo.resolve !== 'function') return Promise.resolve(null);
    return new Promise(resolve => {
      const token = String(++nativeVideoSerial);
      const timer = setTimeout(() => { nativeVideoPending.delete(token); resolve(null); }, 20000);
      nativeVideoPending.set(token, { resolve, timer });
      try { window.CiCiVideoInfo.resolve(token, url); }
      catch (e) { clearTimeout(timer); nativeVideoPending.delete(token); resolve(null); }
    });
  }

  function askManualTitle() {
    if (!pendingTitleUrl || !window.openModal) return;
    const ctl = window.openModal('手动输入片名', '', function (value) {
      const name = String(value || '').trim().slice(0, 80);
      if (!name) { ctl.stay(); ctl.hint('请输入片名后再继续'); return; }
      pendingTitleUrl = '';
      imported = true;
      title.textContent = name;
      render();
    }, { placeholder: '输入这部电影或视频的名称', staticText: '分享链接没有提供可识别的片名，请补充名称。' });
    ctl.okText('继续');
  }

  function askShareLink() {
    if (imported || !window.openModal) return;
    if (pendingTitleUrl) { askManualTitle(); return; }
    const ctl = window.openModal('输入分享链接', '', function (value) {
      const info = parseShare(value);
      if (!info) {
        ctl.stay();
        ctl.hint('请粘贴有效的视频分享链接（http 或 https）');
        return;
      }
      const requestSerial = ++shareRequestSerial;
      const cid = window.__activeCid || 'default';
      seconds = 0;
      progress.max = '900';
      sourceDurationSec = 0;
      pendingTitleUrl = info.url;
      if (info.name) {
        imported = true;
        title.textContent = info.name;
      }
      render();
      if (!window.CiCiVideoInfo || typeof window.CiCiVideoInfo.resolve !== 'function') {
        if (!info.name) setTimeout(askManualTitle, 0);
        else pendingTitleUrl = '';
        return;
      }
      if (!info.name && window.toast) window.toast('正在识别视频名称和时长…');
      lookupVideoInfo(info.url).then(metadata => {
        if (requestSerial !== shareRequestSerial || (window.__activeCid || 'default') !== cid) return;
        const parsedTitle = metadata && typeof metadata.title === 'string' ? metadata.title.trim().slice(0, 80) : '';
        const duration = metadata ? Number(metadata.durationSec) : 0;
        sourceDurationSec = Number.isFinite(duration) && duration > 0 ? Math.min(duration, 604800) : 0;
        if (sourceDurationSec > 0 && playing && seconds + (performance.now() - startedAt) / 1000 >= sourceDurationSec) pause();
        if (sourceDurationSec > 0) seconds = Math.min(seconds, sourceDurationSec);
        if (parsedTitle || info.name) {
          imported = true;
          pendingTitleUrl = '';
          title.textContent = parsedTitle || info.name;
          render();
        } else if (!page.hidden && view === 'hall') {
          setTimeout(askManualTitle, 0);
        }
      });
    }, {
      placeholder: '粘贴视频分享链接或包含链接的分享文案'
    });
    ctl.okText('导入');
  }

  function timeText(value) {
    const n = Math.floor(Math.max(0, value));
    const h = Math.floor(n / 3600);
    const m = Math.floor(n % 3600 / 60);
    const s = n % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
      : String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function render() {
    if (sourceDurationSec > 0) seconds = Math.min(seconds, sourceDurationSec);
    elapsed.textContent = timeText(seconds);
    durationLabel.hidden = !(sourceDurationSec > 0);
    durationLabel.textContent = sourceDurationSec > 0 ? '片长 ' + timeText(sourceDurationSec) : '';
    growProgress(seconds);
    progress.value = String(Math.floor(seconds));
    progress.disabled = !imported;
    button.disabled = !imported;
    stop.disabled = !imported;
    writeButton.disabled = !imported || !watchStartedAt;
    title.hidden = !imported;
    companion.hidden = !imported || !companionActive;
    button.textContent = playing ? 'Ⅱ' : '▶';
    button.setAttribute('aria-label', playing ? '暂停' : '播放');
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
    renderFloat();
  }
  function renderFloat(current = seconds) {
    floatBox.hidden = !playing || (!page.hidden && view === 'hall');
    floatTitle.textContent = title.textContent || '看电影';
    floatTime.textContent = timeText(current);
    floatProgress.style.width = Math.min(100, current / Math.max(1, Number(progress.max)) * 100) + '%';
    floatToggle.textContent = playing ? 'Ⅱ' : '▶';
    floatToggle.setAttribute('aria-label', playing ? '暂停' : '播放');
  }
  function growProgress(value) {
    if (sourceDurationSec > 0) {
      progress.max = String(Math.ceil(sourceDurationSec));
      return;
    }
    // Without source duration, keep the existing movable seek window.
    const needed = Math.max(900, Math.ceil((Math.max(0, value) + 300) / 900) * 900);
    if (Number(progress.max) < needed) progress.max = String(needed);
  }
  function pause() {
    if (!playing) { stopCommentChecks(); return; }
    seconds += (performance.now() - startedAt) / 1000;
    if (sourceDurationSec > 0) seconds = Math.min(seconds, sourceDurationSec);
    playing = false;
    clearInterval(timer);
    timer = null;
    stopCommentChecks();
    render();
  }
  function tick() {
    if (!playing) return;
    const current = seconds + (performance.now() - startedAt) / 1000;
    if (sourceDurationSec > 0 && current >= sourceDurationSec) { pause(); return; }
    growProgress(current);
    elapsed.textContent = timeText(current);
    progress.value = String(Math.floor(current));
    renderFloat(current);
  }
  button.addEventListener('click', function () {
    if (!imported) return;
    if (playing) { pause(); return; }
    if (sourceDurationSec > 0 && seconds >= sourceDurationSec) seconds = 0;
    if (!watchStartedAt) watchStartedAt = Date.now();
    if (!companionChosen) {
      companionChosen = true;
      companionActive = inviteForced || Math.random() * 100 < inviteSetting('companionProb');
    }
    startedAt = performance.now();
    playing = true;
    timer = setInterval(tick, 250);
    render();
    tryComment();
  });
  floatToggle.addEventListener('click', function () { button.click(); });
  floatReturn.addEventListener('click', function () {
    document.querySelectorAll('.page').forEach(p => { p.hidden = true; });
    page.hidden = false;
    showView('hall');
    render();
  });
  let floatDrag = null;
  floatBox.addEventListener('pointerdown', function (event) {
    if (event.target.closest('button')) return;
    const rect = floatBox.getBoundingClientRect();
    floatDrag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    floatBox.classList.add('dragging');
    floatBox.setPointerCapture(event.pointerId);
  });
  floatBox.addEventListener('pointermove', function (event) {
    if (!floatDrag || floatDrag.id !== event.pointerId) return;
    const bounds = phone.getBoundingClientRect();
    const maxLeft = Math.max(bounds.left, bounds.right - floatBox.offsetWidth);
    const maxTop = Math.max(bounds.top, bounds.bottom - floatBox.offsetHeight);
    floatBox.style.left = Math.round(Math.max(bounds.left, Math.min(maxLeft, event.clientX - floatDrag.dx))) + 'px';
    floatBox.style.top = Math.round(Math.max(bounds.top, Math.min(maxTop, event.clientY - floatDrag.dy))) + 'px';
  });
  function endFloatDrag(event) {
    if (!floatDrag || floatDrag.id !== event.pointerId) return;
    floatDrag = null;
    floatBox.classList.remove('dragging');
  }
  floatBox.addEventListener('pointerup', endFloatDrag);
  floatBox.addEventListener('pointercancel', endFloatDrag);
  writeButton.addEventListener('click', function () {
    if (writeButton.disabled) return;
    composer.hidden = !composer.hidden;
    if (!composer.hidden) commentInput.focus();
  });
  function sendMyComment() {
    if (!watchStartedAt || !imported) return;
    const line = commentInput.value.trim();
    if (!line) return;
    appendComment('out', line);
    commentInput.value = '';
    commentSend.disabled = true;
    composer.hidden = true;
    if (!companionActive || Math.random() * 100 >= settingValue('replyProb')) return;
    const session = movieSession;
    const delay = 1500 + Math.floor(Math.random() * 1501);
    const id = setTimeout(function () {
      replyTimers.delete(id);
      if (movieSession !== session || !watchStartedAt || !companionActive) return;
      const reply = pickReplyCard();
      if (reply) {
        previousComment = reply;
        appendComment('in', window.taFit ? window.taFit(reply) : reply);
      }
    }, delay);
    replyTimers.add(id);
  }
  commentSend.disabled = true;
  commentInput.addEventListener('input', () => { commentSend.disabled = !commentInput.value.trim(); });
  commentSend.addEventListener('click', sendMyComment);
  commentInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMyComment();
    }
  });
  progress.addEventListener('input', function () {
    if (!imported) return;
    const next = Number(progress.value);
    seconds = Number.isFinite(next) ? Math.max(0, sourceDurationSec > 0 ? Math.min(next, sourceDurationSec) : next) : 0;
    growProgress(seconds);
    if (playing) startedAt = performance.now();
    render();
  });
  function askStop(stopPressedAt) {
    const ctl = window.openModal('是否结束播放？', '', function () {
      const movieTitle = title.textContent;
      const movieCid = window.__activeCid || 'default';
      const stoppedAt = stopPressedAt;
      const movieRecordId = watchStartedAt
        ? 'movie_' + stoppedAt + '_' + (++recordSerial)
        : '';
      if (movieRecordId) {
        const saved = historyAdd({
          id: movieRecordId, title: movieTitle,
          startedAt: watchStartedAt, stoppedAt: stoppedAt,
          watchedMs: Math.max(0, stoppedAt - watchStartedAt)
        });
        if (!saved) watchStartedAt = 0;
      }
      watchStartedAt = 0;
      pause();
      clearConversation();
      inviteForced = false;
      companionChosen = false;
      companionActive = false;
      try { window.activeStore().remove(INVITE_ACCEPTED_KEY); } catch (e) {}
      seconds = 0;
      progress.max = '900';
      render();
      // One independent draw when the viewer confirms the ending.
      if (Math.random() < 0.35 && window.triggerMovieAsk) window.triggerMovieAsk();
      if (page.hidden) return;
      setTimeout(function () {
        if (page.hidden || (window.__activeCid || 'default') !== movieCid) return;
        const inviteCtl = window.openModal('刚才的电影怎么样，邀请TA来评论一下吧~', '', function () {
          if ((window.__activeCid || 'default') !== movieCid) return;
          if (!window.mailScheduleMovieReview || !window.mailScheduleMovieReview(movieTitle, movieRecordId)) {
            inviteCtl.stay();
            inviteCtl.hint('邀请暂时没能保存，请稍后再试');
            return;
          }
          let tip = document.getElementById('cc-toast');
          if (!tip) { tip = document.createElement('div'); tip.id = 'cc-toast'; document.body.appendChild(tip); }
          tip.textContent = '已邀请TA，观后感会在1～12小时内寄来';
          tip.className = 'cc-toast'; void tip.offsetWidth; tip.className = 'cc-toast show';
          clearTimeout(tip._timer); tip._timer = setTimeout(() => { tip.className = 'cc-toast'; }, 2500);
        }, {
          noInput: true, cancelText: '下次再说',
          onCancel: function () {
            if ((window.__activeCid || 'default') !== movieCid) return;
            if (Math.random() < 0.35 && window.mailScheduleMovieReview) window.mailScheduleMovieReview(movieTitle, movieRecordId);
          }
        });
        inviteCtl.okText('去邀请TA');
      }, 0);
    }, { noInput: true, cancelText: '否' });
    ctl.okText('是');
  }
  stop.addEventListener('click', function () {
    if (!imported || !window.openModal) return;
    const stopPressedAt = Date.now();
    if (fullscreenActive()) { leaveFullscreen().then(() => askStop(stopPressedAt)); return; }
    askStop(stopPressedAt);
  });
  app.addEventListener('click', function () {
    if (Array.from(document.querySelectorAll('.app-grid')).some(g => g.classList.contains('editing'))) return;
    document.querySelectorAll('.page').forEach(p => { p.hidden = true; });
    page.hidden = false;
    showView('menu');
    applyBubbleStyle();
    render();
  });
  settingsBtn.addEventListener('click', openSettings);
  hallTab.addEventListener('click', function () {
    if (fullscreenActive()) leaveFullscreen();
    showView('hall');
    askShareLink();
  });
  libraryTab.addEventListener('click', function () {
    if (fullscreenActive()) leaveFullscreen();
    showView('library');
  });
  fullscreen.addEventListener('click', function () {
    if (fullscreenActive()) leaveFullscreen();
    else enterFullscreen();
  });
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && phone.classList.contains('movie-shell-fullscreen')) leaveFullscreen();
  });
  back.addEventListener('click', function () {
    if (fullscreenActive()) { leaveFullscreen(); return; }
    if (view !== 'menu') { showView('menu'); return; }
    document.querySelectorAll('.page').forEach(p => { p.hidden = true; });
    const home = document.getElementById('page-phone');
    if (home) home.hidden = false;
    renderFloat();
  });
  new MutationObserver(function () { if (page.hidden && fullscreenActive()) leaveFullscreen(); renderFloat(); }).observe(page, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('contact-switched', function () { pause(); clearConversation(); watchStartedAt = 0; applyBubbleStyle(); render(); });
  applyBubbleStyle();
  document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); });
  document.addEventListener('movie-review-arrived', function () { if (!page.hidden && view === 'library') renderLibrary(); });
  document.addEventListener('mochi-restore-done', function () { if (!page.hidden && view === 'library') renderLibrary(); });
  document.addEventListener('contact-switched', function () {
    if (fullscreenActive()) leaveFullscreen();
    pause();
    imported = false;
    shareRequestSerial++;
    pendingTitleUrl = '';
    title.textContent = '';
    seconds = 0;
    sourceDurationSec = 0;
    progress.max = '900';
    watchStartedAt = 0;
    showView('menu');
    restoreCompanionInvite();
  });
  showView('menu');
  restoreCompanionInvite();

  // 第三页组件可能在桌面布局重建时暂存到隐藏池，恢复其原有位置。
  function ensureP3() {
    const box = document.getElementById('desktop-pages');
    const p3 = document.querySelector('[data-desk-widget="p3apps"]');
    if (!box || !p3) return;
    if (p3.closest && p3.closest('.page-slide') && !p3.closest('#desk-widget-pool')) return;
    try {
      const s = window.activeStore();
      const n = parseInt(s.get('desk-page-count'), 10);
      if (isNaN(n) || n < 3) s.set('desk-page-count', '3');
    } catch (e) {}
    const slides = box.querySelectorAll('.page-slide');
    let third;
    if (slides.length >= 3) third = slides[2];
    else {
      third = document.createElement('div');
      third.className = 'page-slide desk-page third';
      third.setAttribute('data-desk', '2');
      box.appendChild(third);
    }
    const hint = third.querySelector('.desk-page-hint');
    const addBtn = third.querySelector('.desk-page-add');
    if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    if (addBtn && addBtn.parentNode) addBtn.parentNode.removeChild(addBtn);
    third.appendChild(p3);
    if (window.deskRebuild) window.deskRebuild();
  }
  window.ensureP3 = ensureP3;
  document.addEventListener('contact-switched', function () { setTimeout(ensureP3, 200); });
  if (window.__mochiDataReady) ensureP3();
  else document.addEventListener('mochi-restore-done', function ready() {
    document.removeEventListener('mochi-restore-done', ready);
    ensureP3();
  });
})();
