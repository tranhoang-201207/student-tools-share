
// ==UserScript==
// @name         Hành Động Đẹp – Gửi biểu mẫu tuần tự (V2.4)
// @namespace    local.hanhdongdep.v2
// @version      2.4.0
// @description  Cho phép từng người tự khai báo thông tin; gửi tuần tự vào biểu mẫu Hành Động Đẹp đã cấu hình.
// @match        https://docs.google.com/forms/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

/*
 V2.3: Khắc phục lỗi quay lại tài khoản Google mặc định khi nhấn Bắt đầu/Tiếp tục.
 Chạy trên một tab với đúng tài khoản sinh viên. Không vượt CAPTCHA.
*/

(async () => {
  'use strict';

  if (location.hostname !== 'docs.google.com') return;
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
    if (status.hanhDongDepEnabled !== true) {
      console.warn(`[Hành Động Đẹp] Tool đang tắt: ${status.message || 'Không có thông báo.'}`);
      return;
    }
  } catch (error) {
    console.error('[Hành Động Đẹp] Không kiểm tra được trạng thái:', error);
    return;
  }

  const match = location.pathname.match(/\/d\/e\/([^/]+)\/(viewform|formResponse)(?:\/|$)/);
  if (!match) return;
  const FORM_ID = match[1];
  const TARGET_FORM_ID = '1FAIpQLSfApDrQL1VYPdWg3RCr5s0u7BOZsiCY8w_ZGOtbUHuGXGHLRg';
  if (FORM_ID !== TARGET_FORM_ID) return;

  // Mỗi người tự khai báo; dữ liệu chỉ lưu trong Tampermonkey trên máy của họ.
  const DEFAULT_PROFILE = Object.freeze({
    name: '',
    mssv: '',
    cls: '',
    faculty: '',
    category: 'Hình ảnh'
  });
  const REQUIRED_EMAIL_DOMAIN = '@st.hcmuaf.edu.vn';
  const DEFAULT_UNIT = 'Chưa/ không còn tham gia CLB/Tổ đội nhóm';
  const UNITS = Object.freeze([
    DEFAULT_UNIT,
    'Tổ Tu dưỡng Rèn luyện Hạt Giống Đỏ',
    'Đội Cộng tác viên Đoàn - Hội Lửa Xanh'
  ]);
  const FIELDS = ['name', 'mssv', 'cls', 'faculty', 'unit', 'category', 'link'];
  const LABELS = {
    name: 'Họ và tên', mssv: 'MSSV', cls: 'Lớp', faculty: 'Khoa',
    unit: 'CLB/Tổ/Đội/Nhóm', category: 'Thể loại', link: 'Link bài viết'
  };
  // Dùng lại khóa của V2 để không mất danh sách và lịch sử chống trùng.
  const K = {
    state: 'hdd_state_v2', hist: 'hdd_history_v2',
    lock: 'hdd_lock_v2', pin: 'hdd_pinned_form_v2', profile: 'hdd_profile_v24'
  };
  const TAB = sessionStorage.getItem('hdd_tab') || (() => {
    const v = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    sessionStorage.setItem('hdd_tab', v);
    return v;
  })();
  const LOCK_TTL = 14000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const nowStr = () => new Date().toLocaleString('vi-VN', { hour12: false });
  const nfc = v => String(v ?? '').normalize('NFC')
    .replace(/[\u2013\u2014\u2212]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  const plain = v => nfc(v).normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const trim = v => String(v ?? '').trim();
  const load = (key, fallback) => {
    try {
      const raw = GM_getValue(key);
      if (raw == null || raw === '') return fallback;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) { return fallback; }
  };
  const save = (key, val) => GM_setValue(key, JSON.stringify(val));
  let PROFILE = Object.assign({}, DEFAULT_PROFILE, load(K.profile, {}));
  const saveProfile = () => save(K.profile, PROFILE);
  const profileComplete = () => ['name', 'mssv', 'cls', 'faculty', 'category']
    .every(key => trim(PROFILE[key]));
  const defState = () => ({ status: 'idle', unit: DEFAULT_UNIT, delaySec: 4, items: [], seq: 0 });
  let S = Object.assign(defState(), load(K.state, {}));
  if (!Array.isArray(S.items)) S.items = [];
  if (!UNITS.includes(S.unit)) S.unit = DEFAULT_UNIT;
  const persist = () => save(K.state, S);
  const hist = () => load(K.hist, {});
  const pinned = () => GM_getValue(K.pin) || '';
  const isPinned = () => pinned() === FORM_ID;
  let busy = false;
  let lastBanner = { msg: '', kind: 'info' };

  // Không tự dựng viewform URL: URL /forms/d/e/... không ghim Google account,
  // có thể khiến Google chọn tài khoản mặc định khi reload.
  // Chỉ nhớ chỉ số /u/N/ SAU KHI đã xác minh email thật trên form.
  const ACCOUNT_SLOT_KEY = 'hdd_v23_verified_account_slot';
  function accountSlot(url) {
    try {
      const pathname = new URL(url, location.href).pathname;
      const match = pathname.match(/\/forms\/u\/(\d+)\/d\/e\//);
      return match ? match[1] : null;
    } catch (_) { return null; }
  }
  function rememberVerifiedAccountSlot() {
    let slot = accountSlot(location.href);
    // Google đôi khi hiển thị đúng email nhưng address bar chưa có /u/N/.
    // Khi đó tham chiếu URL biểu mẫu do CHÍNH Google đặt trong footer.
    if (slot === null) {
      for (const link of document.querySelectorAll('a[href]')) {
        if (!link.href.includes(`/d/e/${FORM_ID}/`)) continue;
        slot = accountSlot(link.href);
        if (slot !== null) break;
      }
    }
    if (slot !== null) sessionStorage.setItem(ACCOUNT_SLOT_KEY, slot);
  }

  async function waitFor(check, timeout = 12000, step = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const result = check(); if (result) return result; } catch (_) { /* DOM đang cập nhật */ }
      await sleep(step);
    }
    return null;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'style') node.style.cssText = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value != null && value !== false) node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) node.append(
      child instanceof Node ? child : document.createTextNode(String(child ?? ''))
    );
    return node;
  }

  // === LINK FACEBOOK & CHỐNG TRÙNG ===
  const TRACK = /^(utm_.*|fbclid|mibextid|ref|ref_src|__cft__.*|__tn__|_rdc|_rdr|rdid|share_url|paipv|eav|comment_tracking|hc_ref|__xts__.*|sfnsn)$/i;
  function parseFb(raw) {
    let url;
    try { url = new URL(trim(raw)); }
    catch (_) { return { ok: false, why: 'URL không hợp lệ' }; }
    if (!/^https?:$/.test(url.protocol)) return { ok: false, why: 'Giao thức không được hỗ trợ' };
    if (!/(^|\.)(facebook\.com|fb\.com)$/.test(url.hostname.toLowerCase()))
      return { ok: false, why: 'Không phải link Facebook' };
    const path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return { ok: false, why: 'Thiếu đường dẫn bài viết' };
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => !TRACK.test(key))
      .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
    const query = new URLSearchParams(kept).toString();
    return { ok: true, key: `facebook.com${path}${query ? '?' + query : ''}` };
  }

  // === KHÓA MỘT TAB GỬI; không xóa khóa của tab khác ===
  const lock = () => load(K.lock, null);
  const ownsLock = () => { const l = lock(); return !!l && l.tab === TAB; };
  async function takeLock() {
    const l = lock();
    if (l && l.tab !== TAB && Date.now() - l.ts < LOCK_TTL) return false;
    save(K.lock, { tab: TAB, ts: Date.now() });
    await sleep(300);
    return ownsLock();
  }
  function releaseLock() { if (ownsLock()) GM_deleteValue(K.lock); }
  setInterval(() => {
    if (S.status === 'running' && ownsLock()) save(K.lock, { tab: TAB, ts: Date.now() });
  }, 2500);
  function syncRemoteStop() {
    const latest = load(K.state, {});
    // Tôn trọng lệnh TẠM DỪNG / DỪNG được bấm từ tab khác.
    if (S.status === 'running' && ['paused', 'stopped'].includes(latest.status))
      S.status = latest.status;
    return latest;
  }
  const liveRunning = () => {
    const latest = syncRemoteStop();
    return latest.status === 'running' && S.status === 'running' && isPinned() && ownsLock();
  };

  // === NHẬN DIỆN NÚT VÀ TÀI KHOẢN ===
  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    const cs = getComputedStyle(node);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && !!node.getClientRects().length;
  }
  function actionNames(node) {
    return [node.getAttribute('aria-label'), node.innerText, node.textContent,
      node.getAttribute('value'), node.getAttribute('title')]
      .filter(Boolean).map(plain);
  }
  function findButton(aliases) {
    return [...document.querySelectorAll('[role="button"], button, input[type="submit"]')]
      .find(node => isVisible(node) && !node.matches('[aria-disabled="true"], :disabled') &&
        actionNames(node).some(name => aliases.includes(name)));
  }
  const nextBtn = () => findButton(['tiep', 'tiep tuc', 'next', 'continue']);
  const backBtn = () => findButton(['quay lai', 'back', 'previous']);
  const submitBtn = () => findButton(['gui', 'submit', 'send']);
  // Chỉ click MỘT LẦN để tránh tạo nhiều event click.
  function clickOnce(node) {
    if (!node || !isVisible(node)) throw new Error('Nút điều khiển không hiển thị');
    node.click();
  }
  function currentAccount() {
    // Ưu tiên vùng gần liên kết chuyển đổi tài khoản, tránh lấy email từ nội dung câu hỏi.
    const links = [...document.querySelectorAll('a')];
    const switcher = links.find(a => /accountchooser/i.test(a.href) ||
      /^(chuyen doi tai khoan|switch account|change account)$/.test(plain(a.innerText)));
    if (!switcher) return '';
    const re = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
    let parent = switcher.parentElement;
    for (let n = 0; parent && n < 4; n++, parent = parent.parentElement) {
      const matches = (parent.innerText || '').match(re) || [];
      if (matches.length) return matches[0].toLowerCase();
    }
    return '';
  }
  function accountCheck() {
    const actual = currentAccount();
    if (actual.endsWith(REQUIRED_EMAIL_DOMAIN)) {
      rememberVerifiedAccountSlot();
      return { ok: true, account: actual };
    }
    return {
      ok: false,
      msg: actual
        ? `Sai tài khoản (${actual}). Cần dùng email sinh viên có đuôi ${REQUIRED_EMAIL_DOMAIN}; chuyển tài khoản rồi bấm TIẾP TỤC.`
        : `Không đọc được tài khoản Google đang dùng. Hãy chọn email sinh viên có đuôi ${REQUIRED_EMAIL_DOMAIN}; công cụ không tự bỏ qua kiểm tra.`
    };
  }

  // === GOOGLE FORMS NHIỀU TRANG ===
  const RULES = {
    name: /(?:\bho\s*(?:va\s*)?ten\b|\bten sinh vien\b)/,
    mssv: /(?:ma so sinh vien|\bmssv\b)/,
    cls: /(?:^|\b)lop(?:\b|\s)/,
    faculty: /\bkhoa\b/,
    unit: /(?:\bclb\b|cau lac bo|to\s*\/\s*doi|doi\s*\/\s*nhom|don vi tham gia|don vi du thi)/,
    category: /the loai/,
    link: /(?:\blink\b|lien ket|duong dan|facebook)/
  };
  const headingText = li => trim(li.querySelector('[role="heading"]')?.innerText || '');
  function scanPage() {
    const questions = [...document.querySelectorAll('div[role="listitem"]')]
      .filter(q => !!q.querySelector('[role="heading"]') && isVisible(q));
    const fields = {};
    const errors = [];
    const claimed = new Map();
    for (const [key, re] of Object.entries(RULES)) {
      const found = questions.filter(q => re.test(plain(headingText(q))));
      if (found.length > 1) errors.push(`Nhiều câu hỏi cùng khớp trường ${LABELS[key]}`);
      if (found.length === 1) {
        fields[key] = found[0];
        const owners = claimed.get(found[0]) || [];
        owners.push(key);
        claimed.set(found[0], owners);
      }
    }
    for (const owners of claimed.values()) {
      if (owners.length > 1) errors.push('Một câu hỏi bị nhận diện nhiều lần: ' + owners.join('/'));
    }
    for (const q of questions) {
      if (claimed.has(q)) continue;
      const required = !!q.querySelector('[aria-required="true"]') ||
        /\*\s*$/.test(headingText(q));
      if (required) errors.push('Câu hỏi bắt buộc chưa hỗ trợ: ' + headingText(q).slice(0, 70));
    }
    if (document.querySelector('iframe[src*="recaptcha"], .g-recaptcha'))
      errors.push('Phát hiện CAPTCHA; chỉ có thể tiếp tục bằng thao tác thủ công hợp lệ');
    return { fields, errors, questions };
  }
  function fieldKind(q) {
    if (q.querySelector('[role="radio"]')) return 'radio';
    if (q.querySelector('[role="listbox"]')) return 'dropdown';
    if (q.querySelector('input[type="text"], input:not([type]), textarea')) return 'text';
    return 'unknown';
  }
  const textInput = q => q.querySelector('input[type="text"], input:not([type]), textarea');
  const labelOf = node => trim(node.getAttribute('data-value') || node.getAttribute('aria-label') ||
    node.innerText || node.textContent || '');

  async function setField(q, desired) {
    const kind = fieldKind(q);
    if (kind === 'text') {
      const input = textInput(q);
      const base = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      input.focus();
      Object.getOwnPropertyDescriptor(base, 'value').set.call(input, desired);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    } else if (kind === 'radio') {
      const target = [...q.querySelectorAll('[role="radio"]')]
        .find(node => nfc(labelOf(node)) === nfc(desired));
      if (!target) throw new Error('Không tìm thấy đáp án radio: ' + desired);
      if (target.getAttribute('aria-checked') !== 'true') clickOnce(target);
    } else if (kind === 'dropdown') {
      const box = q.querySelector('[role="listbox"]');
      clickOnce(box);
      const target = await waitFor(() => [...document.querySelectorAll('[role="option"]')]
        .find(node => isVisible(node) && nfc(labelOf(node)) === nfc(desired)), 5000);
      if (!target) throw new Error('Không tìm thấy đáp án danh sách: ' + desired);
      clickOnce(target);
    } else {
      throw new Error('Loại câu hỏi chưa được hỗ trợ: ' + kind);
    }
    await sleep(200);
  }

  function readField(q) {
    const kind = fieldKind(q);
    if (kind === 'text') return trim(textInput(q)?.value);
    if (kind === 'radio') {
      const selected = q.querySelector('[role="radio"][aria-checked="true"]');
      return selected ? labelOf(selected) : '';
    }
    if (kind === 'dropdown') {
      const box = q.querySelector('[role="listbox"]');
      const selected = q.querySelector('[role="option"][aria-selected="true"]');
      // Forms thường đóng menu sau khi chọn: giá trị nằm trong listbox.
      return trim(selected ? labelOf(selected) :
        (box?.getAttribute('data-value') || box?.innerText || box?.textContent || ''));
    }
    return '';
  }
  function wantFor(it) {
    return {
      name: trim(PROFILE.name), mssv: trim(PROFILE.mssv), cls: trim(PROFILE.cls),
      faculty: trim(PROFILE.faculty), category: trim(PROFILE.category),
      unit: S.unit, link: trim(it.raw)
    };
  }
  function pageSignature() {
    // Tránh nhận nhầm thay đổi thông báo tự lưu bản nháp là đã chuyển trang.
    const heads = [...document.querySelectorAll('div[role="listitem"] [role="heading"]')]
      .filter(isVisible).map(e => trim(e.innerText)).join('|');
    const actions = [!!nextBtn(), !!submitBtn()].join('/');
    return `${heads}::${actions}`;
  }
  // Câu thực tế của form này: "Hệ thống đã ghi lại câu trả lời của bạn".
  const CONFIRM_RE = /(?:he thong da ghi lai cau tra loi cua ban|cau tra loi cua ban da duoc ghi lai|cau tra loi cua ban da duoc ghi nhan|da ghi nhan cau tra loi cua ban|your response has been recorded)/;
  function isConfirmation() {
    return !nextBtn() && !submitBtn() && CONFIRM_RE.test(plain(document.body.innerText));
  }
  function anotherResponseLink() {
    // Lấy link Google cung cấp trên trang xác nhận, không tự chế URL.
    const names = [
      'gui y kien phan hoi khac',
      'gui mot cau tra loi khac',
      'submit another response',
      'send another response'
    ];
    return [...document.querySelectorAll('a[href]')].find(node => {
      if (!names.includes(plain(node.innerText || node.textContent))) return false;
      try {
        const u = new URL(node.href, location.href);
        if (u.origin !== location.origin ||
            !u.pathname.includes(`/d/e/${FORM_ID}/viewform`) ||
            u.searchParams.has('edit2')) return false;
        const verifiedSlot = sessionStorage.getItem(ACCOUNT_SLOT_KEY);
        const nextSlot = accountSlot(u.href);
        // Nếu biết chắc index tài khoản, không tự mở /u/N/ khác.
        if (verifiedSlot !== null && nextSlot !== null && verifiedSlot !== nextSlot) return false;
        // Nếu đã có đường dẫn /u/N/ đúng, không dùng link bỏ chỉ số tài khoản.
        if (verifiedSlot !== null && nextSlot === null) return false;
        return true;
      } catch (_) { return false; }
    }) || null;
  }
  function validationError() {
    const errs = [...document.querySelectorAll('[role="alert"], [aria-invalid="true"]')]
      .filter(isVisible).map(x => trim(x.innerText || x.getAttribute('aria-label'))).filter(Boolean);
    return errs.slice(0, 3).join('; ');
  }

  function setItem(it, status, message, phase = '') {
    syncRemoteStop();
    it.status = status;
    it.phase = phase;
    if (message !== undefined) it.msg = message;
    persist();
    render();
  }
  function pause(message, kind = 'warn') {
    S.status = 'paused';
    persist();
    releaseLock();
    banner(message, kind);
    render();
  }
  function restoreInterrupted() {
    const active = S.items.filter(i => i.status === 'RUNNING');
    if (!active.length) return;
    // Sau click Gửi, tuyệt đối không tự gửi lại khi chưa có trang xác nhận.
    const clicked = active.some(i => i.phase === 'clicked');
    if (clicked) {
      for (const it of active) {
        it.status = 'REVIEW';
        it.msg = 'Lần gửi trước chưa xác minh được kết quả; kiểm tra thủ công trước khi thử lại';
        it.phase = '';
      }
      S.status = 'paused';
      persist();
      releaseLock();
      return;
    }
    // Nếu chuyển trang bị tải lại, vẫn giữ chứng cứ các trường đã điền.
    // Các trường hiện trên trang đang mở sẽ được điền/đọc lại một lần nữa.
    for (const it of active) {
      if (S.status !== 'running' || it.phase !== 'advancing') {
        it.status = 'PENDING';
        it.phase = '';
        it.seen = [];
        it.msg = 'Phiên tải lại trước khi bấm Gửi; có thể bắt đầu lại an toàn';
        if (S.status === 'running') S.status = 'paused';
      }
    }
    persist();
  }

  async function waitForConfirmation(it) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      syncRemoteStop();
      if (isConfirmation()) {
        const hst = hist();
        hst[it.key] = { time: nowStr(), unit: it.unit, url: it.raw };
        save(K.hist, hst);
        it.time = nowStr();
        it.phase = '';
        setItem(it, 'SUCCESS', 'Google Forms xác nhận đã ghi nhận câu trả lời');
        if (S.status === 'running') await scheduleNext();
        return;
      }
      // Google Forms báo lỗi xác thực/validation: dừng, không lặp gửi.
      const err = validationError();
      if (err && (nextBtn() || submitBtn())) {
        it.phase = '';
        setItem(it, 'FAILED', 'Form báo lỗi: ' + err);
        pause('Form từ chối hoặc có trường chưa hợp lệ: ' + err, 'err');
        return;
      }
      await sleep(400);
    }
    it.phase = '';
    setItem(it, 'REVIEW', 'Đã bấm Gửi nhưng không nhận được xác nhận sau 30 giây');
    pause('Chưa thể xác minh lượt gửi; hãy kiểm tra thủ công trước khi tiếp tục.', 'warn');
  }

  async function scheduleNext() {
    if (!S.items.some(i => i.status === 'PENDING')) {
      S.status = 'done'; persist(); releaseLock();
      banner('Đã xử lý hết các dòng PENDING. Kiểm tra FAILED và REVIEW nếu có.', 'ok');
      render();
      return;
    }
    const seconds = Math.max(2, Math.min(60, Number(S.delaySec) || 4));
    for (let remaining = seconds; remaining > 0; remaining--) {
      if (!liveRunning()) { releaseLock(); return; }
      banner(`Chuyển tới lượt kế tiếp sau ${remaining} giây…`, 'info');
      await sleep(1000);
    }
    if (!liveRunning()) return;
    if (isConfirmation()) {
      const link = anotherResponseLink();
      if (!link) {
        pause('Đã ghi nhận thành công nhưng không tìm thấy liên kết "Gửi ý kiến phản hồi khác". Không tự đoán đường dẫn.', 'warn');
        return;
      }
      banner('Đã xác nhận thành công. Tự bấm "Gửi ý kiến phản hồi khác" để xử lý bài tiếp theo.', 'ok');
      // Đây là chính liên kết trả về của Google Forms, thường giữ /forms/u/3/.
      try { clickOnce(link); }
      catch (error) { pause('Không mở được biểu mẫu mới: ' + error.message, 'err'); }
    } else {
      // Không được reload bằng URL tự xây dựng vì có thể đổi tài khoản.
      pause('Không còn ở trang xác nhận; đã dừng để tránh tải lại bằng tài khoản mặc định.', 'warn');
    }
  }

  async function returnToFirstPage() {
    // Khi bấm Bắt đầu/Tiếp tục ở trang cuối, quay về trang đầu
    // bằng nút Google Forms thật, giữ tài khoản và dữ liệu tab.
    for (let n = 0; n < 15; n++) {
      const back = backBtn();
      if (!back) return;
      const account = accountCheck();
      if (!account.ok) throw new Error(account.msg);
      const before = pageSignature();
      clickOnce(back);
      const changed = await waitFor(() => pageSignature() !== before, 15000, 250);
      if (!changed) throw new Error('Không thể quay về trang đầu của biểu mẫu.');
    }
    throw new Error('Không thể xác định trang đầu sau 15 bước.');
  }

  async function runItem(it, resumeAdvancing = false) {
    if (!resumeAdvancing) {
      // Nếu người dùng đang ở trang cuối, không reload URL.
      // Quay về bằng Quay lại trên chính biểu mẫu.
      await returnToFirstPage();
      it.status = 'RUNNING'; it.phase = 'filling';
      it.seen = []; it.unit = S.unit; it.msg = 'Đang điền biểu mẫu';
      persist(); render();
    }
    const seen = new Set(it.seen || []);
    const want = wantFor(it);
    for (let page = 0; page < 15; page++) {
      if (!liveRunning()) {
        if (it.phase !== 'clicked') setItem(it, 'PENDING', 'Đã dừng trước khi bấm Gửi');
        releaseLock();
        return;
      }
      const button = await waitFor(() => nextBtn() || submitBtn(), 16000);
      if (!button) throw new Error('Không tìm thấy nút Tiếp hoặc Gửi ở trang hiện tại');
      const account = accountCheck();
      if (!account.ok) throw new Error(account.msg);

      const scan = scanPage();
      if (scan.errors.length) throw new Error(scan.errors.join('; '));
      // Mỗi trường được điền và kiểm tra lại ở ngay trang chứa câu hỏi.
      for (const key of FIELDS) {
        const q = scan.fields[key];
        if (!q) continue;
        if (!liveRunning()) {
          setItem(it, 'PENDING', 'Đã tạm dừng trước khi bấm Gửi');
          releaseLock();
          return;
        }
        await setField(q, want[key]);
        const actual = readField(q);
        if (nfc(actual) !== nfc(want[key])) {
          throw new Error(`Đối chiếu trường “${LABELS[key]}” thất bại: nhận được “${actual}”`);
        }
        seen.add(key);
        it.seen = [...seen];
        it.msg = 'Đã xác minh: ' + it.seen.map(k => LABELS[k]).join(', ');
        persist(); render();
      }
      const submit = submitBtn();
      if (submit) {
        const missing = FIELDS.filter(key => !seen.has(key));
        if (missing.length) throw new Error('Chưa gặp đủ câu hỏi: ' + missing.map(k => LABELS[k]).join(', '));
        if (!liveRunning()) return;
        // Lưu phase trước khi gửi. Nếu trang reload, KHÔNG tự gửi lại dòng này.
        it.phase = 'clicked'; it.time = nowStr(); it.msg = 'Đã bấm Gửi; chờ xác nhận';
        persist(); render();
        clickOnce(submit);
        await waitForConfirmation(it);
        return;
      }
      const next = nextBtn();
      if (!next) throw new Error('Không còn nút Tiếp/Gửi');
      const signature = pageSignature();
      it.phase = 'advancing'; it.msg = `Chuyển trang ${page + 1} → ${page + 2}`;
      persist(); render();
      clickOnce(next);
      const changed = await waitFor(() => pageSignature() !== signature, 15000, 250);
      if (!changed) {
        const err = validationError();
        throw new Error('Không chuyển được sang trang kế tiếp' + (err ? ': ' + err : ''));
      }
      it.phase = 'filling';
      persist();
    }
    throw new Error('Biểu mẫu có quá nhiều trang (>15); đã dừng để kiểm tra');
  }

  async function engine() {
    if (busy || S.status !== 'running') return;
    busy = true;
    try {
      if (!isPinned()) return pause('Đây không phải biểu mẫu đã ghim.');
      if (!profileComplete()) return pause('Chưa nhập đủ thông tin người gửi.');
      if (!UNITS.includes(S.unit)) return pause('Chưa chọn đơn vị hợp lệ.');
      if (!(await takeLock())) {
        banner('Một tab khác đang chạy phiên này; tab này chỉ theo dõi.', 'warn');
        return;
      }
      // Kiểm tra trước khi chuyển PENDING -> RUNNING.
      // Nếu sai tài khoản, giữ nguyên các bài chưa gửi, không FAILED.
      const account = accountCheck();
      if (!account.ok) {
        for (const item of S.items) {
          if (item.status !== 'RUNNING') continue;
          if (item.phase === 'clicked') {
            item.status = 'REVIEW';
            item.msg = 'Cần kiểm tra kết quả gửi trước khi chuyển tài khoản.';
          } else {
            item.status = 'PENDING';
            item.phase = '';
            item.seen = [];
            item.msg = 'Chưa gửi: cần chuyển về tài khoản sinh viên.';
          }
        }
        pause(account.msg, 'warn');
        return;
      }
      let it;
      while (true) {
        it = S.items.find(i => i.status === 'RUNNING' && i.phase === 'advancing') ||
          S.items.find(i => i.status === 'PENDING');
        if (!it) {
          S.status = 'done'; persist(); releaseLock(); render();
          banner('Không còn dòng PENDING.', 'ok');
          return;
        }
        const previous = hist()[it.key];
        const duplicate = S.items.find(other => other !== it && other.key && other.key === it.key &&
          ['SUCCESS', 'RUNNING', 'REVIEW'].includes(other.status));
        if (!previous && !duplicate) break;
        setItem(it, 'SKIPPED', previous ? 'Đã ghi nhận gửi thành công trước đó' : 'Trùng dòng khác trong phiên');
      }
      await runItem(it, it.status === 'RUNNING' && it.phase === 'advancing');
    } catch (error) {
      const active = S.items.find(i => i.status === 'RUNNING');
      if (active) {
        if (active.phase === 'clicked') setItem(active, 'REVIEW', 'Không rõ kết quả sau khi bấm Gửi: ' + error.message);
        else setItem(active, 'FAILED', 'Chưa bấm Gửi: ' + error.message);
      }
      pause('Đã dừng: ' + error.message, 'err');
    } finally {
      busy = false;
    }
  }

  // === GIAO DIỆN ===
  const host = el('div');
  host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  const css = `
    *{box-sizing:border-box;font:12px Segoe UI,Arial,sans-serif;color:#1d293b}
    .panel{width:480px;max-width:96vw;max-height:92vh;overflow:auto;background:#fff;border:1px solid #cbd5e1;border-radius:10px;box-shadow:0 8px 30px #0004}
    .head{display:flex;align-items:center;justify-content:space-between;background:#153e75;padding:9px 11px;position:sticky;top:0;z-index:1;cursor:move}
    .head b{color:white;font-size:13px}.head button{color:white;background:none;border:0;font-size:18px;cursor:pointer}
    .sec{padding:9px 11px;border-bottom:1px solid #e2e8f0}.sec h4{margin:0 0 7px;color:#64748b;font-weight:700;font-size:11px}
    .g{display:grid;grid-template-columns:105px 1fr;gap:4px 7px}.g span:nth-child(odd){color:#64748b}
    textarea{width:100%;height:88px;resize:vertical;border:1px solid #cbd5e1;border-radius:6px;padding:7px}
    select,input[type=number],input[type=text]{padding:5px;border:1px solid #cbd5e1;border-radius:6px;max-width:100%}select.unit{width:100%}
    .profile{width:100%}.req{color:#b42318;font-weight:700}
    button.b{margin:2px 2px 0 0;border:1px solid #174178;background:white;border-radius:6px;color:#174178;padding:5px 7px;cursor:pointer}
    button.b.primary{background:#174178;color:white}button.b.danger{color:#b42318;border-color:#b42318}
    button.b:disabled{cursor:not-allowed;opacity:.4}.mini{font-size:11px!important;padding:2px 4px!important}
    .banner{margin:0;padding:7px 10px;white-space:pre-wrap;font-weight:600}.info{background:#eaf2ff;color:#1e40af}.warn{background:#fff3d7;color:#92400e}.err{background:#fee4e2;color:#b42318}.ok{background:#e4f8e9;color:#166534}
    .small{font-size:11px;white-space:pre-line;color:#475569;margin-top:6px}
    .tablewrap{max-height:250px;overflow:auto}table{width:100%;border-collapse:collapse;margin-top:7px}
    th,td{padding:4px;border:1px solid #e2e8f0;vertical-align:top;word-break:break-all}th{background:#f1f5f9;text-align:left}
    .SUCCESS{color:#15803d;font-weight:700}.FAILED{color:#b42318;font-weight:700}.REVIEW{color:#b45309;font-weight:700}
    .RUNNING{color:#1d4ed8;font-weight:700}.PENDING{color:#475569}.SKIPPED{color:#64748b}
  `;
  const $ = {};
  function button(title, fn, cls = '') { return el('button', { class: 'b ' + cls, onclick: fn, type: 'button' }, title); }
  function build() {
    $.banner = el('p', { class: 'banner info', style: 'display:none' });
    $.pin = el('div');
    $.profileFields = {};
    const profileInput = (key, placeholder) => {
      const input = el('input', { type: 'text', class: 'profile', value: PROFILE[key], placeholder });
      input.addEventListener('change', () => {
        PROFILE[key] = trim(input.value);
        input.value = PROFILE[key];
        saveProfile(); render();
      });
      $.profileFields[key] = input;
      return input;
    };
    $.unit = el('select', { class: 'unit' },
      el('option', { value: '' }, '— Chọn đơn vị —'),
      ...UNITS.map(u => el('option', { value: u }, u)));
    $.unit.addEventListener('change', () => { S.unit = $.unit.value; persist(); render(); });
    $.delay = el('input', { type: 'number', min: 2, max: 60, value: S.delaySec, style: 'width:65px' });
    $.delay.addEventListener('change', () => {
      S.delaySec = Math.min(60, Math.max(2, Number($.delay.value) || 4));
      $.delay.value = S.delaySec;
      persist();
    });
    $.ta = el('textarea', { placeholder: 'Mỗi dòng là một link bài viết Facebook…' });
    $.sum = el('div', { class: 'small' });
    $.filter = el('select', {}, el('option', { value: '' }, 'Tất cả'),
      ...['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'REVIEW', 'SKIPPED']
        .map(s => el('option', { value: s }, s)));
    $.filter.addEventListener('change', render);
    $.tbody = el('tbody');
    $.stats = el('div', { class: 'small' });
    $.exp = el('select', {}, el('option', { value: 'csv' }, 'CSV'), el('option', { value: 'json' }, 'JSON'));
    $.buttons = {
      check: button('KIỂM TRA DỮ LIỆU', onCheck),
      start: button('BẮT ĐẦU GỬI', onStart, 'primary'),
      pause: button('TẠM DỪNG', onPause),
      resume: button('TIẾP TỤC', onResume),
      stop: button('DỪNG', onStop, 'danger'),
      retry: button('GỬI LẠI DÒNG LỖI', onRetry),
      export: button('XUẤT BÁO CÁO', onExport),
      wipe: button('YÊU CẦU XÓA DỮ LIỆU', onWipe, 'danger')
    };
    const content = el('div', {},
      el('div', { class: 'sec' }, el('h4', {}, 'A — THÔNG TIN NGƯỜI GỬI (TỰ NHẬP)'),
        el('div', { class: 'g' },
          el('span', {}, 'Họ tên *'), profileInput('name', 'Nhập họ và tên'),
          el('span', {}, 'MSSV *'), profileInput('mssv', 'Nhập mã số sinh viên'),
          el('span', {}, 'Lớp *'), profileInput('cls', 'Nhập lớp'),
          el('span', {}, 'Khoa *'), profileInput('faculty', 'Nhập khoa'),
          el('span', {}, 'Thể loại *'), profileInput('category', 'Ví dụ: Hình ảnh')),
        el('div', { class: 'small' }, `Tài khoản Google đang dùng phải có đuôi ${REQUIRED_EMAIL_DOMAIN}. Thông tin trên chỉ lưu trong Tampermonkey của máy này.`)),
      el('div', { class: 'sec' }, el('h4', {}, 'B — ĐƠN VỊ CHUNG VÀ ĐIỀU KIỆN CHẠY'),
        $.unit, el('div', { style: 'margin-top:6px' }, 'Độ trễ giữa lượt (giây): ', $.delay), $.pin),
      el('div', { class: 'sec' }, el('h4', {}, 'C — DANH SÁCH LINK'), $.ta, $.sum),
      el('div', { class: 'sec' }, el('h4', {}, 'D — TIẾN TRÌNH'), el('span', {}, 'Bộ lọc: '), $.filter,
        el('div', { class: 'tablewrap' }, el('table', {},
          el('thead', {}, el('tr', {}, ...['STT', 'LINK', 'TRẠNG THÁI', 'THỜI GIAN', 'KẾT QUẢ', ''].map(x => el('th', {}, x)))),
          $.tbody)), $.stats),
      el('div', { class: 'sec' }, el('h4', {}, 'E — ĐIỀU KHIỂN'),
        $.buttons.check, $.buttons.start, $.buttons.pause, $.buttons.resume,
        $.buttons.stop, $.buttons.retry, $.buttons.export, $.exp, $.buttons.wipe));
    $.content = content;
    const minimizer = el('button', { title: 'Thu gọn' }, '–');
    minimizer.addEventListener('click', () => { content.hidden = !content.hidden; });
    const header = el('div', { class: 'head' }, el('b', {}, 'Hành Động Đẹp – Google Forms V2.4'), minimizer);
    root.append(el('style', {}, css), el('div', { class: 'panel' }, header, $.banner, content));
    let drag;
    header.addEventListener('mousedown', ev => {
      if (ev.target === minimizer) return;
      drag = { x: ev.clientX, y: ev.clientY, rect: host.getBoundingClientRect() };
      ev.preventDefault();
    });
    window.addEventListener('mousemove', ev => {
      if (!drag) return;
      host.style.left = `${drag.rect.left + ev.clientX - drag.x}px`;
      host.style.top = `${drag.rect.top + ev.clientY - drag.y}px`;
      host.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { drag = null; });
    document.documentElement.append(host);
  }
  function banner(msg, kind = 'info') {
    lastBanner = { msg, kind };
    if (!$.banner) return;
    $.banner.textContent = msg;
    $.banner.className = 'banner ' + kind;
    $.banner.style.display = msg ? '' : 'none';
  }
  function counts() {
    const c = {};
    for (const item of S.items) c[item.status] = (c[item.status] || 0) + 1;
    return c;
  }
  function render() {
    if (!$.tbody) return;
    const running = S.status === 'running';
    const c = counts();
    $.unit.value = S.unit;
    $.unit.disabled = running;
    for (const input of Object.values($.profileFields || {})) input.disabled = running;
    $.delay.disabled = running;
    $.ta.disabled = running;
    $.pin.replaceChildren(isPinned()
      ? el('div', { class: 'small' }, 'Biểu mẫu đã ghim ✓ ', button('Ghim lại', onPin, 'mini'))
      : el('div', { class: 'banner warn' }, 'Biểu mẫu CHƯA được ghim; không được phép gửi. ',
        button('Ghim form này', onPin, 'mini')));
    $.buttons.check.disabled = running;
    const unresolved = (c.REVIEW || 0) > 0 || (c.RUNNING || 0) > 0;
    $.buttons.start.disabled = running || unresolved || !profileComplete() || !isPinned() || !UNITS.includes(S.unit) || !(c.PENDING > 0);
    $.buttons.pause.disabled = !running;
    $.buttons.resume.disabled = S.status !== 'paused' || unresolved || !isPinned() || !(c.PENDING > 0);
    $.buttons.stop.disabled = !['running', 'paused'].includes(S.status);
    $.buttons.retry.disabled = running || !(c.FAILED > 0);
    $.buttons.wipe.disabled = running;
    $.stats.textContent = `Phiên: ${String(S.status).toUpperCase()} | Tổng ${S.items.length} | Thành công ${c.SUCCESS || 0} | Lỗi ${c.FAILED || 0} | Cần kiểm tra ${c.REVIEW || 0} | Bỏ qua ${c.SKIPPED || 0} | Chưa gửi ${c.PENDING || 0}`;
    const filter = $.filter.value;
    $.tbody.replaceChildren(...S.items.map((item, index) => ({ item, index }))
      .filter(x => !filter || x.item.status === filter)
      .map(({ item, index }) => {
        const actions = el('td', {}, button('⧉', () => navigator.clipboard?.writeText(item.raw), 'mini'));
        if (!running && ['PENDING', 'FAILED', 'SKIPPED'].includes(item.status)) {
          actions.append(button('✎', () => editItem(item), 'mini'), button('✕', () => {
            if (!confirm('Xóa dòng này khỏi danh sách?')) return;
            S.items = S.items.filter(x => x !== item); persist(); render();
          }, 'mini'));
        }
        if (!running && item.status === 'REVIEW') {
          actions.append(
            button('↻', () => {
              if (!confirm('Bạn đã kiểm tra hệ thống và XÁC NHẬN CHƯA có phản hồi cho link này? Gửi lại có nguy cơ tạo bản trùng.')) return;
              item.phase = ''; item.seen = [];
              setItem(item, 'PENDING', 'Người dùng xác nhận chưa ghi nhận; cho phép gửi lại');
            }, 'mini'),
            button('✓', () => {
              if (!confirm('Bạn đã xác minh form ĐÃ ghi nhận bài viết này?')) return;
              const hst = hist();
              hst[item.key] = { time: nowStr(), unit: item.unit, url: item.raw, manual: true };
              save(K.hist, hst);
              item.time = nowStr(); item.phase = '';
              setItem(item, 'SUCCESS', 'Người dùng xác nhận thủ công');
            }, 'mini'));
        }
        return el('tr', {},
          el('td', {}, String(index + 1)), el('td', {}, item.raw),
          el('td', { class: item.status }, item.status),
          el('td', {}, item.time || ''), el('td', {}, item.msg || ''), actions);
      }));
  }
  function editItem(item) {
    const raw = prompt('Sửa link bài viết:', item.raw);
    if (raw == null) return;
    const parsed = parseFb(raw);
    item.raw = trim(raw); item.key = parsed.ok ? parsed.key : '';
    item.status = parsed.ok ? 'PENDING' : 'SKIPPED';
    item.phase = ''; item.seen = []; item.msg = parsed.ok ? '' : parsed.why;
    item.time = '';
    persist(); render();
  }
  function onPin() {
    if (!confirm(`Ghim biểu mẫu này?\n${document.title}\nID: ${FORM_ID}`)) return;
    GM_setValue(K.pin, FORM_ID);
    banner('Đã ghim biểu mẫu.', 'ok'); render();
  }
  function onCheck() {
    if (!profileComplete()) {
      return banner('Vui lòng nhập đủ Họ tên, MSSV, Lớp, Khoa và Thể loại trước khi kiểm tra.', 'warn');
    }
    const lines = $.ta.value.split(/\r?\n/);
    const nonempty = lines.map(trim).filter(Boolean);
    const blank = lines.length - nonempty.length;
    const hst = hist();
    const summary = { valid: 0, invalid: 0, dupList: 0, dupHistory: 0 };
    for (const raw of nonempty) {
      const parsed = parseFb(raw);
      const item = {
        id: ++S.seq, raw, key: parsed.ok ? parsed.key : '',
        status: 'PENDING', msg: '', time: '', unit: '', phase: '', seen: []
      };
      if (!parsed.ok) { item.status = 'SKIPPED'; item.msg = parsed.why; summary.invalid++; }
      else if (hst[item.key]) {
        item.status = 'SKIPPED'; item.msg = 'Đã gửi thành công trước đó'; summary.dupHistory++;
      } else if (S.items.some(x => x.key === item.key)) {
        item.status = 'SKIPPED'; item.msg = 'Trùng link trong danh sách'; summary.dupList++;
      } else summary.valid++;
      S.items.push(item);
    }
    $.ta.value = '';
    persist(); render();
    const account = accountCheck();
    $.sum.textContent = `Nhập ${nonempty.length} link (dòng trống ${blank}); hợp lệ mới ${summary.valid}; sai ${summary.invalid}; trùng danh sách ${summary.dupList}; trùng lịch sử ${summary.dupHistory}.\nTổng chờ gửi ${counts().PENDING || 0}.\nTài khoản: ${account.ok ? 'ĐÚNG – ' + account.account : account.msg}`;
    banner(account.ok ? 'Dữ liệu đã kiểm tra. Sẵn sàng bấm BẮT ĐẦU GỬI.' : account.msg,
      account.ok ? 'ok' : 'warn');
  }
  function onStart() {
    if (!profileComplete()) return banner('Vui lòng nhập đủ thông tin người gửi.', 'warn');
    if (!isPinned() || !UNITS.includes(S.unit) || !S.items.some(i => i.status === 'PENDING')) return;
    if (S.items.some(i => ['REVIEW', 'RUNNING'].includes(i.status)))
      return banner('Còn dòng chưa xác định kết quả. Xử lý REVIEW trước khi bắt đầu.', 'warn');
    const account = accountCheck();
    if (!account.ok) return banner(account.msg, 'err');
    const n = counts().PENDING || 0;
    if (!confirm(`XÁC NHẬN BẮT ĐẦU GỬI?\n\n${n} lượt chờ gửi tuần tự.\nNgười gửi: ${PROFILE.name} (${PROFILE.mssv})\nĐơn vị: ${S.unit}\nThể loại: ${PROFILE.category}\nTài khoản: ${account.account}\n\nChỉ gửi khi điều lệ biểu mẫu cho phép nhiều bài. Không tự vượt CAPTCHA.`)) return;
    S.status = 'running'; persist(); render();
    // Chạy trên trang hiện tại, tuyệt đối không reload làm mất tài khoản.
    engine();
  }
  function markUnsubmittedPending() {
    for (const item of S.items) {
      if (item.status !== 'RUNNING' || item.phase === 'clicked') continue;
      item.status = 'PENDING'; item.phase = ''; item.seen = [];
      item.msg = 'Đã dừng trước khi bấm Gửi; có thể khởi động lại';
    }
  }
  function onPause() {
    S.status = 'paused'; markUnsubmittedPending(); persist(); releaseLock();
    banner('Đã yêu cầu tạm dừng. Nếu đã bấm Gửi, chờ xác nhận hoặc kiểm tra REVIEW.', 'warn'); render();
  }
  function onResume() {
    if (!profileComplete()) return banner('Vui lòng nhập đủ thông tin người gửi.', 'warn');
    if (!isPinned() || !UNITS.includes(S.unit) || !S.items.some(i => i.status === 'PENDING')) return;
    if (S.items.some(i => ['REVIEW', 'RUNNING'].includes(i.status)))
      return banner('Vui lòng xử lý dòng REVIEW/đang chờ xác nhận trước khi tiếp tục.', 'warn');
    const account = accountCheck();
    if (!account.ok) return banner(account.msg, 'err');
    S.status = 'running'; persist(); render();
    // Không reload: nếu đang ở trang 2, engine sẽ dùng nút Quay lại.
    engine();
  }
  function onStop() {
    if (!confirm('Dừng phiên? Những lượt đã bấm Gửi không thể thu hồi.')) return;
    S.status = 'stopped'; markUnsubmittedPending(); persist(); releaseLock();
    banner('Đã dừng. Giữ nguyên dữ liệu để kiểm tra.', 'warn'); render();
  }
  function onRetry() {
    let count = 0;
    for (const item of S.items) {
      if (item.status !== 'FAILED') continue;
      item.status = 'PENDING'; item.phase = ''; item.seen = [];
      item.msg = 'Chờ gửi lại'; count++;
    }
    persist(); render();
    banner(`Đã chuyển ${count} dòng FAILED về PENDING. Dòng REVIEW không được tự thử lại.`, 'info');
  }
  function onWipe() {
    if (S.status === 'running') return;
    if (!confirm('Xóa danh sách link và trạng thái phiên hiện tại?')) return;
    releaseLock();
    S = defState(); persist();
    if (prompt('Xóa cả LỊCH SỬ chống trùng? Gõ chính xác XOA, hoặc để trống để giữ:') === 'XOA')
      GM_deleteValue(K.hist);
    $.sum.textContent = '';
    render(); banner('Đã xóa dữ liệu theo yêu cầu.', 'info');
  }
  function onExport() {
    const rows = S.items.map((item, index) => ({
      STT: index + 1,
      'LINK FACEBOOK': item.raw,
      'CLB/TỔ/ĐỘI/NHÓM': item.unit || S.unit || '',
      'THỂ LOẠI': PROFILE.category,
      'TRẠNG THÁI': item.status,
      'THỜI GIAN': item.time || '',
      'THÔNG BÁO KẾT QUẢ': item.msg || ''
    }));
    const c = counts();
    const stats = {
      'Tổng link': rows.length,
      'Đã gửi thành công': c.SUCCESS || 0,
      'Gửi lỗi': c.FAILED || 0,
      'Cần kiểm tra': c.REVIEW || 0,
      'Bỏ qua': c.SKIPPED || 0,
      'Chưa gửi': c.PENDING || 0
    };
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    let blob, name;
    if ($.exp.value === 'json') {
      blob = new Blob([JSON.stringify({ formId: FORM_ID, account: currentAccount(), profile: PROFILE, stats, rows }, null, 2)],
        { type: 'application/json;charset=utf-8' });
      name = `hdd-bao-cao-${stamp}.json`;
    } else {
      const head = ['STT', 'LINK FACEBOOK', 'CLB/TỔ/ĐỘI/NHÓM', 'THỂ LOẠI', 'TRẠNG THÁI', 'THỜI GIAN', 'THÔNG BÁO KẾT QUẢ'];
      const quote = raw => {
        let s = String(raw ?? '');
        if (/^\s*[=+\-@]/.test(s)) s = "'" + s; // hạn chế CSV formula injection
        return '"' + s.replace(/"/g, '""') + '"';
      };
      const lines = [head.map(quote).join(','), ...rows.map(row => head.map(key => quote(row[key])).join(',')),
        '', ...Object.entries(stats).map(([key, value]) => `${quote(key)},${quote(value)}`)];
      blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      name = `hdd-bao-cao-${stamp}.csv`;
    }
    const objectUrl = URL.createObjectURL(blob);
    const a = el('a', { href: objectUrl, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
  }

  // === KHỞI ĐỘNG VÀ PHỤC HỒI ===
  build(); render();
  if (typeof GM_registerMenuCommand === 'function')
    GM_registerMenuCommand('Hiện/ẩn bảng điều khiển', () => {
      host.style.display = host.style.display === 'none' ? '' : 'none';
    });
  (async () => {
    // Không kết luận quá sớm khi Google Forms đang chuyển trang.
    await waitFor(() => isConfirmation() || nextBtn() || submitBtn(), 12000);
    S = Object.assign(defState(), load(K.state, {}));
    if (!Array.isArray(S.items)) S.items = [];
    if (!UNITS.includes(S.unit)) S.unit = DEFAULT_UNIT;
    render();
    if (isConfirmation()) {
      const item = S.items.find(i => i.status === 'RUNNING' && i.phase === 'clicked');
      if (item) {
        const hst = hist();
        hst[item.key] = { time: nowStr(), unit: item.unit, url: item.raw };
        save(K.hist, hst);
        item.time = nowStr(); item.phase = '';
        setItem(item, 'SUCCESS', 'Trang xác nhận Google Forms: đã ghi nhận câu trả lời');
      }
      if (S.status === 'running') {
        if (!(await takeLock())) return banner('Tab khác đang điều khiển phiên.', 'warn');
        await scheduleNext();
      }
      return;
    }
    restoreInterrupted(); render();
    if (S.status === 'running') engine();
    else if (S.items.some(i => i.status === 'REVIEW'))
      banner('Có dòng REVIEW: ↻ khi xác minh CHƯA ghi nhận, ✓ khi xác minh ĐÃ ghi nhận.', 'warn');
    else if (!accountCheck().ok)
      banner(accountCheck().msg, 'warn');
  })().catch(error => { banner('Lỗi khởi động: ' + error.message, 'err'); });
})();
