// ==UserScript==
// @name         Bộ Tool Sinh Viên - Facebook V5 + Hành Động Đẹp
// @namespace    https://github.com/tranhoang-201207/student-tools-share
// @version      1.0.0
// @description  Một Loader cho Facebook V5 và Google Form Hành Động Đẹp, có bật/tắt từ xa.
// @match        https://www.facebook.com/*
// @match        https://web.facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://docs.google.com/forms/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @require      https://raw.githubusercontent.com/tranhoang-201207/student-tools-share/main/facebook-v5.js
// @require      https://raw.githubusercontent.com/tranhoang-201207/student-tools-share/main/hanh-dong-dep.js
// ==/UserScript==

// Hai mô-đun tự nhận diện website và kiểm tra công tắc trong status.json.
