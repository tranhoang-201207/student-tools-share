
// ==UserScript==
// @name         Facebook V5 - Dang bai + Quet link V3.1
// @namespace    https://local.facebook-v5.invalid/
// @version      3.1.0
// @description  Dang bai hang loat, quet link Facebook, chon/xoa nhanh hang doi da dang; bao toan danh sach link.
// @author       Facebook V5 - LinkFix
// @match        https://www.facebook.com/*
// @match        https://web.facebook.com/*
// @match        https://m.facebook.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// ==/UserScript==

(async () => {
  'use strict';

  if (!/(^|\.)facebook\.com$/i.test(location.hostname)) return;
  const STATUS_URL = 'https://raw.githubusercontent.com/tranhoang-201207/student-tools-share/main/status.json';
  try {
    const status = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: `${STATUS_URL}?_=${Date.now()}`, timeout: 15000,
        onload: response => {
          if (response.status < 200 || response.status >= 300)
            return reject(new Error(`HTTP ${response.status}`));
          try { resolve(JSON.parse(response.responseText)); }
          catch (_) { reject(new Error('status.json không hợp lệ')); }
        },
        ontimeout: () => reject(new Error('Request timeout')),
        onerror: () => reject(new Error('Network error'))
      });
    });
    if (status.facebookEnabled !== true) {
      console.warn(`[Facebook V5] Tool đang tắt: ${status.message || 'Không có thông báo.'}`);
      return;
    }
  } catch (error) {
    console.error('[Facebook V5] Không kiểm tra được trạng thái:', error);
    return;
  }

  // CAC KEY GIU NGUYEN: cap nhat truc tiep tu V2.4 khong xoa danh sach va anh cu.
  const APP_ID = 'fbv5-local-panel';
  const STORE_KEY = 'fbv5_queue_v1';
  const SETTINGS_KEY = 'fbv5_settings_v1';
  const DRAFT_KEY = 'fbv5_draft_v1';
  const DB_NAME = 'facebook-v5-local';
  const DB_STORE = 'images';
  const STAGE_STORE = 'staged';
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const DEFAULT_SETTINGS = {
    hashtags: '#HanhDongDepNLU #NLU #NetDepVanHoaNLU #NongLamTrongToi',
    collapsed: false,
    minDelay: 3, maxDelay: 5,
    requireImage: true, keepImages: true
  };
  const RUNNABLE = new Set(['draft', 'prepared', 'error']);
  const TAG_RE = /#[\p{L}\p{M}\p{N}_]+/gu;
  const runner = { running: false, stop: false };
  const selectedQueueIds = new Set(); // Chi chon trong hang doi, khong dong den danh sach link da quet.
  const scanner = { running: false, stop: false };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const nowIso = () => new Date().toISOString();
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const squash = x => String(x || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const tagsIn = s => [...String(s || '').matchAll(TAG_RE)].map(x => x[0].toLowerCase());

  function normalizeTags(text) {
    const seen = new Set(), out = [];
    for (const m of String(text || '').normalize('NFC').matchAll(TAG_RE)) {
      const k = m[0].toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(m[0]); }
    }
    return out.join(' ');
  }
  const readSettings = () => Object.assign({}, DEFAULT_SETTINGS, GM_getValue(SETTINGS_KEY, {}));
  const writeSettings = patch => GM_setValue(SETTINGS_KEY, Object.assign(readSettings(), patch));
  function finalCaption(content) {
    const body = String(content || '').replace(/\r\n/g, '\n').trim();
    const have = new Set(tagsIn(body));
    const extras = normalizeTags(readSettings().hashtags).split(' ').filter(t => t && !have.has(t.toLowerCase()));
    return body + (extras.length ? `${body ? '\n\n' : ''}${extras.join(' ')}` : '');
  }
  function readQueue() {
    const q = GM_getValue(STORE_KEY, []);
    return Array.isArray(q) ? q : [];
  }
  function writeQueue(q) { GM_setValue(STORE_KEY, q); renderQueue(); }
  function patchTask(id, patch) {
    const q = readQueue(), t = q.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: nowIso() });
    writeQueue(q);
    return t;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        for (const name of [DB_STORE, STAGE_STORE]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function idb(store, mode, operation) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode), req = operation(tx.objectStore(store));
      tx.oncomplete = () => { db.close(); resolve(req?.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }
  const imagePut = (id, file) => idb(DB_STORE, 'readwrite', s => s.put(file, id));
  const imageGet = id => idb(DB_STORE, 'readonly', s => s.get(id));
  const imageDelete = id => idb(DB_STORE, 'readwrite', s => s.delete(id));
  // Xoa nhieu anh trong MOT transaction IndexedDB, nhanh hon khi hang doi co 75+ bai.
  function imageDeleteBatch(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return Promise.resolve();
    return openDb().then(db => new Promise((resolve, reject) => {
      let settled = false;
      const tx = db.transaction(DB_STORE, 'readwrite');
      const fail = error => {
        if (settled) return;
        settled = true; db.close(); reject(error || new Error('Khong the xoa anh trong IndexedDB.'));
      };
      tx.oncomplete = () => { if (!settled) { settled = true; db.close(); resolve(); } };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
      try { for (const id of unique) tx.objectStore(DB_STORE).delete(id); }
      catch (error) { try { tx.abort(); } catch (_) {} fail(error); }
    }));
  }
  const stagePut = rec => idb(STAGE_STORE, 'readwrite', s => s.put(rec, rec.id));
  const stageAll = () => idb(STAGE_STORE, 'readonly', s => s.getAll());
  const stageDelete = id => idb(STAGE_STORE, 'readwrite', s => s.delete(id));
  const stageClear = () => idb(STAGE_STORE, 'readwrite', s => s.clear());
  function validateFile(f) {
    if (!(f instanceof Blob)) throw new Error('Không tìm thấy ảnh.');
    if (!IMAGE_TYPES.has(f.type)) throw new Error(`Ảnh ${f.name || ''} phải là JPG, PNG hoặc WebP.`);
    if (f.size > MAX_IMAGE_BYTES) throw new Error(`Ảnh ${f.name || ''} vượt 10 MB.`);
  }

  // Manual per-task link only. Independent scanner handles all page URLs.
  function cleanLink(raw) {
    try {
      const u = new URL(String(raw || '').trim(), 'https://www.facebook.com');
      if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return '';
      const p = u.pathname;
      const ok = /\/(?:posts\/[^/?#]+|permalink\.php|story\.php|photo\.php|photos\/[^/?#]+|reel\/[^/?#]+|videos\/[^/?#]+|share\/[pvr]\/[^/?#]+)/i.test(p) ||
        /^\/photo\/?$/i.test(p) && u.searchParams.has('fbid');
      if (!ok) return '';
      const keep = new Set(['story_fbid', 'id', 'fbid', 'set', 'v']);
      [...u.searchParams.keys()].forEach(k => { if (!keep.has(k)) u.searchParams.delete(k); });
      u.hash = ''; u.hostname='www.facebook.com'; u.protocol='https:';
      return u.href;
    } catch (_) { return ''; }
  }

  const shadow = () => document.getElementById(APP_ID)?.shadowRoot;
  function setStatus(msg, kind = '') {
    const el = shadow()?.querySelector('#status');
    if (el) { el.textContent = msg; el.className = kind; }
  }
  const textOf = el => (el?.innerText || el?.textContent || '').trim();
  function visible(el) {
    if (!el?.isConnected) return false;
    const b = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }
  const isEnabled = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const labelsOf = el => [el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.innerText, el?.textContent]
    .map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(x => x && x.length < 130);
  function findClickable(root, patterns) {
    if (!root) return null;
    const selectors = 'button,[role="button"],[role="menuitem"],[role="option"],[tabindex="0"]';
    const nodes = [...root.querySelectorAll(selectors)]
      .filter(el => visible(el) && isEnabled(el) && labelsOf(el).some(s => patterns.some(p => p.test(s))));
    // Child button uu tien hon parent, tranh bam ca container post.
    return nodes.find(el => !nodes.some(other => other !== el && el.contains(other))) || null;
  }
  function findButton(root, patterns) { return findClickable(root, patterns); }
  async function waitFor(fn, ms = 12000, step = 200, message = 'Facebook thay đổi giao diện hoặc phản hồi quá lâu.') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const result = fn();
      if (result) return result;
      await sleep(step);
    }
    throw new Error(message);
  }

  // ========= MODUL QUET LINK DOC LAP V2 (TICH HOP) =========
  const LinkScanner = (() => {
  const APP = 'fb-post-scanner-v2';
  const DATA_KEY = 'fb-post-link-scanner-v1-storage'; // giu lai danh sach V1
  const CONFIG_KEY = 'fb-post-link-scanner-v2-options';
  const DEFAULTS = { maxSteps: 150, waitMs: 1250, preferShare: true, usePhotoFallback: true, collapsed: false, autoAfterPublish: false };
  const state = { pages: {}, opts: { ...DEFAULTS }, page: '', running: false, stop: false,
    processed: new Set(), count: 0, failed: 0, scrolls: 0, captureActive: false, captured: '', panel: null, logLines: [] };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const escaped = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const line = s => String(s || '').replace(/\s+/g, ' ').trim();
  const text = el => line(el?.innerText || el?.textContent || '');
  const iso = () => new Date().toISOString();
  const $ = q => state.panel?.querySelector('#linkScanner ' + q.replace(/^#/, '#ls-'));
  const get = (k, fallback) => { try { return GM_getValue(k, fallback) ?? fallback; } catch (_) { return fallback; } };
  const put = (k, value) => { try { GM_setValue(k, value); } catch (e) { log('Khong luu duoc du lieu: ' + e.message); } };

  function identity() {
    const u = new URL(location.href);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const id = /^\/profile\.php$/i.test(path) ? u.searchParams.get('id') : '';
    return ('facebook.com' + path + (id ? '?id=' + id : '')).toLowerCase();
  }
  function records() {
    if (!Array.isArray(state.pages[state.page])) state.pages[state.page] = [];
    return state.pages[state.page];
  }
  function save() { put(DATA_KEY, state.pages); }

  // Chap nhan ONLY duong dan noi dung Facebook. Loc link tu anh, bai, share, video va reel.
  function validUrl(rawInput) {
    const raw = String(rawInput || '').replace(/&amp;/gi, '&').trim();
    const m = raw.match(/https?:\/\/[^\s<>"']+/i);
    const candidate = m ? m[0] : (raw.startsWith('/') ? raw : '');
    if (!candidate) return '';
    let u;
    try { u = new URL(candidate.replace(/[),;]+$/, ''), 'https://www.facebook.com'); } catch (_) { return ''; }
    if (u.hostname.toLowerCase() === 'l.facebook.com') return validUrl(u.searchParams.get('u') || '');
    if (u.hostname.toLowerCase() === 'fb.watch') { u.search = ''; u.hash=''; return u.href; }
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return '';
    const p = u.pathname;
    const permitted =
      /\/posts\/[^/]+/i.test(p) ||
      /\/permalink\/[^/]+/i.test(p) ||
      /^\/(?:story|permalink)\.php$/i.test(p) && u.searchParams.has('story_fbid') ||
      /^\/share\/(?:p|r|v)\/[^/]+/i.test(p) ||
      /^\/(?:reels?|videos)\/[^/]+/i.test(p) ||
      /\/videos\/[^/]+/i.test(p) ||
      /^\/watch\/?$/i.test(p) && u.searchParams.has('v') ||
      /^\/photo(?:$|\.php|\/)/i.test(p) && (u.searchParams.has('fbid') || /\/photos\//i.test(p)) ||
      /\/photos\/[^/]+/i.test(p) ||
      /^\/groups\/[^/]+\/(?:posts|permalink)\/[^/]+/i.test(p);
    if (!permitted) return '';
    const keep = new Set(['fbid', 'set', 'id', 'story_fbid', 'v']);
    [...u.searchParams.keys()].forEach(k => { if (!keep.has(k.toLowerCase())) u.searchParams.delete(k); });
    u.hostname = 'www.facebook.com'; u.protocol = 'https:'; u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.href;
  }
  function kind(link) {
    if (/\/(?:posts|permalink)\//i.test(link) || /\/(?:permalink|story)\.php/i.test(link)) return 'post';
    if (/\/share\/p\//i.test(link)) return 'post';
    if (/\/(?:videos?|reels?)\/|\/share\/[rv]\//i.test(link)) return 'video';
    if (/\/photo(?:$|\.php|\/)|\/photos\//i.test(new URL(link).pathname)) return 'photo';
    return 'post';
  }
  const rank = link => ({ post: 3, video: 2, photo: 1 })[kind(link)] || 0;
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.height > 0 && r.width > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    } catch (_) { return false; }
  }
  function label(el) {
    const arr = [el.getAttribute?.('aria-label'), el.getAttribute?.('title'),
      el.getAttribute?.('data-tooltip-content'), text(el)];
    return arr.map(line).filter(v => v && v.length < 130);
  }
  const shareRX = /^(?:chia\s*sẻ|share)(?:\s|$)|^(?:gửi cái này cho bạn bè|send this to friends)/i;
  const copyRX = /^(?:sao\s*chép\s*(?:liên\s*kết|đường\s*dẫn)|copy\s*(?:link|post\s*link|url))$/i;
  const clickable = 'button,[role="button"],[role="menuitem"],[role="listitem"],[tabindex="0"]';
  function findAction(root, re, extra = '') {
    const matches = [...root.querySelectorAll(clickable + (extra ? ',' + extra : ''))]
      .filter(isVisible).filter(el => label(el).some(x => re.test(x)))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    return matches[0] || null;
  }
  function findShare(post) {
    // Tron nhan 'Da chia se bai viet' voi nut 'Chia se' la sai.
    const buttons = [...post.querySelectorAll('button,[role="button"],[tabindex="0"]')]
      .filter(isVisible).filter(x => label(x).some(t => shareRX.test(t)))
      .sort((a,b) => a.querySelectorAll('*').length-b.querySelectorAll('*').length);
    return buttons[0] || null;
  }
  function findCopy() {
    let item = findAction(document, copyRX);
    if (item) {
      // Tinh huong Facebook dung role=listitem, nut click la the con.
      const leaf = [...item.querySelectorAll('span,div')]
        .filter(isVisible).filter(e => copyRX.test(text(e)))
        .sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
      return leaf || item;
    }
    const spans = [...document.querySelectorAll('span,div')]
      .filter(isVisible).filter(e => copyRX.test(text(e)) && text(e).length < 60)
      .sort((a,b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    return spans[0] || null;
  }
  async function waitFor(fn, timeout = 3500) {
    const until = Date.now() + timeout;
    while (Date.now() < until && !state.stop) {
      const obj = fn(); if (obj) return obj;
      await sleep(130);
    }
    return null;
  }
  function rootMain() { return document.querySelector('[role="main"]') || document.querySelector('main') || document.body; }
  function postLinks(post) {
    let best = '';
    for (const a of post.querySelectorAll('a[href]')) {
      const url = validUrl(a.href || a.getAttribute('href'));
      if (!url) continue;
      if (!best || rank(url) > rank(best)) best = url;
      if (kind(url) === 'post') break;
    }
    return best;
  }
  const commentRX = /(viết\s*bình\s*luận|write\s*a\s*comment|comment as|bình luận dưới tên)/i;
  function fromCommentEditor(editor, main) {
    let n = editor.parentElement;
    for (let depth = 0; n && depth < 21 && n !== main && n !== document.body; n = n.parentElement, depth++) {
      const countComments = [...n.querySelectorAll('[contenteditable="true"],[contenteditable=""]')]
        .filter(el => commentRX.test(el.getAttribute('aria-label') || '')).length;
      if (countComments > 1) break; // parent da gom nhieu bai viet, khong lay
      const hasMedia = !!n.querySelector('a[href*="fbid="],a[href*="/posts/"],a[href*="/videos/"],a[href*="/reel/"]');
      const s = text(n);
      if (hasMedia && (s.length > 65 || !!findShare(n))) return n;
      if (findShare(n) && s.length > 60) return n;
    }
    return null;
  }
  function identifyPosts() {
    const main = rootMain();
    if (!main) return [];
    const posts = new Set();
    // Can cu theo comment editor: Facebook trong tab nay co 'Viet binh luan...'
    for (const c of main.querySelectorAll('[contenteditable][aria-label]')) {
      if (!commentRX.test(c.getAttribute('aria-label') || '')) continue;
      const root = fromCommentEditor(c, main);
      if (root && isVisible(root)) posts.add(root);
    }
    for (const a of main.querySelectorAll('[role="article"],[data-pagelet^="FeedUnit"],[data-testid="fbfeed_story"]')) {
      if (isVisible(a) && (findShare(a) || postLinks(a))) {
        // Bo nested trong posts da nhan dien, tranh trung.
        if (![...posts].some(p => p === a || p.contains(a) || a.contains(p))) posts.add(a);
      }
    }
    // Phuong an DOM fallback: tu nut Chia se di len toi block co noi dung va link media.
    for (const b of main.querySelectorAll('button,[role="button"]')) {
      if (!isVisible(b) || !label(b).some(t => shareRX.test(t))) continue;
      if ([...posts].some(p => p.contains(b))) continue;
      let n = b.parentElement;
      for (let i = 0; i < 15 && n && n !== main; i++,n=n.parentElement) {
        if (n.querySelector('[contenteditable][aria-label*="bình luận"],a[href*="fbid="],a[href*="/posts/"]') && text(n).length > 70) {
          if (![...posts].some(p => p.contains(n) || n.contains(p))) posts.add(n);
          break;
        }
      }
    }
    // Loai parents vo tinh gom nhieu bai.
    const chosen = [...posts].filter(p => {
      const overlap = [...posts].some(other => other !== p && p.contains(other));
      return !overlap && isVisible(p);
    });
    if (chosen.length) return chosen;

    // Cuoi cung: profile dang mo co khu "Anh" truoc heading "Bai viet".
    // Neu Facebook khong phat hanh role=article hoac nut Chia se cho script,
    // chi lay anh NAM SAU heading Bai viet, tranh quet nham luoi anh profile.
    const heading = [...main.querySelectorAll('h1,h2,h3,[role="heading"],span')]
      .find(x => isVisible(x) && /^bài viết$/i.test(text(x)) && x.querySelectorAll('*').length < 4);
    if (heading) {
      for (const a of main.querySelectorAll('a[href]')) {
        if (!validUrl(a.getAttribute('href')) || kind(validUrl(a.getAttribute('href'))) !== 'photo') continue;
        if (!(heading.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (a.closest('aside,[role="complementary"]')) continue;
        if (a.parentElement && isVisible(a.parentElement)) chosen.push(a.parentElement);
      }
    }
    return chosen;
  }
  function fingerprint(post) {
    const direct = postLinks(post);
    if (direct) return direct;
    const s = text(post).slice(0, 650);
    let hash = 2166136261;
    for (let i=0; i<s.length; i++) { hash ^= s.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return 'body:'+(hash>>>0).toString(16)+':'+s.length;
  }
  function log(message, error = false) {
    const stamp = new Date().toLocaleTimeString('vi-VN');
    state.logLines.unshift(`[${stamp}] ${message}`);
    state.logLines.length = Math.min(state.logLines.length, 60);
    const el = $('#status'); if (el) { el.textContent = message; el.className = error ? 'ls-status error' : 'ls-status'; }
    const details = $('#details'); if (details) details.textContent = state.logLines.slice(0, 18).join('\n');
  }
  function store(url, method, preview) {
    const good = validUrl(url);
    if (!good) return false;
    const list = records();
    // Neu chinh xac URL giong nhau, khong them lai.
    if (list.some(x => x.url === good)) return false;
    list.push({ url: good, method, preview: line(preview).slice(0, 100), foundAt: iso() });
    save(); updateList();
    return true;
  }

  // Bat clipboard ONLY khi cong cu dang thuc hien mot lan chia se.
  function capture(raw) {
    if (!state.captureActive) return;
    const url = validUrl(raw);
    if (url) state.captured = url;
  }
  function installHooks() {
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const cp = w.Clipboard?.prototype;
      if (cp && typeof cp.writeText === 'function' && !cp.writeText.__fbscanv2) {
        const original = cp.writeText;
        const wrap = function(data) { capture(data); return Reflect.apply(original, this, arguments); };
        Object.defineProperty(wrap,'__fbscanv2',{value:true});
        cp.writeText = wrap;
      }
      const dt = w.DataTransfer?.prototype;
      if (dt && typeof dt.setData === 'function' && !dt.setData.__fbscanv2) {
        const orig = dt.setData;
        const wrap = function(type, data) { if (/^text\/plain$|^text$/i.test(String(type))) capture(data); return Reflect.apply(orig, this, arguments); };
        Object.defineProperty(wrap,'__fbscanv2',{value:true});
        dt.setData = wrap;
      }
    } catch (_) {}
  }
  installHooks();
  document.addEventListener('copy', ev => {
    if (!state.captureActive) return;
    try { capture(ev.clipboardData?.getData('text/plain')); } catch (_) {}
    try { capture(getSelection()?.toString()); } catch (_) {}
  }, true);
  async function clipRead() {
    try {
      return await Promise.race([navigator.clipboard.readText(), sleep(1000).then(()=> '')]);
    } catch (_) { return ''; }
  }
  function dismissShare() {
    try {
      const focus = document.activeElement || document;
      focus.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true }));
    } catch (_) {}
  }
  async function copyViaShare(post) {
    const share = findShare(post);
    if (!share) return '';
    const original = await clipRead();
    state.captured=''; state.captureActive=true;
    try {
      try { post.scrollIntoView({block:'center',behavior:'instant'}); } catch (_) { post.scrollIntoView(); }
      await sleep(300);
      if (state.stop) return '';
      share.click();
      const copy = await waitFor(findCopy, 4200);
      if (!copy) { log('Khong tim thay nut Sao chep lien ket trong hop Chia se.'); return ''; }
      // Doc neu menu co san URL trong cac thuoc tinh (khong phu thuoc clipboard).
      let domLink = '';
      for (const el of [copy, copy.parentElement, copy.closest('[role="listitem"]')]) {
        if (!el) continue;
        for (const attr of ['data-clipboard-text','data-url','href']) {
          domLink = validUrl(el.getAttribute(attr)); if (domLink) break;
        }
        if (domLink) break;
      }
      copy.click();
      if (domLink) return domLink;
      const end = Date.now() + 3100;
      while (Date.now() < end && !state.stop) {
        if (state.captured) return state.captured;
        const raw = await clipRead();
        const url = validUrl(raw);
        if (url && raw !== original) return url;
        await sleep(140);
      }
      return '';
    } catch (_) { return ''; }
    finally { state.captureActive=false; dismissShare(); }
  }

  async function scanPage() {
    const posts = identifyPosts();
    let added = 0;
    for (const post of posts) {
      if (state.stop || state.page !== identity()) break;
      const fp = fingerprint(post);
      if (state.processed.has(fp)) continue;
      state.processed.add(fp);
      state.count++;
      const direct = postLinks(post);
      const preview = text(post).slice(0, 100);
      // Anh chi la fallback. Neu post da co permalink chuan, khong can mo Share.
      if (direct && rank(direct) >= 2) {
        if (store(direct, 'Permalink tren trang', preview)) added++;
        continue;
      }
      let copied = '';
      if (state.opts.preferShare) copied = await copyViaShare(post);
      if (copied) {
        if (store(copied, 'Chia se > Sao chep lien ket', preview)) added++;
      } else if (direct && state.opts.usePhotoFallback) {
        if (store(direct, 'Link anh trong bai (du phong)', preview)) added++;
      } else state.failed++;
    }
    return added;
  }
  function scrollParent() {
    const d = document.scrollingElement || document.documentElement;
    if (d.scrollHeight > d.clientHeight + 120) return d;
    const main = rootMain();
    const els = [...main.querySelectorAll('div')]
      .filter(x => x.scrollHeight > x.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(x).overflowY));
    return els.sort((a,b)=>b.scrollHeight-a.scrollHeight)[0] || d;
  }
  function scInfo(node) { return { top:node.scrollTop||0, height:node.scrollHeight, client:node.clientHeight||innerHeight }; }
  async function run(automatic) {
    if (state.running) return;
    if (runner.running) { log('Đang đăng bài. Quét link sau khi hàng đợi hoàn tất.', true); return; }
    if (identity() !== state.page) switchPage();
    state.running = true; scanner.running = true; renderRunState(); state.stop=false; state.failed=0; state.count=0; state.scrolls=0; state.processed = new Set();
    buttons();
    let staticRounds=0;
    try {
      while (!state.stop && state.page === identity()) {
        log(`Quet: ${records().length} link - da xu ly ${state.count} bai - ${state.scrolls} lan cuon.`);
        const beforeCount = records().length;
        await scanPage();
        if (!automatic || state.scrolls >= state.opts.maxSteps) break;
        const sc = scrollParent(), before = scInfo(sc);
        try { sc.scrollBy({top: Math.max(300, Math.round(before.client*0.78)),behavior:'instant'}); }
        catch (_) { sc.scrollTop += Math.max(300, Math.round(before.client*0.78)); }
        state.scrolls++;
        await sleep(state.opts.waitMs);
        const after = scInfo(sc);
        const noScroll = Math.abs(after.top-before.top) < 3;
        const noGrowth = Math.abs(after.height-before.height) < 3;
        const noResults = records().length === beforeCount;
        if (noScroll && noGrowth && noResults) staticRounds++;
        else staticRounds = 0;
        if (staticRounds >= 5) break;
      }
      if (!state.stop && state.page === identity()) await scanPage();
      log(`${state.stop ? 'Da dung' : 'Quet hoan tat'}: ${records().length} link, xu ly ${state.count} bai.` +
          (state.failed ? ` ${state.failed} bai chua co link.` : '') +
          (state.scrolls >= state.opts.maxSteps ? ' Da dat gioi han luot cuon.' : ''), records().length === 0);
    } catch (e) { log('Loi: ' + (e?.message || String(e)), true); }
    finally { state.running=false; scanner.running=false; state.captureActive=false; buttons(); updateList(); renderRunState(); }
  }
  function switchPage() {
    state.stop = true;
    state.page = identity();
    if ($('#page')) $('#page').textContent=state.page;
    updateList();
  }
  function updateList() {
    if (!state.panel || !$('#list')) return;
    const rows=records();
    $('#count').textContent = `${rows.length} link`;
    const filter = line($('#filter')?.value).toLowerCase();
    $('#list').innerHTML = rows.map((r,i)=>({r,i})).filter(({r}) => !filter || (r.url + ' ' + r.method + ' ' + r.preview).toLowerCase().includes(filter)).map(({r,i})=>`<div class="entry"><span>${i+1}</span><div class="content"><a target="_blank" rel="noopener noreferrer" href="${escaped(r.url)}">${escaped(r.url)}</a><small>${escaped(r.method)} · ${escaped(r.preview)}</small></div><button title="Sao chép link" data-copy="${i}">⧉</button><button title="Xóa link này" data-remove="${i}">✕</button></div>`).join('') ||
      '<div class="empty">Chua co link. Mo trang ca nhan, sau do bam Quet.</div>';
  }
  function buttons() {
    if (!state.panel || !$('#scan')) return;
    $('#scan').hidden=state.running; $('#only').disabled=state.running; $('#stop').hidden=!state.running;
  }
  function download(filename, content, mime) {
    const a = document.createElement('a'), object = URL.createObjectURL(new Blob([content],{type:mime}));
    a.href=object;a.download=filename; document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(object),5000);
  }
  function csvCell(str) {
    let s=String(str??''); if (/^[=+\-@]/.test(s)) s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function exportData(format) {
    const rows=records(); if (!rows.length) return log('Chua co link nao de xuat.',true);
    const name='facebook-links-v2-'+iso().slice(0,10);
    if (format==='txt') download(name+'.txt', rows.map(x=>x.url).join('\r\n')+'\r\n', 'text/plain;charset=utf-8');
    else {
      const all=[['STT','Link','Loai','Ghi chu'],...rows.map((x,i)=>[i+1,x.url,x.method,x.preview])];
      download(name+'.csv','\ufeff'+all.map(row=>row.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
    }
    log('Da xuat '+rows.length+' link '+format.toUpperCase()+'.');
  }
  async function importClipboard() {
    try {
      const raw = await navigator.clipboard.readText();
      const hits = String(raw || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
      let n = 0;
      for (const hit of hits) if (store(hit, 'Facebook > Sao chep lien ket (thu cong)', '')) n++;
      log(n ? 'Da nhap ' + n + ' link tu clipboard.' : 'Clipboard khong co link Facebook moi.', !n);
    } catch (_) {
      $('#manual').hidden = false; $('#manual').focus();
      log('Chrome khong cho doc clipboard. Hay dan lien ket (Ctrl+V) vao o ben duoi.', true);
    }
  }
  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); log('Da sao chep thanh cong.'); }
    catch (_) { const ta=$('#manual');ta.hidden=false;ta.value=s;ta.focus();ta.select();log('Clipboard bi chan: nhan Ctrl+C de sao chep.',true); }
  }
  function apply() {
    state.opts.maxSteps=Math.max(1,Math.min(1000,Number($('#max').value)||150));
    state.opts.waitMs=Math.max(700,Math.min(10000,Number($('#wait').value)||1250));
    state.opts.preferShare=$('#share').checked;
    state.opts.usePhotoFallback=$('#fallback').checked;
    state.opts.autoAfterPublish=$('#auto').checked;
    put(CONFIG_KEY,state.opts);
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return log('Tệp quá 5MB. Hãy chia nhỏ.', true);
    const raw=await file.text();
    const hits=raw.match(/https?:\/\/[^\s<>"']+/gi)||[];
    let n=0;
    for (const hit of hits) if (store(hit.replace(/[",;]+$/g,''),'Nhập từ TXT/CSV','')) n++;
    log(`Đã nhập ${n} link mới từ ${file.name}.`+(hits.length>n?' Link đã có được bỏ qua.':''));
  }
  function mount() {
    const root=shadow();
    if(!root || state.mountedRoot===root || !root.querySelector('#linkScanner'))return;
    state.panel=root;state.mountedRoot=root;
    $('#page').textContent=state.page;
    $('#max').value=state.opts.maxSteps;$('#wait').value=state.opts.waitMs;
    $('#share').checked=state.opts.preferShare;$('#fallback').checked=state.opts.usePhotoFallback;
    $('#auto').checked=state.opts.autoAfterPublish;
    $('#scan').onclick=()=>{apply();run(true);};
    $('#only').onclick=()=>{apply();run(false);};
    $('#stop').onclick=()=>{state.stop=true;log('Đang dừng sau thao tác hiện tại...');};
    $('#copy').onclick=()=>copyText(records().map(x=>x.url).join('\n'));
    $('#txt').onclick=()=>exportData('txt');$('#csv').onclick=()=>exportData('csv');
    $('#clip').onclick=importClipboard;
    $('#filter').oninput=updateList;
    $('#import').onclick=()=>$('#importFile').click();
    $('#importFile').onchange=async e=>{try { await importFile(e.target.files?.[0]); } catch(err){log('Nhập file lỗi: '+err.message,true);} e.target.value='';};
    $('#add').onclick=()=>{
      const ta=$('#manual');
      if(ta.hidden){ta.hidden=false;ta.focus();log('Dán link, sau đó bấm Thêm link thủ công lần nữa.');return;}
      let n=0;for(const hit of ta.value.match(/https?:\/\/[^\s<>"']+/gi)||[]) if(store(hit,'Thêm thủ công',''))n++;
      log('Đã thêm '+n+' link hợp lệ.');
    };
    $('#clear').onclick=()=>{
      if(state.running)return log('Hãy dừng quét trước khi xóa.',true);
      if(!confirm('Xóa '+records().length+' link của trang hiện tại?'))return;
      state.pages[state.page]=[];save();updateList();log('Đã xóa link trang này.');
    };
    $('#list').onclick=e=>{
      const c=e.target.closest('button[data-copy]');
      if(c){const r=records()[Number(c.dataset.copy)];if(r)copyText(r.url);return;}
      const b=e.target.closest('button[data-remove]');
      if(b){const idx=Number(b.dataset.remove);const r=records()[idx];if(!r)return;
        records().splice(idx,1);save();updateList();log('Đã xóa một link khỏi danh sách.');}
    };
    for(const sel of ['#max','#wait','#share','#fallback','#auto']){
      $(sel).addEventListener('change',apply);
    }
    buttons();updateList();
  }
  function initialize(){
    const raw=get(DATA_KEY,{});state.pages=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
    const cfg=get(CONFIG_KEY,{});if(cfg&&typeof cfg==='object')Object.assign(state.opts,cfg);
    state.page=identity();
    let last=state.page;
    setInterval(()=>{
      mount();
      const next=identity();
      if(next!==last){last=next;switchPage();log('Đã chuyển trang; danh sách được lưu riêng cho từng trang.');}
    },1500);
  }
  initialize();
  return {mount,run,getOptions:()=>({...state.opts}),allRecords:()=>state.pages,refresh:buttons};
  })();

  // ---------- DANG BAI ----------
  const composerDialog = () => [...document.querySelectorAll('[role="dialog"]')]
    .filter(visible).reverse().find(d => d.querySelector('[contenteditable="true"]'));
  const getEditor = d => [...d.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"]')].find(visible);
  async function openComposer() {
    if (composerDialog()) return composerDialog();
    const btn = findButton(document, [/bạn đang nghĩ gì/i, /what(?:'|’)s on your mind/i, /create (?:a )?post/i, /tạo bài viết/i]);
    if (!btn) throw new Error('Không tìm thấy nút tạo bài. Mở trang cá nhân rồi thử lại.');
    btn.click();
    return waitFor(composerDialog, 12500, 250, 'Không mở được khung đăng bài.');
  }
  async function settledText(el, quiet = 450, max = 3500) {
    let old = textOf(el), stable = Date.now();
    const end = Date.now() + max;
    while (Date.now() < end) {
      await sleep(120);
      const cur = textOf(el);
      if (old !== cur) { old = cur; stable = Date.now(); }
      else if (Date.now() - stable >= quiet) break;
    }
    return old;
  }
  async function clearEditor(ed) {
    ed.focus();
    const selection = getSelection(), range = document.createRange();
    range.selectNodeContents(ed);
    selection.removeAllRanges(); selection.addRange(range);
    try { document.execCommand('delete', false); } catch (_) {}
    if (squash(await settledText(ed, 220, 650))) {
      ed.focus();
      try { document.execCommand('selectAll'); document.execCommand('delete'); } catch (_) {}
    }
    if (squash(textOf(ed))) throw new Error('Không xóa được nội dung cũ của ô soạn thảo.');
  }
  async function typeInto(ed, caption) {
    ed.focus();
    let ok = false;
    try { ok = document.execCommand('insertText', false, caption); } catch (_) {}
    if (!ok || !squash(await settledText(ed, 200, 1400))) {
      const dt = new DataTransfer(); dt.setData('text/plain', caption);
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  }
  async function setCaption(ed, caption) {
    const expected = squash(caption);
    for (let i = 0; i < 3; i++) {
      if (squash(await settledText(ed, 200, 900)) !== expected) {
        await clearEditor(ed); await typeInto(ed, caption);
      }
      if (squash(await settledText(ed, 450, 2800)) === expected) return;
    }
    throw new Error('Facebook không nhận đúng caption. Chưa đăng bài để tránh sai nội dung/hashtag.');
  }
  const fileInputs = d => [...d.querySelectorAll('input[type="file"]')].filter(x => !x.disabled);
  function hasAttachment(dialog, before = Number.POSITIVE_INFINITY) {
    return !!dialog.querySelector('img[src^="blob:"]') ||
      [...dialog.querySelectorAll('[aria-label]')].some(x => /(xóa|gỡ|remove).*(ảnh|photo|video)/i.test(x.getAttribute('aria-label') || '')) ||
      dialog.querySelectorAll('img').length > before;
  }
  async function attachImage(dialog, file, name, required) {
    if (hasAttachment(dialog)) return;
    const baseline = dialog.querySelectorAll('img').length;
    let input = fileInputs(dialog)[0];
    if (!input) {
      findButton(dialog, [/ảnh\/video/i, /photo\/video/i, /^ảnh$/i, /^photo$/i])?.click();
      input = await waitFor(() => fileInputs(dialog)[0], 9000, 250, 'Không tìm thấy ô thêm ảnh.');
    }
    const dt = new DataTransfer();
    dt.items.add(new File([file], name, { type: file.type, lastModified: file.lastModified || Date.now() }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (required) await waitFor(() => hasAttachment(dialog, baseline), 30000, 400,
      'Chưa xác minh được ảnh đã tải lên. Không đăng để tránh bài thiếu ảnh.');
    await waitFor(() => !dialog.querySelector('[role="progressbar"]'), 20000, 400).catch(() => {});
  }
  async function waitPostButton(dialog) {
    let nextClicked = false;
    return waitFor(() => {
      const p = findButton(dialog, [/^đăng$/i, /^post$/i]);
      if (p && isEnabled(p)) return p;
      if (!p && !nextClicked) {
        const n = findButton(dialog, [/^tiếp$/i, /^next$/i]);
        if (n && isEnabled(n)) { nextClicked = true; n.click(); }
      }
      return null;
    }, 60000, 450, 'Nút Đăng chưa khả dụng hoặc ảnh chưa tải xong.');
  }
  async function postOne(id, publish = true) {
    const task = readQueue().find(t => t.id === id);
    if (!task) throw new Error('Không thấy bài trong hàng đợi.');
    const file = await imageGet(id); validateFile(file);
    const caption = finalCaption(task.content);
    if (!caption) throw new Error('Nội dung bài trống.');
    setStatus('Đang mở khung bài viết…');
    const dialog = await openComposer();
    const editor = getEditor(dialog);
    if (!editor) throw new Error('Không tìm thấy ô nhập nội dung.');
    setStatus('Đang điền caption…');
    await setCaption(editor, caption);
    setStatus('Đang gắn ảnh…');
    await attachImage(dialog, file, file.name || task.imageName || 'image.jpg', readSettings().requireImage);
    await setCaption(editor, caption);
    patchTask(id, { status: 'prepared', caption, preparedAt: nowIso(), lastError: '' });
    if (!publish) { setStatus('Đã điền nội dung và ảnh, chưa bấm Đăng.', 'ok'); return; }
    const postBtn = await waitPostButton(dialog);
    patchTask(id, { status: 'posting' });
    setStatus('Đang bấm Đăng…');
    postBtn.click();
    try {
      await waitFor(() => !dialog.isConnected || !visible(dialog), 60000, 450,
        'Khung đăng không đóng.');
    } catch (_) {
      throw new Error('Đã bấm Đăng, kết quả chưa chắc chắn. Kiểm tra trang cá nhân và chọn "Đã đăng rồi" nếu bài đã lên. KHÔNG tự đăng lại.');
    }
    patchTask(id, { status: 'posted_nolink', postedAt: nowIso(), lastError: '' });
    if (!readSettings().keepImages) imageDelete(id).catch(() => {});
    setStatus('Đã đăng, đang chờ lưu link…', 'ok');
  }
  async function runTask(id, publish) {
    const t = readQueue().find(x => x.id === id);
    if (!t || !RUNNABLE.has(t.status)) throw new Error('Bài không còn ở trạng thái có thể đăng.');
    try { await postOne(id, publish); }
    catch (e) {
      const updated = readQueue().find(x => x.id === id);
      if (updated) patchTask(id, updated.status === 'posting' ? { lastError: e.message } : { status: 'error', lastError: e.message });
      throw e;
    }
  }
  async function countdown(seconds) {
    for (let s = seconds; s > 0 && !runner.stop; s--) {
      setStatus(`Nghỉ ${s}s trước khi lấy link / sang bài kế tiếp…`);
      await sleep(1000);
    }
  }
  async function runQueue() {
    if (runner.running || scanner.running) throw new Error('Đang chạy một tác vụ khác.');
    const todo = () => readQueue().filter(t => RUNNABLE.has(t.status));
    const amount = todo().length;
    if (!amount) throw new Error('Không có bài nào cần đăng.');
    const { minDelay, maxDelay } = readSettings();
    if (!confirm(`TỰ ĐỘNG ĐĂNG ${amount} bài, nghỉ ${minDelay}–${maxDelay} giây giữa các bài. Link được quét riêng, không cần ghép với bài đăng.\n\nNên mở trang cá nhân, giữ nguyên tab. Bạn đồng ý?`)) return;
    runner.running = true; runner.stop = false;
    renderRunState(); renderQueue();
    let done = 0;
    try {
      while (!runner.stop && todo().length) {
        const t = todo()[0];
        await runTask(t.id, true);
        done++;
        await countdown(Math.round(minDelay + Math.random() * (maxDelay - minDelay)));
        if (runner.stop) break;
        // Lấy link độc lập ở tab Quét link, không ghép theo nội dung.
      }
      setStatus(`${runner.stop ? 'Đã dừng' : 'Hoàn tất'}: đăng ${done} bài. Dùng khu vực Quét link để thu thập URL độc lập.`, 'ok');
    } catch (e) { setStatus(`Đã dừng sau ${done} bài: ${e.message}`, 'error'); }
    finally {
      runner.running = false; renderRunState(); renderQueue();
      if (!runner.stop && done > 0 && LinkScanner.getOptions().autoAfterPublish) {
        setStatus('Đã đăng xong. Đang khởi động quét link độc lập...', 'ok');
        await LinkScanner.run(true);
      }
    }
  }

  // ---------- ANH CHO: HO TRO TAI FILE / DAN / KEO THA / SAP XEP ----------
  let staged = [], thumbnails = [];
  const splitContents = raw => String(raw || '').split(/^\s*-{3,}\s*$/m).map(s => s.trim()).filter(Boolean);
  function updatePairInfo() {
    const info = shadow()?.querySelector('#pairInfo');
    if (!info) return;
    const c = splitContents(shadow()?.querySelector('#content')?.value).length;
    info.textContent = ` · Nội dung: ${c} · Ảnh: ${staged.length}`;
    info.className = (c || staged.length) && c !== staged.length ? 'warn' : '';
  }
  function renderStaged() {
    const root = shadow(); if (!root) return;
    thumbnails.forEach(x => URL.revokeObjectURL(x));
    thumbnails = staged.map(x => URL.createObjectURL(x.file));
    root.querySelector('#staged').innerHTML = staged.map((x, i) => `
      <div class="thumb" title="${esc(x.name)}"><img src="${thumbnails[i]}" alt=""><span class="n">${i + 1}</span>
      <div class="tb"><button data-sa="up" data-id="${esc(x.id)}">↑</button><button data-sa="down" data-id="${esc(x.id)}">↓</button><button data-sa="del" data-id="${esc(x.id)}">✕</button></div></div>`).join('');
    updatePairInfo();
  }
  async function loadStaged() {
    try { staged = (await stageAll() || []).filter(r => r?.file instanceof Blob).sort((a,b) => a.order - b.order); }
    catch (_) { staged = []; }
    renderStaged();
  }
  async function addStaged(files) {
    const imgs = [...files].filter(f => f?.type?.startsWith('image/')).sort((a,b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
    if (!imgs.length) throw new Error('Không có ảnh hợp lệ.');
    const existing = new Set(staged.map(x => `${x.name}|${x.size}|${x.lastModified}`));
    let added = 0, skipped = 0, order = staged.reduce((m,x) => Math.max(m, x.order || 0), 0);
    for (const f of imgs) {
      validateFile(f);
      let file = f;
      if (!f.name || /^image\.\w+$/i.test(f.name)) {
        const extension = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        file = new File([f], `anh-dan-${Date.now()}-${order + 1}.${extension}`, { type: f.type, lastModified: Date.now() });
      }
      const signature = `${file.name}|${file.size}|${file.lastModified}`;
      if (existing.has(signature)) { skipped++; continue; }
      const rec = { id: uid(), name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, order: ++order, file };
      await stagePut(rec); staged.push(rec); existing.add(signature); added++;
    }
    renderStaged(); setStatus(`Đã thêm ${added} ảnh.${skipped ? ` Bỏ qua ${skipped} ảnh trùng.` : ''}`, added ? 'ok' : 'error');
  }
  async function moveStaged(id, direction) {
    const i = staged.findIndex(x => x.id === id), j = i + direction;
    if (i < 0 || j < 0 || j >= staged.length) return;
    [staged[i], staged[j]] = [staged[j], staged[i]];
    [staged[i].order, staged[j].order] = [staged[j].order, staged[i].order];
    await Promise.all([stagePut(staged[i]), stagePut(staged[j])]); renderStaged();
  }
  async function pasteFromClipboard() {
    if (!navigator.clipboard?.read) throw new Error('Không thể đọc ảnh từ clipboard. Bấm vào bảng và nhấn Ctrl+V.');
    const items = await navigator.clipboard.read(), list = [];
    for (const i of items) {
      const type = i.types.find(t => t.startsWith('image/'));
      if (type) list.push(new File([await i.getType(type)], `image.${type.split('/')[1]}`, { type }));
    }
    if (!list.length) throw new Error('Clipboard không có ảnh.');
    await addStaged(list);
  }
  async function addTasks() {
    const root = shadow(), contents = splitContents(root.querySelector('#content').value);
    if (!contents.length || !staged.length) throw new Error('Hãy nhập nội dung và chọn ảnh.');
    if (contents.length !== staged.length) throw new Error(`Có ${contents.length} nội dung nhưng ${staged.length} ảnh. Mỗi bài đúng 1 ảnh; phân cách các bài bằng ---.`);
    const old = readQueue(), fresh = [];
    let skipped = 0;
    for (let i = 0; i < staged.length; i++) {
      const x = staged[i], content = contents[i];
      const signature = `${content}\u0000${x.name}\u0000${x.size}\u0000${x.lastModified}`;
      if ([...old, ...fresh].some(t => t.signature === signature)) { skipped++; continue; }
      const id = uid(); await imagePut(id, x.file);
      fresh.push({ id, content, imageName: x.name, imageSize: x.size, signature, status: 'draft', createdAt: nowIso(), permalink: '' });
    }
    writeQueue([...readQueue(), ...fresh]);
    await stageClear(); staged = []; renderStaged();
    root.querySelector('#content').value = ''; GM_setValue(DRAFT_KEY, '');
    setStatus(`Đã thêm ${fresh.length} bài.${skipped ? ` Bỏ qua ${skipped} bài trùng.` : ''}`, 'ok');
  }
  async function deleteTask(id) {
    if (runner.running || scanner.running) throw new Error('Hãy dừng đăng bài / quét link trước khi xóa hàng đợi.');
    await imageDeleteBatch([id]);
    selectedQueueIds.delete(id);
    writeQueue(readQueue().filter(t => t.id !== id));
    setStatus('Đã xóa 1 bài khỏi hàng đợi cục bộ. Bài đăng Facebook vẫn còn.', 'ok');
  }

  const isPostedTask = t => t.status === 'posted' || t.status === 'posted_nolink';
  function selectQueue(mode) {
    if (runner.running || scanner.running) return setStatus('Hãy dừng tác vụ đang chạy trước khi chọn/xóa.', 'error');
    if (mode === 'none') selectedQueueIds.clear();
    else for (const t of readQueue()) {
      if (mode === 'all' || (mode === 'posted' && isPostedTask(t))) selectedQueueIds.add(t.id);
    }
    renderQueue();
  }
  function updateQueueActions() {
    const root = shadow(); if (!root) return;
    const q = readQueue(), posted = q.filter(isPostedTask).length;
    const locked = runner.running || scanner.running;
    const selected = q.filter(t => selectedQueueIds.has(t.id)).length;
    const $ = id => root.querySelector(id);
    if ($('#queueBulkInfo')) $('#queueBulkInfo').textContent = `${posted} đã đăng · ${selected} đang chọn`;
    if ($('#queueSelectPosted')) $('#queueSelectPosted').disabled = locked || posted === 0;
    if ($('#queueSelectAll')) $('#queueSelectAll').disabled = locked || !q.length;
    if ($('#queueDeselect')) $('#queueDeselect').disabled = locked || !selected;
    if ($('#queueDeleteSelected')) { $('#queueDeleteSelected').disabled = locked || !selected; $('#queueDeleteSelected').textContent = `Xóa ${selected} bài đã chọn`; }
    if ($('#queueDeletePosted')) { $('#queueDeletePosted').disabled = locked || !posted; $('#queueDeletePosted').textContent = `Xóa nhanh ${posted} bài đã đăng`; }
    if ($('#queueDeleteAll')) $('#queueDeleteAll').disabled = locked || !q.length;
  }
  async function deleteQueueBulk(mode) {
    if (runner.running || scanner.running) throw new Error('Không thể xóa trong lúc đang đăng bài hoặc quét link.');
    const before = readQueue();
    const candidates = before.filter(t => mode === 'posted' ? isPostedTask(t) : mode === 'selected' ? selectedQueueIds.has(t.id) : mode === 'all');
    if (!candidates.length) throw new Error('Không có bài nào phù hợp để xóa.');
    const count = candidates.length;
    const scope = mode === 'posted' ? 'ĐÃ ĐĂNG' : mode === 'selected' ? 'ĐÃ CHỌN' : 'TOÀN BỘ';
    const backupEnabled = !!shadow()?.querySelector('#queueBackupBeforeDelete')?.checked;
    if (!confirm(`Xóa ${count} bài ${scope} khỏi HÀNG ĐỢI CỤC BỘ?\n\n` +
      'Thao tác này KHÔNG xóa bài trên Facebook và KHÔNG xóa danh sách link đã quét.\n' +
      'Ảnh gắn với các mục đã xóa cũng sẽ bị xóa khỏi bộ nhớ của tool.\n' +
      (backupEnabled ? 'Tool sẽ tải bản sao lưu JSON hàng đợi trước khi xóa (không kèm file ảnh).\n' : 'Bạn đang tắt sao lưu tự động.\n') +
      '\nBạn xác nhận xóa?')) return;

    const ids = new Set(candidates.map(t => t.id));
    const root = shadow();
    for (const id of ['queueDeleteSelected', 'queueDeletePosted', 'queueDeleteAll']) {
      const b = root?.querySelector('#'+id); if (b) b.disabled = true;
    }
    setStatus(`Đang dọn ${count} mục hàng đợi…`);
    // Sao luu truoc khi xoa, bao gom thong tin va link da quet, khong bao gom binary anh.
    if (backupEnabled) exportBackup(`facebook-v5-queue-before-delete-${nowIso().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    try {
      // Khong xoa queue neu transaction xoa anh loi; khong tu y mat du lieu.
      await imageDeleteBatch([...ids]);
      const latest = readQueue();
      // Cong viec khac co the thay doi hang doi: chi bo di dung ID da duyet.
      const remaining = latest.filter(t => !ids.has(t.id));
      writeQueue(remaining);
      for (const id of ids) selectedQueueIds.delete(id);
      renderQueue();
      setStatus(`Đã xóa ${latest.length - remaining.length} mục khỏi hàng đợi. Danh sách link đã quét và bài trên Facebook không thay đổi.`, 'ok');
    } finally { updateQueueActions(); }
  }
  function download(data, mime, name) {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const statusLabel = status => ({
    draft:'Chờ đăng', prepared:'Đã điền sẵn', posting:'Chưa rõ kết quả',
    posted:'Đã đăng · có link', posted_nolink:'Đã đăng · thiếu link', error:'Lỗi'
  })[status] || status;
  function exportCsv() {
    const cell = x => { let v = String(x ?? ''); if (/^[=+\-@]/.test(v)) v = `'${v}`; return `"${v.replace(/"/g, '""')}"`; };
    const rows = [['STT','Trạng thái','Link bài viết','Thời gian đăng','Nội dung']];
    readQueue().forEach((t,i) => rows.push([i + 1,statusLabel(t.status),t.permalink || '',t.postedAt || '',t.content]));
    download('\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8', `facebook-v5-links-${nowIso().slice(0,10)}.csv`);
  }
  function exportBackup(filename = `facebook-v5-backup-${nowIso().slice(0,10)}.json`) {
    const backup = { version:'3.1.0', exportedAt:nowIso(), note:'Ảnh vẫn ở IndexedDB trong trình duyệt, không nằm trong file JSON.', settings:readSettings(), queue:readQueue(), scannerSettings:LinkScanner.getOptions(), linksByPage:LinkScanner.allRecords() };
    download(JSON.stringify(backup, null, 2), 'application/json', filename);
  }

  function renderRunState() {
    const root = shadow(); if (!root) return;
    root.querySelector('#run').hidden = runner.running;
    root.querySelector('#stop').hidden = !runner.running;
    root.querySelector('#add').disabled = runner.running || scanner.running;
    root.querySelector('#run').disabled = scanner.running;
    LinkScanner.refresh();
    updateQueueActions();
  }
  function renderQueue() {
    const root = shadow(); if (!root) return;
    const q = readQueue(), posted = q.filter(isPostedTask).length;
    const live = new Set(q.map(x => x.id));
    for (const id of selectedQueueIds) if (!live.has(id)) selectedQueueIds.delete(id);
    root.querySelector('#stats').textContent = `Tổng ${q.length} · Đã đăng ${posted} · Chờ ${q.length - posted}`;
    const holder = root.querySelector('#queue');
    if (!q.length) { holder.innerHTML = '<div class="empty">Hàng đợi đã trống. Danh sách link đã quét vẫn giữ nguyên.</div>'; updateQueueActions(); return; }
    const locked = runner.running || scanner.running ? 'disabled' : '';
    holder.innerHTML = q.map((t, i) => {
      const pending = RUNNABLE.has(t.status);
      const noLink = ['posted','posted_nolink'].includes(t.status) && !t.permalink;
      return `<article class="task ${esc(t.status)}">
        <div class="task-top"><label class="queue-choice"><input type="checkbox" data-queue-select="${esc(t.id)}" ${selectedQueueIds.has(t.id) ? 'checked' : ''} ${locked}> <b>Bài ${i + 1}</b></label><span>${esc(statusLabel(t.status))}</span></div>
        <div class="preview">${esc(t.content)}</div><small>🖼 ${esc(t.imageName || 'Ảnh')} · ${((t.imageSize || 0)/1048576).toFixed(2)} MB</small>
        ${t.lastError ? `<div class="err">${esc(t.lastError)}</div>` : ''}
        ${t.permalink ? `<a href="${esc(t.permalink)}" target="_blank" rel="noopener noreferrer">${esc(t.permalink)}</a>` : ''}
        <div class="row">
          ${pending ? `<button ${locked} class="success" data-action="publish" data-id="${esc(t.id)}">${t.status === 'error' ? 'Thử lại & đăng' : 'Đăng bài này'}</button><button ${locked} data-action="prepare" data-id="${esc(t.id)}">Điền sẵn</button>` : ''}
          ${t.status === 'posting' ? `<button ${locked} data-action="markposted" data-id="${esc(t.id)}">Đã đăng rồi</button><button ${locked} data-action="reset" data-id="${esc(t.id)}">Đặt lại</button>` : ''}
          ${noLink ? `<button ${locked} data-action="manual" data-id="${esc(t.id)}">Dán link riêng (tùy chọn)</button>` : ''}
          <button ${locked} class="danger" data-action="delete" data-id="${esc(t.id)}">Xóa</button>
        </div></article>`;
    }).join('');
    updateQueueActions();
  }

  const PANEL_CSS = `
  :host{all:initial}*{box-sizing:border-box}
  #box{position:fixed;right:18px;top:65px;z-index:2147483647;width:410px;max-width:calc(100vw - 24px);max-height:calc(100vh - 82px);overflow:auto;background:#fff;color:#17202a;border:1px solid #ccd0d5;border-radius:14px;box-shadow:0 10px 35px #0003;font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}
  header{position:sticky;top:0;background:#1877f2;color:#fff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;z-index:2}
  header b{font-size:15px}header button{background:#fff2;border:0;color:#fff;font-size:19px}
  .body{padding:14px}.collapsed .body{display:none}.hint{margin:0 0 10px;color:#57606a;font-size:12px}
  label{display:block;font-weight:650;margin:10px 0 5px}
  textarea,input[type=text],input[type=number]{width:100%;border:1px solid #ccd0d5;border-radius:8px;padding:9px;font:inherit}
  textarea{height:110px;resize:vertical}button{border:0;border-radius:8px;padding:8px 10px;background:#e4e6eb;color:#111;font-weight:650;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}button[hidden]{display:none}
  button.primary{width:100%;margin-top:10px;background:#1877f2;color:#fff}
  button.success{background:#31a24c;color:#fff}button.danger{color:#b42318}button.stop{width:100%;background:#b42318;color:#fff}
  .toolbar,.row{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.toolbar button{font-size:12px}
  .settings{margin-top:12px;padding-top:10px;border-top:1px solid #eee}.two{display:flex;gap:8px}.two>div{flex:1}
  .check{display:flex;gap:6px;align-items:center;font-weight:500;margin-top:10px}.check input{width:auto}
  #status{min-height:20px;margin:10px 0;color:#57606a}#status.ok{color:#167c32}#status.error{color:#b42318}
  #stats{font-size:12px;color:#57606a}.task{border:1px solid #e4e6eb;border-radius:10px;padding:10px;margin:9px 0}
  .task.prepared{border-color:#f0b429;background:#fffaf0}.task.posted,.task.posted_nolink{border-color:#31a24c;background:#f4fff6}
  .task.error,.task.posting{border-color:#b42318;background:#fff5f5}.task-top{display:flex;justify-content:space-between}
  .task-top span{font-size:12px;color:#57606a}.preview{white-space:pre-wrap;max-height:74px;overflow:hidden;margin:6px 0}
  .queue-bulk{border:1px solid #cfd8e3;background:#f8fafc;border-radius:10px;padding:10px;margin:8px 0}
  .queue-bulk h4{margin:0 0 6px;font-size:13px}.queue-bulk .queue-bulk-note{font-size:11px;color:#667085;margin:5px 0}
  .queue-bulk .row button{font-size:12px}.queue-bulk .destructive{background:#b42318;color:#fff}
  .queue-choice{display:flex;align-items:center;gap:7px;margin:0;font-weight:600;cursor:pointer}.queue-choice input{width:auto;accent-color:#1877f2}
  .queue-bulk .check{font-size:12px;margin:6px 0 3px}
  .task small{display:block;color:#57606a}.err{color:#b42318;font-size:12px;margin-top:4px}
  .task a{display:block;margin-top:6px;color:#1877f2;word-break:break-all;font-size:12px}.empty{text-align:center;color:#6b7280;padding:18px}
  .warning{background:#fff4e5;border-radius:8px;padding:8px;font-size:12px;margin-top:8px}
  #drop{border:2px dashed #9aa4b2;border-radius:10px;padding:14px 10px;text-align:center;color:#57606a;font-size:12px;cursor:pointer;background:#f7f9fc}
  #drop:hover,#drop:focus,#drop.drag{border-color:#1877f2;background:#e7f0fe;color:#1877f2;outline:0}
  #pairInfo{font-weight:500;font-size:12px;color:#167c32}#pairInfo.warn{color:#b42318}
  #staged{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
  .thumb{position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;border:1px solid #ccd0d5;background:#eee}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}.thumb .n{position:absolute;left:3px;top:3px;background:#1877f2;color:#fff;font-size:11px;font-weight:700;border-radius:10px;padding:0 6px}
  .thumb .tb{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-around;background:#000a;padding:2px}
  .thumb .tb button{padding:0 5px;font-size:12px;background:transparent;color:#fff;line-height:18px}
  #linkScanner{margin-top:12px;border:1px solid #b8d0f5;border-radius:10px;background:#f8fbff}
  #linkScanner>summary{padding:12px;cursor:pointer;background:#eaf2ff;border-radius:10px;font-weight:750;list-style-position:inside}
  #linkScanner .ls-inner{padding:10px}
  #linkScanner .ls-muted{font-size:11px;color:#667085;overflow-wrap:anywhere}
  #linkScanner .ls-options{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
  #linkScanner .ls-options label{font-size:12px;margin:0}
  #linkScanner input[type=number]{margin-top:5px;padding:6px}
  #linkScanner .check{font-size:12px;margin-top:9px;line-height:1.3}
  #linkScanner .ls-status{padding:8px;border-radius:6px;margin:12px 0 9px;background:#e8f0ff;color:#185abc;font-size:12px;white-space:pre-wrap}
  #linkScanner .ls-status.error{color:#b42318;background:#fff0f1}
  #linkScanner .ls-heading{display:flex;justify-content:space-between;font-size:13px;margin:10px 0 7px}
  #linkScanner #ls-filter{width:100%;margin:0 0 8px;padding:7px;font-size:12px}
  #linkScanner .ls-list{max-height:290px;overflow:auto;border:1px solid #d2d9e1;border-radius:8px;background:white}
  #linkScanner .entry{display:flex;gap:7px;align-items:start;border-bottom:1px solid #edf0f3;padding:7px}
  #linkScanner .entry span{color:#667085;font-size:11px}
  #linkScanner .entry .content{flex:1;min-width:0}
  #linkScanner .entry a{display:block;color:#1877f2;word-break:break-all;font-size:11px}
  #linkScanner .entry small{display:block;color:#667085;font-size:10px;word-break:break-word}
  #linkScanner .entry button{padding:4px 6px;font-size:12px}
  #linkScanner .ls-debug{margin-top:9px;font-size:12px}
  #linkScanner .ls-debug pre{max-height:140px;white-space:pre-wrap;overflow:auto;background:#f0f3f8;padding:7px;font-size:11px}
  #linkScanner .toolbar button{font-size:11px}
`;

  function createPanel() {
    if (!document.documentElement || document.getElementById(APP_ID)) return;
    const host = document.createElement('div'); host.id = APP_ID; document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode:'open' }), settings = readSettings();
    root.innerHTML = `<style>${PANEL_CSS}</style><div id="box"><header><b>Facebook V5 · Đăng bài + Quét link V3.1</b><button id="collapse" title="Thu gọn">−</button></header><div class="body">
      <p class="hint">Một ảnh cho mỗi bài, nội dung cách nhau bằng một dòng <b>---</b>. Giữ nguyên toàn bộ dữ liệu V2.4 trên trình duyệt này.</p>
      <label>Nội dung</label><textarea id="content" placeholder="Nội dung bài 1&#10;---&#10;Nội dung bài 2"></textarea>
      <label>Ảnh <span id="pairInfo"></span></label><div id="drop" tabindex="0">Bấm để chọn ảnh · kéo ảnh vào · hoặc Ctrl+V để dán</div>
      <input id="image" type="file" multiple accept="image/jpeg,image/png,image/webp" hidden>
      <div class="toolbar"><button id="pasteBtn">Dán ảnh từ clipboard</button><button id="clearStaged" class="danger">Xóa ảnh chờ</button></div>
      <div id="staged"></div><button class="primary" id="add">Thêm vào danh sách</button>
      <div id="status"></div><button class="primary" id="run" style="background:#31a24c">▶ Đăng lần lượt toàn bộ</button>
      <button class="stop" id="stop" hidden>■ Dừng sau bài hiện tại</button>
      <div class="toolbar"><button id="exportCsv">Xuất CSV hàng đợi</button></div>
      <div class="warning">Đăng bài và quét URL là hai thao tác riêng. Danh sách URL nằm ở mục Quét link phía dưới, không cần ghép với nội dung bài đăng. Giữ tab Facebook đang hiển thị khi tự động chạy.</div>
      <details id="linkScanner" open>
        <summary>🔗 QUÉT LINK BÀI VIẾT — CẤU HÌNH VÀ DANH SÁCH</summary>
        <div class="ls-inner">
          <p class="hint">Quét mọi bài được tải trên trang đang mở, không ghép với caption/hàng đợi.</p>
          <div id="ls-page" class="ls-muted"></div>
          <div class="toolbar"><button id="ls-scan" class="success">▶ Quét + tự cuộn</button><button id="ls-only">Quét bài đang hiện</button><button id="ls-stop" class="stop" hidden>■ Dừng quét</button></div>
          <div class="ls-options"><label>Lượt cuộn tối đa<input id="ls-max" type="number" min="1" max="1000"></label><label>Chờ mỗi lượt (ms)<input id="ls-wait" type="number" min="700" max="10000"></label></div>
          <label class="check"><input type="checkbox" id="ls-share"> Ưu tiên Chia sẻ → Sao chép liên kết</label>
          <label class="check"><input type="checkbox" id="ls-fallback"> Dùng URL ảnh trong bài khi không lấy được permalink</label>
          <label class="check"><input type="checkbox" id="ls-auto"> Tự quét sau khi đăng hết hàng đợi</label>
          <div id="ls-status" class="ls-status">Sẵn sàng quét link.</div>
          <div class="ls-heading"><b>Danh sách link đã tìm</b><span id="ls-count">0 link</span></div>
          <input id="ls-filter" type="text" placeholder="Tìm kiếm URL, loại link, nội dung…">
          <div id="ls-list" class="ls-list"></div>
          <div class="toolbar"><button id="ls-copy">Sao chép tất cả</button><button id="ls-clip">Lưu link từ clipboard</button><button id="ls-txt">Xuất TXT</button><button id="ls-csv">Xuất CSV</button></div>
          <div class="toolbar"><button id="ls-import">Nhập TXT/CSV cũ</button><button id="ls-add">Thêm thủ công</button><button id="ls-clear" class="danger">Xóa link trang này</button></div>
          <input id="ls-importFile" type="file" accept=".txt,.csv,text/plain,text/csv" hidden>
          <textarea id="ls-manual" hidden placeholder="Dán một hay nhiều URL Facebook vào đây, rồi nhấn Thêm thủ công lần nữa."></textarea>
          <p class="hint">Link lưu riêng theo mỗi trang. Link ảnh dự phòng có thể mở ảnh thay vì bài viết. Dữ liệu từ script Scanner V2 cũ có thể nhập qua TXT/CSV.</p>
          <details class="ls-debug"><summary>Nhật ký lỗi quét</summary><pre id="ls-details"></pre></details>
        </div>
      </details>
      <h3>Hàng đợi <span id="stats"></span></h3>
      <section class="queue-bulk" aria-label="Quản lý hàng đợi hàng loạt">
        <h4>🧹 Dọn hàng đợi nhanh <small id="queueBulkInfo"></small></h4>
        <div class="row"><button id="queueSelectPosted">Chọn bài đã đăng</button><button id="queueSelectAll">Chọn tất cả</button><button id="queueDeselect">Bỏ chọn</button></div>
        <div class="row"><button id="queueDeletePosted" class="destructive">Xóa bài đã đăng</button><button id="queueDeleteSelected" class="danger">Xóa đã chọn</button><button id="queueDeleteAll" class="danger">Xóa toàn bộ hàng đợi</button></div>
        <label class="check"><input id="queueBackupBeforeDelete" type="checkbox" checked> Tự tải sao lưu JSON trước khi xóa</label>
        <p class="queue-bulk-note">Chỉ dọn hàng đợi và ảnh cục bộ trong tool. Không xóa bài trên Facebook, không đụng tới danh sách link đã quét. File sao lưu JSON không chứa ảnh.</p>
      </section>
      <div id="queue"></div>
      <div class="settings"><label>Hashtag tự thêm</label><input id="tags" type="text">
      <div class="two"><div><label>Nghỉ tối thiểu (giây)</label><input id="minDelay" type="number" min="1" max="3600"></div><div><label>Nghỉ tối đa (giây)</label><input id="maxDelay" type="number" min="1" max="3600"></div></div>
      <label class="check"><input id="requireImage" type="checkbox"> Chỉ đăng khi xác nhận ảnh đã gắn</label>
      <label class="check"><input id="keepImages" type="checkbox"> Giữ ảnh sau khi đăng</label>
      <div class="toolbar"><button id="saveSettings">Lưu cài đặt</button><button id="export">Sao lưu JSON</button></div></div></div></div>`;
    root.querySelector('#tags').value = settings.hashtags;
    root.querySelector('#minDelay').value = settings.minDelay;
    root.querySelector('#maxDelay').value = settings.maxDelay;
    root.querySelector('#requireImage').checked = settings.requireImage;
    root.querySelector('#keepImages').checked = settings.keepImages;
    if (settings.collapsed) root.querySelector('#box').classList.add('collapsed');
    root.querySelector('#collapse').textContent = settings.collapsed ? '+' : '−';
    const fail = e => setStatus(e.message || String(e), 'error');
    root.querySelector('#collapse').onclick = () => {
      const box = root.querySelector('#box'); box.classList.toggle('collapsed');
      root.querySelector('#collapse').textContent = box.classList.contains('collapsed') ? '+' : '−';
      writeSettings({ collapsed:box.classList.contains('collapsed') });
    };
    root.querySelector('#add').onclick = () => addTasks().catch(fail);
    const drop = root.querySelector('#drop'), picker = root.querySelector('#image'), box = root.querySelector('#box');
    drop.onclick = () => picker.click();
    drop.onkeydown = e => { if (e.key === 'Enter') picker.click(); };
    picker.onchange = () => { const files = [...picker.files]; picker.value = ''; addStaged(files).catch(fail); };
    const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    for (const type of ['dragenter','dragover']) box.addEventListener(type, e => {
      if (!hasFiles(e)) return; e.preventDefault(); drop.classList.add('drag');
    });
    box.addEventListener('dragleave', e => { if (!box.contains(e.relatedTarget)) drop.classList.remove('drag'); });
    box.addEventListener('drop', e => {
      drop.classList.remove('drag'); if (!hasFiles(e)) return;
      e.preventDefault(); addStaged(e.dataTransfer.files).catch(fail);
    });
    root.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addStaged(files).catch(fail); }
    });
    root.querySelector('#pasteBtn').onclick = () => pasteFromClipboard().catch(fail);
    root.querySelector('#clearStaged').onclick = async () => {
      if (!staged.length || !confirm(`Xóa ${staged.length} ảnh chờ?`)) return;
      await stageClear(); staged = []; renderStaged(); setStatus('Đã xóa ảnh chờ.', 'ok');
    };
    root.querySelector('#staged').onclick = e => {
      const btn = e.target.closest('button[data-sa]'); if (!btn) return;
      const { sa, id } = btn.dataset;
      (sa === 'up' ? moveStaged(id, -1) : sa === 'down' ? moveStaged(id, 1) :
        stageDelete(id).then(() => { staged = staged.filter(x => x.id !== id); renderStaged(); })).catch(fail);
    };
    const textarea = root.querySelector('#content');
    textarea.value = GM_getValue(DRAFT_KEY, '') || '';
    let debounce;
    textarea.addEventListener('input', () => {
      updatePairInfo(); clearTimeout(debounce);
      debounce = setTimeout(() => GM_setValue(DRAFT_KEY, textarea.value), 350);
    });
    root.querySelector('#run').onclick = () => runQueue().catch(fail);
    root.querySelector('#stop').onclick = () => { runner.stop = true; setStatus('Sẽ dừng sau khi xử lý xong bài hiện tại.'); };
    root.querySelector('#exportCsv').onclick = exportCsv;
    root.querySelector('#export').onclick = () => exportBackup();
    root.querySelector('#queueSelectPosted').onclick = () => selectQueue('posted');
    root.querySelector('#queueSelectAll').onclick = () => selectQueue('all');
    root.querySelector('#queueDeselect').onclick = () => selectQueue('none');
    for (const [id, mode] of [['queueDeletePosted','posted'], ['queueDeleteSelected','selected'], ['queueDeleteAll','all']]) {
      root.querySelector('#'+id).onclick = () => deleteQueueBulk(mode).catch(fail);
    }
    root.querySelector('#queue').addEventListener('change', e => {
      const input = e.target.closest('input[data-queue-select]');
      if (!input || runner.running || scanner.running) return;
      if (input.checked) selectedQueueIds.add(input.dataset.queueSelect);
      else selectedQueueIds.delete(input.dataset.queueSelect);
      updateQueueActions();
    });
    root.querySelector('#saveSettings').onclick = () => {
      const clamp = v => Math.min(3600, Math.max(1, parseInt(v, 10) || 3));
      let minDelay = clamp(root.querySelector('#minDelay').value), maxDelay = clamp(root.querySelector('#maxDelay').value);
      if (minDelay > maxDelay) [minDelay,maxDelay] = [maxDelay,minDelay];
      const hashtags = normalizeTags(root.querySelector('#tags').value);
      writeSettings({ hashtags, minDelay, maxDelay, requireImage:root.querySelector('#requireImage').checked, keepImages:root.querySelector('#keepImages').checked });
      root.querySelector('#tags').value = hashtags; root.querySelector('#minDelay').value = minDelay;
      root.querySelector('#maxDelay').value = maxDelay; setStatus('Đã lưu cài đặt.', 'ok');
    };
    root.querySelector('#queue').onclick = async e => {
      const btn = e.target.closest('button[data-action]'); if (!btn) return;
      const { action, id } = btn.dataset; btn.disabled = true;
      try {
        if (runner.running || scanner.running) throw new Error('Đang chạy tự động.');
        if (action === 'publish') {
          await runTask(id, true);
          setStatus('Đã đăng bài. Bấm Quét link để thu thập URL trên trang.', 'ok');
        } else if (action === 'prepare') await runTask(id, false);
        else if (action === 'markposted') { patchTask(id, { status:'posted_nolink', postedAt:nowIso(), lastError:'' }); setStatus('Đã xác nhận bài đã đăng.', 'ok'); }
        else if (action === 'reset') {
          if (!confirm('Chỉ đặt lại nếu bạn chắc chắn bài CHƯA đăng. Tiếp tục?')) return;
          patchTask(id, { status:'draft', lastError:'' }); setStatus('Đã đưa về Chờ đăng.', 'ok');
        } else if (action === 'manual') {
          const text = prompt('Mở bài viết → Chia sẻ → Sao chép liên kết. Sau đó dán link của CHÍNH bài này vào đây:', '');
          if (text === null) return;
          const url = cleanLink(text);
          if (!url) throw new Error('Link không phải permalink bài Facebook hợp lệ.');
          if (readQueue().some(t => t.id !== id && t.permalink === url)) throw new Error('Link này đã được lưu cho một bài khác.');
          patchTask(id, { status:'posted', permalink:url, lastError:'' });
          setStatus('Đã xác minh định dạng và lưu link thủ công.', 'ok');
        } else if (action === 'delete') {
          if (confirm('Xóa bài này khỏi danh sách?')) await deleteTask(id);
        }
      } catch (error) { fail(error); }
      finally { if (btn.isConnected) btn.disabled = false; }
    };
    LinkScanner.mount(); renderRunState(); renderQueue(); loadStaged(); updatePairInfo();
  }

  // @run-at document-start: DOM chua san sang, doi root xuat hien.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createPanel, { once: true });
  else createPanel();
  const observer = new MutationObserver(() => {
    if (document.documentElement && !document.getElementById(APP_ID)) createPanel();
  });
  function observe() {
    if (document.documentElement) observer.observe(document.documentElement, { childList:true });
  }
  if (document.documentElement) observe();
  else document.addEventListener('DOMContentLoaded', observe, { once: true });
})();
