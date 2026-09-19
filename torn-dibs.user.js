// ==UserScript==
// @name         Torn RW DIBS
// @namespace    https://github.com/deyandimonov/torn-dibs-userinterface
// @version      1.3.5
// @description  Torn Ranked War DIBS helper
// @author       Deyan Dimonov
// @license      SEE LICENSE.md
// @match        https://www.torn.com/factions.php*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.torn.com
// License terms and notices:
// https://github.com/deyandimonov/torn-dibs-userinterface/blob/main/LICENSE.md#notices
// @description  Shared faction DIBS for Torn Ranked Wars. Enemy side only, server-authoritative lifecycle.
// ==/UserScript==
/*
 * DESIGN RULES (do not break these when editing)
 *
 * 1. NO THIRD-PARTY DEPENDENCIES.
 *    Never read, copy or position against classes created by other
 *    userscripts (FF Scouter, Torn Tools, TornPDA). A faction mate with a
 *    clean browser must get the same result.
 *
 *    Torn's war roster uses CSS-module classes with build-specific hashed
 *    suffixes ("enemy___dUgtm", "member___tEskU"). Those change on any Torn
 *    deploy, so we NEVER match on them. We rely only on:
 *      - the stable unhashed class TOKENS "enemy" and "member",
 *      - the profile link href "profiles.php?XID=...",
 *      - the link's aria-label ("View profile of <name>").
 *    A row is the closest ancestor with the "enemy" token to a profile link.
 *    The faction header also carries "enemy" but has no profile link, so it
 *    is never mistaken for a row.
 *
 * 2. NO LAYOUT SURGERY, EVER.
 *    The badge is a pure overlay. The row gets position:relative (which
 *    changes nothing about layout) and the badge is position:absolute on
 *    top. Nothing is resized, padded, cleared or reflowed. Earlier attempts
 *    at a real column killed the Level cell; a full-width bar covered TWSE's
 *    "Stats Estimate"; padding on the row collapsed the whole float layout.
 *
 * 3. ENEMY SIDE ONLY. Our own roster is never touched.
 *
 * 4. OWN NAMESPACE. Everything we create is prefixed "tdibs-".
 *
 * 5. THE SERVER OWNS THE LIFECYCLE.
 *    We never send expires_at and never assert who we are. Identity comes
 *    from the Torn key we already hold; expiry is decided by the backend
 *    from crowd-verified status. We just claim, release, and report what
 *    we can see.
 */

(() => {
  "use strict";

  const VERSION = "2.1.0";

  // Userscript managers run this in a sandbox: the `window` inside this
  // closure is a proxy, not the page's real window. DevTools evaluates
  // against the page, so anything attached only to our `window` is invisible
  // from the console. unsafeWindow is the way back to the real page context.
  const pageWindow = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;

  // Torn PDA runs userscripts in the page context and does not implement GM_*.
  // Where a real userscript manager (Tampermonkey/Greasemonkey) is present the
  // bare GM_* identifiers resolve inside the sandbox and every `typeof` guard
  // below is "function" - the block is a complete no-op and browser behaviour
  // is untouched. In PDA the guards see "undefined" and we polyfill onto the
  // page window, where PDA's flat scope makes the bare identifier resolve.
  (function polyfillGMforPDA() {
    const w = pageWindow;
    const readLocal = (key, def) => {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return def;
        if (raw.startsWith("GMV2_")) {
          const json = raw.slice(5);
          if (json === "undefined") return def;
          try { return JSON.parse(json); } catch { return raw; }
        }
        return raw;
      } catch { return def; }
    };
    const writeLocal = (key, val) => {
      try {
        const s = JSON.stringify(val);
        if (s === undefined) { localStorage.removeItem(key); return; }
        localStorage.setItem(key, "GMV2_" + s);
      } catch {}
    };
    if (typeof GM_getValue !== "function") {
      w.GM_getValue = (key, def) => readLocal(key, def);
    }
    if (typeof GM_setValue !== "function") {
      w.GM_setValue = (key, val) => writeLocal(key, val);
    }
    if (typeof GM_deleteValue !== "function") {
      w.GM_deleteValue = key => { try { localStorage.removeItem(key); } catch {} };
    }
    if (typeof GM_registerMenuCommand !== "function") {
      w.GM_registerMenuCommand = () => {};
    }
    if (typeof GM_xmlhttpRequest !== "function") {
      w.GM_xmlhttpRequest = opts => {
        const method = String((opts && opts.method) || "GET").toUpperCase();
        const url = opts && opts.url;
        const headers = (opts && opts.headers) || {};
        const raw = opts && opts.data;
        const bodyStr = raw === undefined ? undefined :
          (typeof raw === "string" ? raw : JSON.stringify(raw));

        const done = r => {
          if (!opts || typeof opts.onload !== "function") return;
          try {
            opts.onload({
              status: Number((r && r.status) || 0),
              responseText: String((r && (r.responseText != null ? r.responseText : r.text)) || ""),
              responseHeaders: String((r && r.responseHeaders) || ""),
              statusText: String((r && r.statusText) || ""),
            });
          } catch {}
        };
        const fail = e => {
          const msg = (e && e.message) || String(e || "");
          try {
            if (/timeout/i.test(msg) && opts && typeof opts.ontimeout === "function") opts.ontimeout(e);
            else if (opts && typeof opts.onerror === "function") opts.onerror(e);
          } catch {}
        };

        let p;
        if (method === "GET"    && typeof PDA_httpGet    === "function") p = PDA_httpGet(url, headers);
        else if (method === "POST"   && typeof PDA_httpPost   === "function") p = PDA_httpPost(url, headers, bodyStr);
        else if (method === "PUT"    && typeof PDA_httpPut    === "function") p = PDA_httpPut(url, headers, bodyStr);
        else if (method === "DELETE" && typeof PDA_httpDelete === "function") p = PDA_httpDelete(url, headers);
        else if (method === "PATCH"  && typeof PDA_httpPatch  === "function") p = PDA_httpPatch(url, headers, bodyStr);
        else p = fetch(url, { method, headers, body: bodyStr })
          .then(res => res.text().then(t => ({ status: res.status, responseText: t })));

        Promise.resolve(p).then(done).catch(fail);
        return { abort() {} };
      };
    }
  })();

  // Two enabled copies fighting over the same DOM is what makes this look
  // "reverted" to an older, broken rendering style.
  if (pageWindow.__tornDibsActiveVersion) {
    console.warn(
      `[Torn DIBS] another instance (v${pageWindow.__tornDibsActiveVersion}) is already ` +
      `running. Skipping. Disable the duplicate in your userscript manager and hard-reload.`);
    return;
  }
  pageWindow.__tornDibsActiveVersion = VERSION;

  const CONFIG = {
    TORN_API_BASE: "https://api.torn.com/v2",

    POLL_MS: 4000,          // refresh dibs + push our status readings
    TORN_SYNC_MS: 60000,    // re-resolve identity and current war

    // Show the UI using the most recent war when none is active, for testing.
    DEBUG_SHOW_WITHOUT_ACTIVE_WAR: true,

    // --- badge placement (carried over verbatim from v1.9.3) --------------
    // "left-icon" hangs off the ".member" cell corner, which is exactly where
    // Torn draws the online-status dot and faction icon, at the far left of
    // the row before the avatar. "member" is a stable unhashed class token.
    //   other options: "avatar" | "status" | "row"
    ANCHOR: "left-icon",
    SIDE: "left",       // "left" | "right"
    VSIDE: "bottom",    // "top" | "bottom"

    // All badge dimensions are RELATIVE to the row they sit on, so different
    // monitors, DPRs and PDA all get proportional sizing. Absolute clamps
    // stop the badge from becoming unreadable at extremes.
    BADGE_W_PCT: 0.35,   // fraction of the row's width
    BADGE_W_MIN: 90,     // px floor - unreadable below this
    BADGE_W_MAX: 200,    // px ceiling - would cover too much of the row
    BADGE_H_PCT: 0.65,   // fraction of the row's height
    BADGE_H_MIN: 13,
    BADGE_H_MAX: 22,

    NUDGE_X: 0,          // px offset from the anchor corner, horizontally
    NUDGE_Y_PCT: -0.83,  // fraction of badge height; negative = hang below

    ROW_TINT: true,

    // Announce successful claims in Torn's faction chat as
    // "🎯 TargetName [ID] DIBS". Set false to stay silent.
    CHAT_ANNOUNCE: true,

    // Settings button position. Percent so it tracks the viewport rather
    // than sitting at a fixed pixel offset on tall monitors.
    BTN_TOP: "15%",
    BTN_RIGHT: "14px",
  };

  // Torn PDA's own top chrome sits higher on the viewport than the desktop
  // navbar, so the 15% default lands the button on top of PDA UI. Lift it.
  const IS_PDA = typeof PDA_httpGet === "function" ||
    !!(pageWindow && pageWindow.flutter_inappwebview);
  if (IS_PDA) {
    CONFIG.BTN_TOP = "20%";
    // PDA rows are much shorter and narrower than desktop, so the desktop
    // ratios overshoot. Smaller %s and tighter clamps keep the badge legible
    // without covering the whole row.
    CONFIG.BADGE_W_PCT = 0.40;
    CONFIG.BADGE_W_MIN = 70;
    CONFIG.BADGE_W_MAX = 140;
    CONFIG.BADGE_H_PCT = 0.30;
    CONFIG.BADGE_H_MIN = 10;
    CONFIG.BADGE_H_MAX = 16;
    // Row layout in PDA is denser; hanging the badge as far below on PDA
    // as on desktop parks it outside the row. Cut the drop roughly in half.
    CONFIG.NUDGE_Y_PCT = -0.33;
  }

  // Glyphs chosen for width: these render narrow in Arial, so they cost
  // roughly one character each. At BADGE_W=38 that is the entire budget
  // beside a four-letter word, which is why they are paired with a hair
  // space rather than a normal one.
  const GAP = "\u200A";   // hair space - narrower than a normal space
  const ICON = {
    free:   "\u25C6",   // ◆  available
    mine:   "\u2714",   // ✔  yours
    other:  "\u26D4",   // ⛔ taken by someone else
    busy:   "\u22EF",   // ⋯  in flight
    idle:   "\u2699",   // ⚙  needs setup
    online: "\u26A1",   // ⚡ awake, hit on sight
  };

  const KEYS = {
    API_BASE: "tornDibsApiBase",
    SHARED_TOKEN: "tornDibsSharedToken",
    TORN_API_KEY: "tornDibsApiKey",
  };

  const state = {
    myId: 0, myName: "", factionId: 0, enemyFactionId: 0,
    rankedWarId: 0, warStart: 0, warEnd: 0,
    dibs: new Map(),
    tornLastSync: 0, tornSyncPromise: null,
    setupOpen: false, writing: false,
    rowsSeen: 0, badgesDrawn: 0, reportsSent: 0,
    lastError: "", widthWarned: false,
  };

  // Per-row cache. Holds the status cell reference (so we don't rescan the
  // whole row DOM every render) and the last row geometry we positioned
  // against, so we can skip layout-thrashing offset reads when nothing has
  // resized. WeakMap = auto-cleaned when the row leaves the DOM.
  const rowCache = new WeakMap();
  const getRowCache = row => {
    let c = rowCache.get(row);
    if (!c) { c = {}; rowCache.set(row, c); }
    return c;
  };

  const log = (...a) => console.log("[Torn DIBS]", ...a);
  const err = (...a) => console.error("[Torn DIBS]", ...a);

  /* ---------------------------------------------------------------- storage */

  const get = k => { try { return String(GM_getValue(k, "") || "").trim(); } catch { return ""; } };
  const put = (k, v) => { try { GM_setValue(k, String(v || "").trim()); } catch {} };
  const drop = k => { try { GM_deleteValue(k); } catch {} };

  const apiBase = () => get(KEYS.API_BASE).replace(/\/+$/, "");
  const token = () => get(KEYS.SHARED_TOKEN);

  // Torn PDA substitutes this literal at load time with the current user's
  // API key. In a normal browser / userscript manager it stays as the raw
  // placeholder string, which we detect and treat as "no PDA key available".
  const PDA_APIKEY_INJECTED = "###PDA-APIKEY###";
  const pdaApiKey = () =>
    (IS_PDA && !/^#{3}.*#{3}$/.test(PDA_APIKEY_INJECTED)) ? PDA_APIKEY_INJECTED : "";
  const apiKey = () => get(KEYS.TORN_API_KEY) || pdaApiKey();
  const isConfigured = () => !!(apiBase() && token() && apiKey());

  /* ------------------------------------------------------------------- http */

  function request(method, url, headers = {}, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers,
        data: body === undefined ? undefined : JSON.stringify(body),
        timeout: 15000,
        onload: r => {
          let data = {};
          try { data = JSON.parse(r.responseText || "{}"); } catch {}
          resolve({ status: r.status, data, text: r.responseText || "" });
        },
        onerror: () => reject(new Error(`request failed: ${method} ${url}`)),
        ontimeout: () => reject(new Error(`request timeout: ${method} ${url}`)),
        onabort: () => reject(new Error(`request aborted: ${method} ${url}`)),
      });
    });
  }

  // X-Torn-Key is what proves who we are. The shared token only gates access
  // to the service - everyone in the faction has it, so it identifies nobody.
  const api = (method, path, body) => request(method, apiBase() + path, {
    "Content-Type": "application/json",
    "X-Dibs-Token": token(),
    "X-Torn-Key": apiKey(),
  }, body);

  const tornApi = path => {
    const key = apiKey();
    if (!key) return Promise.reject(new Error("No Torn API key configured"));
    return request("GET", CONFIG.TORN_API_BASE + path, {
      "Accept": "application/json",
      "Authorization": `ApiKey ${key}`,
    });
  };

  /* ------------------------------------------------------------------ style */

  function installStyle() {
    document.getElementById("tdibs-style")?.remove();
    const s = document.createElement("style");
    s.id = "tdibs-style";
    s.textContent = `
      /* PURE OVERLAY. The only thing applied to Torn's own row is
         position:relative, which establishes a containing block without
         changing size, spacing, flow or float behaviour. The badge is
         position:absolute so it is out of flow entirely and cannot push,
         shrink or wrap anything - including TWSE's "Stats Estimate" line,
         which stays visible whether or not the viewer has that script. */
      .tdibs-host{ position:relative !important; }

      .tdibs-badge{
        position:absolute !important;
        z-index:50 !important;
        /* Dimensions live in CSS variables set per-badge by positionBadge,
           so each row gets sizing proportional to its own width/height.
           Width is still pinned four ways so no stray rule can stretch us
           back into a full-width bar over Level/FF/Score/Status/Attack. */
        width:var(--tdibs-w,150px) !important;
        min-width:var(--tdibs-w,150px) !important;
        max-width:var(--tdibs-w,150px) !important;
        flex:0 0 var(--tdibs-w,150px) !important;
        inset:auto !important;
        float:none !important;
        clear:none !important;
        height:var(--tdibs-h,15px) !important;
        line-height:calc(var(--tdibs-h,15px) - 2px) !important;
        box-sizing:border-box !important;
        display:block !important;
        margin:0 !important;
        padding:0 2px !important;
        /* Tight tracking: negative letter-spacing keeps icon+label inside
           the badge instead of forcing it wider. */
        font-family:Arial,Helvetica,sans-serif !important;
        font-weight:700 !important;
        font-size:var(--tdibs-fs,9px) !important;
        letter-spacing:-.2px !important;
        text-align:center !important;
        text-transform:uppercase !important;
        border-radius:4px !important;
        border:1px solid rgba(0,0,0,.45) !important;
        box-shadow:0 1px 3px rgba(0,0,0,.5),
                   inset 0 1px 0 rgba(255,255,255,.14) !important;
        white-space:nowrap !important;
        overflow:hidden !important;
        text-overflow:ellipsis !important;
        cursor:pointer !important;
        user-select:none !important;
        transition:background .12s ease, box-shadow .12s ease,
                   filter .12s ease, transform .08s ease !important;
      }
      .tdibs-badge:hover{ filter:brightness(1.18) !important; }
      .tdibs-badge:active{ transform:scale(.94) !important; }

      /* Traffic-light semantics: green = free to take, blue = yours,
         red = someone else has it. */
      .tdibs-badge[data-state="free"]{
        background:linear-gradient(180deg,#22c55e,#16a34a) !important;
        color:#fff !important;
        border-color:#14532d !important;
      }
      .tdibs-badge[data-state="mine"]{
        background:linear-gradient(180deg,#3b82f6,#1d4ed8) !important;
        color:#fff !important;
        border-color:#1e3a8a !important;
        box-shadow:0 0 7px 1px rgba(59,130,246,.6),
                   inset 0 1px 0 rgba(255,255,255,.2) !important;
      }
      /* A claimant's name needs more room than a four-letter word, so this
         state alone drops to a smaller, non-uppercase font and reclaims its
         side padding. The badge itself never widens. */
.tdibs-badge[data-state="other"]{
  background:#c92a2a !important;
  color:#fff !important;
  cursor:not-allowed !important;
  /* Names are the only state with real content to fit, so this one gets
     left-aligned small text instead of the centred label styling. */
  text-align:left !important;
  font-size:calc(var(--tdibs-fs,9px) * 0.7) !important;
  letter-spacing:0 !important;
  padding:0 3px !important;
  text-transform:none !important;
}
      .tdibs-badge[data-state="busy"]{
        background:linear-gradient(180deg,#f59e0b,#b45309) !important;
        color:#fff !important;
        cursor:wait !important;
        animation:tdibs-pulse .8s ease-in-out infinite !important;
      }
      .tdibs-badge[data-state="idle"]{
        background:linear-gradient(180deg,#6b7280,#4b5563) !important;
        color:#e5e7eb !important;
      }
      .tdibs-badge[data-state="online"]{
        background:linear-gradient(180deg,#44484f,#2f3338) !important;
        color:#9ca3af !important;
        cursor:not-allowed !important;
      }

      @keyframes tdibs-pulse{ 0%,100%{opacity:1} 50%{opacity:.5} }

      /* Row accents follow the badge: blue for yours, red for taken. */
      .tdibs-mine{ box-shadow:inset 3px 0 #3b82f6 !important; }
      .tdibs-other{ box-shadow:inset 3px 0 #dc2626 !important; }
      ${CONFIG.ROW_TINT ? `
      .tdibs-mine{  background-color:rgba(59,130,246,.10) !important; }
      .tdibs-other{ background-color:rgba(220,38,38,.10) !important; }` : ""}

      /* Settings button. Sits clear of Torn's navbar and of the chat tray
         in the bottom-right corner. */
      #tdibs-btn{
        position:fixed !important;
        right:${CONFIG.BTN_RIGHT} !important;
        top:${CONFIG.BTN_TOP} !important;
        bottom:auto !important;
        z-index:2147483646 !important;
        display:flex !important;
        align-items:center !important;
        gap:5px !important;
        padding:7px 12px !important;
        border:1px solid #5a6169 !important;
        border-radius:6px !important;
        background:linear-gradient(180deg,#3a4048,#23272c) !important;
        color:#dfe3e8 !important;
        font:700 10px Arial,Helvetica,sans-serif !important;
        letter-spacing:.6px !important;
        cursor:pointer !important;
        opacity:.72 !important;
        box-shadow:0 2px 6px rgba(0,0,0,.45),
                   inset 0 1px 0 rgba(255,255,255,.1) !important;
        transition:opacity .15s ease, transform .08s ease,
                   box-shadow .15s ease !important;
      }
      #tdibs-btn:hover{
        opacity:1 !important;
        box-shadow:0 3px 10px rgba(0,0,0,.55),
                   inset 0 1px 0 rgba(255,255,255,.16) !important;
      }
      #tdibs-btn:active{ transform:scale(.95) !important; }

      /* A small status lamp: green when connected to a live war, red when
         the script cannot do its job. Saves opening the panel to check. */
      #tdibs-btn::before{
        content:"" !important;
        width:7px !important; height:7px !important;
        border-radius:50% !important;
        background:#22c55e !important;
        box-shadow:0 0 5px rgba(34,197,94,.9) !important;
        flex:0 0 7px !important;
      }
      #tdibs-btn[data-ok="0"]{
        border-color:#8c2f2f !important;
        color:#ffc9c9 !important;
        opacity:.95 !important;
      }
      #tdibs-btn[data-ok="0"]::before{
        background:#ef4444 !important;
        box-shadow:0 0 5px rgba(239,68,68,.9) !important;
      }

      #tdibs-overlay{
        position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,.68);
        display:flex; align-items:center; justify-content:center;
      }
      #tdibs-overlay .tdibs-box{
        width:380px; max-width:92vw; background:#242424; color:#eee;
        border:1px solid #454545; border-radius:8px; padding:16px;
        font:12px/1.45 Arial,Helvetica,sans-serif;
        box-shadow:0 10px 40px rgba(0,0,0,.6);
      }
      #tdibs-overlay h3{ margin:0 0 4px; font-size:14px; color:#fff; }
      #tdibs-overlay .tdibs-sub{ color:#999; font-size:11px; margin-bottom:12px; }
      #tdibs-overlay label{ display:block; margin-bottom:9px; font-size:11px; color:#bbb; }
      #tdibs-overlay input{
        width:100%; box-sizing:border-box; margin-top:3px; padding:6px 7px;
        background:#1a1a1a; border:1px solid #555; border-radius:4px;
        color:#eee; font-size:12px;
      }
      #tdibs-overlay input:focus{
        outline:none; border-color:#3b82f6;
        box-shadow:0 0 0 2px rgba(59,130,246,.25);
      }
      #tdibs-overlay .tdibs-msg{ font-size:11px; min-height:15px; margin:4px 0 8px; color:#e6a23c; }
      #tdibs-overlay .tdibs-diag{
        font:10px/1.55 Consolas,monospace; color:#8fd7a4; background:#1a1a1a;
        border:1px solid #383838; border-radius:4px; padding:7px 8px;
        margin-bottom:11px; white-space:pre-wrap;
      }
      #tdibs-overlay .tdibs-actions{ display:flex; gap:8px; }
      #tdibs-overlay button{
        flex:1; padding:8px; border-radius:4px; border:1px solid #555;
        background:linear-gradient(180deg,#22c55e,#16a34a); color:#fff;
        font:700 11px Arial,sans-serif; cursor:pointer;
      }
      #tdibs-overlay button.tdibs-secondary{
        background:linear-gradient(180deg,#4b5563,#374151);
      }
      #tdibs-overlay button[disabled]{ opacity:.5; cursor:not-allowed; }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  /* -------------------------------------------------------- legacy cleanup */

  // Older builds injected a real table column, an absolute badge, or a
  // full-width bar. Strip every remnant on upgrade so nothing lingers,
  // double-renders, or re-stretches our badge via a stale stylesheet.
  function purgeLegacy() {
    document.querySelectorAll(
      ".torn-dibs-cell, .torn-dibs-header, .torn-dibs-chip, .torn-dibs-bar, " +
      ".tdibs-bar, #torn-dibs-config-button, #torn-dibs-debug-badge, " +
      "#torn-dibs-style, #torn-dibs-btn, #torn-dibs-overlay"
    ).forEach(el => el.remove());

    for (const tag of document.querySelectorAll("style")) {
      if (tag.id === "tdibs-style") continue;
      const css = tag.textContent || "";
      if (/\.tdibs-(bar|badge|host)|\.torn-dibs-(bar|cell|chip|header)/.test(css)) tag.remove();
    }

    document.querySelectorAll(
      ".torn-dibs-row-own, .torn-dibs-row-other, .torn-dibs-row-mine, " +
      ".torn-dibs-host, .tdibs-side-left, .tdibs-side-right, .torn-dibs-active"
    ).forEach(el => {
      el.classList.remove(
        "torn-dibs-row-own", "torn-dibs-row-other", "torn-dibs-row-mine",
        "torn-dibs-host", "tdibs-side-left", "tdibs-side-right", "torn-dibs-active");
      // Earlier builds set inline padding to "reserve space" - exactly what
      // collapsed Torn's float layout. Remove it explicitly.
      for (const p of ["padding-left", "padding-right", "padding-top",
                       "padding-bottom", "--torn-dibs-stack"]) {
        el.style.removeProperty(p);
      }
    });
  }

  /* ------------------------------------------------------------------ setup */

  function closeSetup() {
    document.getElementById("tdibs-overlay")?.remove();
    state.setupOpen = false;
  }

  function diagText() {
    return [
      `version      : ${VERSION}`,
      `war id       : ${state.rankedWarId || "\u2014"}`,
      `me           : ${state.myName || "\u2014"} [${state.myId || "\u2014"}]`,
      `my faction   : ${state.factionId || "\u2014"}`,
      `enemy        : ${state.enemyFactionId || "\u2014"}`,
      `enemy rows   : ${state.rowsSeen}`,
      `badges drawn : ${state.badgesDrawn}`,
      `active dibs  : ${state.dibs.size}`,
      `reports sent : ${state.reportsSent}`,
      state.lastError ? `last error   : ${state.lastError}` : "",
    ].filter(Boolean).join("\n");
  }

  function openSetup(message = "") {
    if (state.setupOpen) return;
    state.setupOpen = true;

    const o = document.createElement("div");
    o.id = "tdibs-overlay";
    o.innerHTML = `
      <div class="tdibs-box">
        <h3>Torn RW DIBS v${VERSION}</h3>
        <div class="tdibs-sub">Enemy side only. Values stored locally in your userscript manager.</div>
        <label>API base<input id="tdibs-base" type="text" spellcheck="false" autocomplete="off"></label>
        <label>Shared token<input id="tdibs-token" type="password" autocomplete="off"></label>
        <label>Torn PUBLIC API key${pdaApiKey() ? " (optional \u2014 Torn PDA key will be used if blank)" : ""}<input id="tdibs-key" type="password" autocomplete="off"></label>
        <div class="tdibs-msg" id="tdibs-msg"></div>
        <div class="tdibs-diag" id="tdibs-diag"></div>
        <div class="tdibs-actions">
          <button id="tdibs-save">SAVE &amp; CONNECT</button>
          <button id="tdibs-close" class="tdibs-secondary">CLOSE</button>
        </div>
      </div>`;
    document.body.appendChild(o);

    const $ = sel => o.querySelector(sel);
    $("#tdibs-msg").textContent = message;
    $("#tdibs-diag").textContent = diagText();
    $("#tdibs-base").value = apiBase();
    $("#tdibs-token").value = token();
    $("#tdibs-key").value = get(KEYS.TORN_API_KEY);

    $("#tdibs-close").onclick = closeSetup;
    o.addEventListener("click", e => { if (e.target === o) closeSetup(); });

    $("#tdibs-save").onclick = async () => {
      const base = $("#tdibs-base").value.trim().replace(/\/+$/, "");
      const tok = $("#tdibs-token").value.trim();
      const key = $("#tdibs-key").value.trim();
      // In PDA the injected key covers the user-facing field, so only demand
      // it when we have no fallback.
      if (!base || !tok || (!key && !pdaApiKey())) {
        $("#tdibs-msg").textContent = pdaApiKey()
          ? "API base and shared token are required."
          : "All three fields are required.";
        return;
      }

      put(KEYS.API_BASE, base);
      put(KEYS.SHARED_TOKEN, tok);
      put(KEYS.TORN_API_KEY, key);

      $("#tdibs-save").disabled = true;
      $("#tdibs-msg").textContent = "Connecting\u2026";
      try {
        const h = await api("GET", "/health");
        if (h.status !== 200 || !h.data?.ok) {
          throw new Error(`Backend health failed: HTTP ${h.status}`);
        }
        if (h.data.WARNING) log("backend warning:", h.data.WARNING);

        const active = await syncIdentityAndWar(true);
        if (active) { await pushStatus(); await refreshDibs(); }
        render();
        $("#tdibs-diag").textContent = diagText();
        $("#tdibs-msg").textContent = active
          ? "Connected." : "Saved. No Ranked War found right now.";
        $("#tdibs-save").disabled = false;
        if (active) setTimeout(closeSetup, 700);
      } catch (e) {
        state.lastError = e.message || "connect failed";
        $("#tdibs-msg").textContent = state.lastError;
        $("#tdibs-diag").textContent = diagText();
        $("#tdibs-save").disabled = false;
      }
    };
  }

  function installButton() {
    let b = document.getElementById("tdibs-btn");
    if (!b) {
      b = document.createElement("button");
      b.id = "tdibs-btn";
      b.type = "button";
      b.textContent = "DIBS";
      b.title = "Torn RW DIBS \u2014 settings and diagnostics";
      b.onclick = () => openSetup();
      document.body.appendChild(b);
    }
    b.dataset.ok = (isConfigured() && state.rankedWarId) ? "1" : "0";
  }

  /* ----------------------------------------------------------- torn identity */

  async function syncIdentityAndWar(force = false) {
    if (!isConfigured()) return false;
    if (!force && state.rankedWarId &&
        Date.now() - state.tornLastSync < CONFIG.TORN_SYNC_MS) return true;
    if (state.tornSyncPromise) return state.tornSyncPromise;

    state.tornSyncPromise = (async () => {
      const ts = () => Math.floor(Date.now() / 1000);

      const u = await tornApi("/user/basic?striptags=true");
      if (u.status !== 200 || u.data?.error) {
        drop(KEYS.TORN_API_KEY);
        throw new Error(`Torn API rejected the key${u.data?.error?.error ? ` (${u.data.error.error})` : ""}`);
      }
      const basic = u.data?.basic || u.data?.profile || {};
      const userId = Number(basic.id || basic.user_id || 0);
      const userName = String(basic.name || basic.username || "").trim();
      if (!userId || !userName) throw new Error("Torn API did not return user identity");

      const f = await tornApi(`/user/faction?timestamp=${ts()}`);
      if (f.status !== 200 || f.data?.error) throw new Error(`/user/faction failed (${f.status})`);
      const faction = f.data?.faction || f.data?.profile?.faction || {};
      const factionId = Number(faction.id || faction.faction_id || 0);
      if (!factionId) throw new Error("Torn API did not return faction ID");

      const w = await tornApi(`/faction/rankedwars?limit=20&timestamp=${ts()}`);
      if (w.status !== 200 || w.data?.error) throw new Error(`/faction/rankedwars failed (${w.status})`);

      const now = ts();
      const wars = Array.isArray(w.data?.rankedwars) ? w.data.rankedwars : [];
      const mine = wars.filter(x => (x?.factions || []).some(p => Number(p?.id) === factionId));
      const current = mine.find(x => {
        const start = Number(x?.start || 0);
        const end = x?.end == null ? null : Number(x.end);
        return start <= now && (end === null || end > now);
      });
      const selected = current ||
        (CONFIG.DEBUG_SHOW_WITHOUT_ACTIVE_WAR ? (mine[0] || wars[0]) : null);

      state.myId = userId;
      state.myName = userName;
      state.factionId = factionId;
      state.tornLastSync = Date.now();

      if (!selected?.id) {
        state.rankedWarId = 0;
        state.enemyFactionId = 0;
        state.dibs.clear();
        return false;
      }

      const parts = Array.isArray(selected.factions) ? selected.factions : [];
      state.enemyFactionId = Number(parts.find(p => Number(p?.id) !== factionId)?.id || 0);
      state.rankedWarId = Number(selected.id);
      state.warStart = Number(selected.start || 0);
      state.warEnd = selected.end == null ? 0 : Number(selected.end);
      state.lastError = "";

      log(`${userName} [${userId}] faction=${factionId} enemy=${state.enemyFactionId} ` +
          `war=${state.rankedWarId}${current ? "" : " [debug: last ended war]"}`);
      return true;
    })();

    try { return await state.tornSyncPromise; }
    finally { state.tornSyncPromise = null; }
  }

  /* -------------------------------------------------------------- dom lookup */

  const warRoot = () =>
    document.querySelector(".faction-war") || document.querySelector("#factions");

  function enemyRows() {
    const root = warRoot();
    if (!root) return [];
    const rows = new Set();
    for (const link of root.querySelectorAll('a[href*="profiles.php?XID="]')) {
      const row = link.closest(".enemy");
      if (row) rows.add(row);
    }
    return [...rows];
  }

  const rowProfileLink = row => row.querySelector('a[href*="profiles.php?XID="]');

  function targetId(row) {
    // Cache on the row element itself: the XID never changes for a given
    // roster row, and every render + click otherwise re-parses the href.
    const cached = row.dataset.tdibsId;
    if (cached) return Number(cached);
    const a = rowProfileLink(row);
    if (!a) return 0;
    let id;
    try { id = Number(new URL(a.href, location.origin).searchParams.get("XID") || 0); }
    catch { id = Number(String(a.getAttribute("href") || "").match(/[?&]XID=(\d+)/i)?.[1] || 0); }
    if (id) row.dataset.tdibsId = String(id);
    return id;
  }

  function targetName(row) {
    const a = rowProfileLink(row);
    if (a) {
      // Torn renders a plain-text aria-label. Most stable name source there is.
      const m = (a.getAttribute("aria-label") || "").match(/view profile of\s+(.+)/i);
      if (m && m[1].trim()) return m[1].trim();
      const alt = (a.querySelector("img[alt]")?.getAttribute("alt") || "").trim();
      if (alt) return alt;
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return `Player ${targetId(row)}`;
  }

  /* --------------------------------------------------------- status reading */

  // Torn's Status cell has no stable class, but the TEXT it shows is a small,
  // stable set of game states. Same trick as the aria-label: match on plain
  // text Torn has used for years, never on a hashed class name.
  const STATUS_WORDS =
    /^(okay|hospital|jail|traveling|travelling|abroad|federal|fallen)$/i;

  function findStatusCell(row) {
    // Same cell across renders unless Torn re-renders the row, so cache it
    // and only rescan if it fell out of the DOM. Scanning every div/span in
    // the row on every paint was the biggest per-render cost.
    const c = getRowCache(row);
    if (c.statusCell && c.statusCell.isConnected &&
        row.contains(c.statusCell)) return c.statusCell;
    for (const el of row.querySelectorAll("div, span")) {
      if (el.children.length > 0) continue;   // leaf text nodes only
      const txt = (el.textContent || "").trim();
      if (txt && STATUS_WORDS.test(txt)) { c.statusCell = el; return el; }
    }
    c.statusCell = null;
    return null;
  }

  function readRowStatus(row) {
    const id = targetId(row);
    if (!id) return null;

    const text = (findStatusCell(row)?.textContent || "").trim().toLowerCase();
    const state_ =
      /hospital/.test(text) ? "Hospital" :
      /jail|federal/.test(text) ? "Jail" :
      /travel|abroad/.test(text) ? "Traveling" :
      /fallen/.test(text) ? "Fallen" : "Okay";

    // Hospital countdowns render as "12:34" or "1:02:03" somewhere in the row.
    let until = 0;
    if (state_ === "Hospital" || state_ === "Jail") {
      const m = row.textContent.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
      if (m) {
        const secs = m[3]
          ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          : Number(m[1]) * 60 + Number(m[2]);
        until = Math.floor(Date.now() / 1000) + secs;
      }
    }

    // Torn marks the online dot with a colour class on the icon wrapper.
    const dot = row.querySelector('[class*="online"], [class*="idle"]');
    const cls = dot ? dot.className : "";
    const is_online = /online|idle/i.test(cls);

    return { target_id: id, state: state_, until, is_online };
  }

  async function pushStatus() {
    if (!state.rankedWarId || !isConfigured()) return;
    const reports = enemyRows().map(readRowStatus).filter(Boolean);
    if (!reports.length) return;
    try {
      const r = await api("POST", "/api/status",
                          { ranked_war_id: state.rankedWarId, reports });
      if (r.status === 200) state.reportsSent += reports.length;
      else state.lastError = `POST /api/status -> ${r.status}`;
    } catch (e) {
      state.lastError = e?.message || "status push failed";
    }
  }

  /* ------------------------------------------------------------- chat post */

  // Torn's current chat has ONE textarea plus a dropdown "channel toggler"
  // (button[data-testid="dropdown-toggler"], aria-haspopup="listbox") whose
  // text is the currently selected channel: "Faction", "Company", "Trade"...
  // The same data-testid is used elsewhere on the page (war filter panel),
  // so we prefer togglers whose text is one of the known channel names.
  const CHANNEL_LABEL_RE = /^\s*(faction|company|trade|global|help|officer|support)\b/i;
  const FACTION_LABEL_RE = /^\s*faction\b/i;

  function findChannelToggler() {
    const all = document.querySelectorAll(
      'button[data-testid="dropdown-toggler"], button.toggler');
    for (const b of all) {
      if (CHANNEL_LABEL_RE.test((b.textContent || "").trim())) return b;
    }
    return all[0] || null;
  }

  // "Chat is open" iff the chat textarea is in the DOM. The channel toggler
  // (data-testid="dropdown-toggler") is NOT a reliable signal - Torn's war
  // filter panel also uses that testid, so togglers exist even with chat
  // closed. The textarea's stable placeholder is the only truth.
  const isChatOpen = () =>
    !!document.querySelector('textarea[placeholder*="Type your message" i]');

  // Torn's chat launcher is a `<button id="channel_panel_button:faction-<id>"
  // title="Faction">`. The id prefix and title are stable across builds; the
  // id suffix is the viewer's faction id. Clicking it both opens the chat
  // panel (if closed) and selects the Faction channel, so no separate
  // channel switch is needed afterwards.
  function findChatLauncher() {
    return document.querySelector('button[id^="channel_panel_button:faction"]') ||
           document.querySelector('button[id^="channel_panel_button:"][title="Faction" i]') ||
           null;
  }

  // Returns { wasOpen, launcher, openedByUs }. `launcher` is always the
  // faction launcher button when it exists in the DOM; `openedByUs` tells
  // the caller whether we popped the panel open (so we can close it again
  // afterwards) or whether the user already had chat open.
  async function ensureChatOpen() {
    const launcher = findChatLauncher();
    if (isChatOpen()) return { wasOpen: true, launcher, openedByUs: false };
    if (!launcher) return { wasOpen: false, launcher: null, openedByUs: false };
    try { launcher.click(); } catch {}
    const start = Date.now();
    while (Date.now() - start < 1500) {
      await new Promise(r => setTimeout(r, 60));
      if (isChatOpen()) return { wasOpen: false, launcher, openedByUs: true };
    }
    return { wasOpen: false, launcher, openedByUs: true };
  }

  // The chat textarea has a stable placeholder ("Type your message here...")
  // that's been in Torn's chat for years. Torn also opens PRIVATE MESSAGE
  // windows with the exact same placeholder, so `querySelector` alone would
  // happily grab the first PM's textarea and we'd post the DIBS message to
  // whichever player has a PM window open. Distinguish by walking up from
  // each candidate: channel chats contain a `data-testid="dropdown-toggler"`
  // whose text is a channel name; PM windows contain a header with a
  // `data-label="avatar"` link to a Torn profile. Prefer the channel one.
  function findChatTextareaFor(toggler) {
    const candidates = [
      ...document.querySelectorAll('textarea[placeholder*="Type your message" i]'),
    ];
    for (const t of document.querySelectorAll("textarea")) {
      if (/(^|\s)textarea___/.test((t.className || "").toString()) &&
          !candidates.includes(t)) {
        candidates.push(t);
      }
    }

    const inChannelPanel = ta => {
      let el = ta;
      for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
        const dt = el.querySelector?.(
          'button[data-testid="dropdown-toggler"]');
        if (dt && CHANNEL_LABEL_RE.test((dt.textContent || "").trim())) return true;
      }
      return false;
    };
    const inPMPanel = ta => {
      let el = ta;
      for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
        if (el.querySelector?.(
          'a[data-label="avatar"][href*="profiles.php?XID="]')) return true;
      }
      return false;
    };

    const preferred = candidates.find(t => inChannelPanel(t) && !inPMPanel(t));
    if (preferred) return preferred;
    const notPM = candidates.find(t => !inPMPanel(t));
    if (notPM) return notPM;

    if (toggler) {
      let el = toggler.parentElement;
      for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
        const ta = el.querySelector("textarea");
        if (ta && !inPMPanel(ta)) return ta;
      }
    }
    return null;
  }

  function togglerIsFaction(toggler) {
    return !!toggler && FACTION_LABEL_RE.test((toggler.textContent || "").trim());
  }

  // Detects whether Torn's chat is currently showing the Faction channel.
  // Two independent signals because the layout differs: on desktop the
  // dropdown toggler carries the channel name as its label; on PDA/mobile
  // the toggler is icon-only, but the channel_panel_button:faction launcher
  // gains an `opened___<hash>` class token when its own panel is active.
  function isFactionChannelActive(launcher, toggler) {
    if (toggler && togglerIsFaction(toggler)) return true;
    if (launcher && /(^|\s)opened___/.test((launcher.className || "").toString())) {
      return true;
    }
    return false;
  }

  // If chat is on another channel, switch to Faction. Clicking the faction
  // launcher works on both desktop and PDA; the dropdown-based fallback
  // covers layouts where the launcher isn't in the DOM.
  async function ensureFactionChannel(launcher, toggler) {
    if (isFactionChannelActive(launcher, toggler)) return true;
    if (launcher) {
      try { launcher.click(); } catch {}
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (isFactionChannelActive(launcher, findChannelToggler()) &&
            isChatOpen()) return true;
      }
    }
    if (toggler) return await selectFactionChannel(toggler);
    return false;
  }

  // Open the dropdown listbox and click the "Faction" option. Torn renders
  // the listbox as role="option" elements; fall back to any short element
  // whose text starts with "Faction" if the role isn't there.
  async function selectFactionChannel(toggler) {
    if (!toggler) return false;
    if (togglerIsFaction(toggler)) return true;
    toggler.click();
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      const opts = document.querySelectorAll(
        '[role="option"], [role="listbox"] li, [role="listbox"] button');
      for (const o of opts) {
        const t = (o.textContent || "").trim();
        if (FACTION_LABEL_RE.test(t) && t.length < 40) {
          o.click();
          return true;
        }
      }
    }
    return false;
  }

  function waitForTextarea(toggler, timeoutMs) {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        const ta = findChatTextareaFor(toggler);
        if (ta) return resolve(ta);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // Torn's send button is a `<button type="button">` containing only an SVG
  // icon and no text. Third-party userscripts (Torn Tools, FF Scouter,
  // TWSE...) inject their own siblings, so we identify Torn's button by
  // structure, not by class name (which changes each Torn deploy):
  //   - descendant of the same wrapper as the textarea
  //   - contains an <svg> child
  //   - has no visible text content
  //   - has empty aria-label/title (Torn labels its icon send with nothing)
  //   - is not the channel dropdown toggler
  const isIconOnlyButton = b => {
    if (!b.querySelector("svg")) return false;
    if ((b.textContent || "").trim().length > 0) return false;
    return true;
  };
  const isKnownThirdParty = b => {
    const cls = (b.className || "").toString();
    // TornTools = `tt-*`, FF Scouter = `_ff-*` or `ff-*`, TWSE = `twse-*`.
    return /(^|\s)(tt-|_?ff-|twse-)/.test(cls);
  };

  // Torn's chat sidebar sits next to the input, so walking up from the
  // textarea we'll hit an ancestor that also contains channel-panel buttons
  // (Faction/Company/Trade/...). Those look like icon-only buttons too but
  // clicking them switches channels instead of sending, so exclude them via
  // their stable id prefix.
  const isChannelPanelButton = b =>
    /^channel_panel_button:/.test(b.id || "");

  function findSendButton(ta, toggler) {
    if (!ta) return null;
    let scope = ta.parentElement;
    for (let i = 0; i < 10 && scope; i++, scope = scope.parentElement) {
      const buttons = [...scope.querySelectorAll("button")].filter(b =>
        b !== toggler &&
        b.getAttribute("data-testid") !== "dropdown-toggler" &&
        !isKnownThirdParty(b) &&
        !isChannelPanelButton(b) &&
        isIconOnlyButton(b));
      if (buttons.length) {
        // Prefer buttons that follow the textarea in document order - Torn's
        // send sits directly after the input, third-party stuff tends to
        // land above it.
        const after = buttons.find(b =>
          ta.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return after || buttons[0];
      }
    }
    return null;
  }

  // React tracks its own internal value on the input node, so `.value =`
  // writes are discarded on next render. The native prototype setter fires
  // the underlying browser setter which React's value-tracker recognises;
  // dispatching a bubbling `input` event then triggers React's onChange.
  async function announceInFactionChat(text) {
    if (!CONFIG.CHAT_ANNOUNCE) return false;
    let openedByUs = false;
    let launcher = null;
    try {
      const openState = await ensureChatOpen();
      openedByUs = openState.openedByUs;
      launcher = openState.launcher;

      const toggler = findChannelToggler();

      // Always verify the active channel; a chat opened on Company/Trade
      // would otherwise receive the DIBS message. ensureFactionChannel
      // no-ops when we're already on Faction.
      const factionOk = await ensureFactionChannel(launcher, toggler);
      if (!factionOk) {
        log("chat announce skipped: could not switch to Faction channel");
        return false;
      }

      // Re-resolve after the possible channel switch: the toggler that
      // existed before ensureFactionChannel may have been null (no channel
      // chat open) or pointed at Company/Trade.
      const factionToggler = findChannelToggler();
      const ta = await waitForTextarea(factionToggler, 1500);
      if (!ta) {
        log("chat announce skipped: no chat textarea");
        return false;
      }

      const proto = (pageWindow.HTMLTextAreaElement || HTMLTextAreaElement).prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

      ta.focus();

      // React keeps a private `_valueTracker` on the input node whose cached
      // value it compares against on every input event. Force a different
      // value so the next write is guaranteed to look like a change.
      const tracker = ta._valueTracker;
      if (tracker) {
        try { tracker.setValue(text + "_"); } catch {}
      }

      if (setter) setter.call(ta, text); else ta.value = text;

      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));

      // Secondary path: if React re-rendered and blanked us, try execCommand.
      await new Promise(r => setTimeout(r, 30));
      if (ta.value !== text) {
        ta.focus();
        try { ta.setSelectionRange(0, ta.value.length); } catch {}
        try { document.execCommand("insertText", false, text); } catch {}
      }

      const send = findSendButton(ta, factionToggler);

      for (let i = 0; send && send.disabled && i < 20; i++) {
        await new Promise(r => setTimeout(r, 50));
      }

      if (send) {
        if (send.disabled) {
          try { send.removeAttribute("disabled"); } catch {}
        }
        try { send.click(); } catch {}
        return true;
      }

      const form = ta.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
        return true;
      }

      const makeKey = type => {
        const e = new KeyboardEvent(type, {
          bubbles: true, cancelable: true, key: "Enter", code: "Enter",
        });
        Object.defineProperty(e, "keyCode", { get: () => 13 });
        Object.defineProperty(e, "which",   { get: () => 13 });
        return e;
      };
      ta.dispatchEvent(makeKey("keydown"));
      ta.dispatchEvent(makeKey("keypress"));
      ta.dispatchEvent(makeKey("keyup"));
      return true;
    } catch (e) {
      err("chat announce failed", e);
      return false;
    } finally {
      // Only restore the pre-call state: leave the chat alone if the user
      // already had it open. 2500ms on PDA leaves headroom for the send XHR
      // to fire before the panel is collapsed.
      if (openedByUs && launcher) {
        const closeDelayMs = IS_PDA ? 2500 : 1500;
        setTimeout(() => { try { launcher.click(); } catch {} }, closeDelayMs);
      }
    }
  }

  /* ------------------------------------------------------------------ render */

  // The "other" badge shows an icon plus the claimant's name at 7.5px, which
  // fits roughly seven characters in BADGE_W=38. Trim explicitly rather than
  // leaving it to CSS ellipsis, which truncates from the right and would
  // otherwise eat the icon on very long names. Full name is in the tooltip.
const shortOwner = name => {
  const n = String(name || "").trim();
  return n.length > 22 ? n.slice(0, 21) + "\u2026" : (n || "TAKEN");
};

  function paint(row, badge, id) {
    const dib = state.dibs.get(id);
    row.classList.remove("tdibs-mine", "tdibs-other");

    if (!isConfigured()) {
      badge.dataset.state = "idle";
      badge.textContent = `${ICON.idle}${GAP}SETUP`;
      badge.title = "Torn DIBS is not configured. Click to set it up.";
      return;
    }
    if (!state.rankedWarId || !state.myId) {
      badge.dataset.state = "idle";
      badge.textContent = ICON.idle;
      badge.title = "No active Ranked War, or identity not synced yet.";
      return;
    }
    if (!dib) {
      // Online targets are killed on sight by whoever sees them, so there is
      // nothing to reserve - show it, but don't offer the action.
      const reading = readRowStatus(row);
      if (reading?.is_online) {
        badge.dataset.state = "online";
        badge.textContent = `${ICON.online}${GAP}LIVE`;
        badge.title = "Target is online \u2014 no DIBS needed, just hit them";
        return;
      }
      badge.dataset.state = "free";
      badge.textContent = `${ICON.free}${GAP}DIBS`;
      badge.title = `Claim ${targetName(row)}`;
      return;
    }
    if (Number(dib.owner_id) === Number(state.myId)) {
      badge.dataset.state = "mine";
      badge.textContent = `${ICON.mine}${GAP}MINE`;
      badge.title = "Your DIBS \u2014 click to release";
      row.classList.add("tdibs-mine");
      return;
    }
    badge.dataset.state = "other";
    badge.textContent = `${ICON.other}${GAP}${shortOwner(dib.owner_name)}`;
    badge.title = `Claimed by ${dib.owner_name || "another faction member"}`;
    row.classList.add("tdibs-other");
  }

  function flash(badge, text) {
    const old = badge.textContent;
    badge.textContent = text;
    setTimeout(() => { if (badge.textContent === text) badge.textContent = old; }, 1300);
  }

  async function onBadgeClick(row, badge, id) {
    const st = badge.dataset.state;
    if (st === "busy" || st === "other" || st === "online") return;
    if (st === "idle") {
      openSetup(isConfigured() ? "" : "Enter your settings to start.");
      return;
    }

    const prev = { state: st, text: badge.textContent };
    badge.dataset.state = "busy";
    badge.textContent = ICON.busy;

    let claimed = false;
    try {
      if (st === "mine") {
        // No owner_id parameter: the server knows who we are, so we can only
        // ever release our own.
        await api("DELETE", `/api/dibs/${state.rankedWarId}/${id}`);
        state.dibs.delete(id);
      } else {
        // Make sure the server has a fresh reading from us before it decides.
        await pushStatus();

        const r = await api("POST", "/api/dibs", {
          ranked_war_id: state.rankedWarId,
          target_id: id,
          target_name: targetName(row),
          owner_name: state.myName,
          faction_id: state.factionId,
          enemy_faction_id: state.enemyFactionId || null,
          // no owner_id / expires_at - server-authoritative
        });

        if (r.status === 403) { flash(badge, "KEY?"); throw new Error(r.data?.detail || "identity rejected"); }
        if (r.status < 200 || r.status >= 300) {
          throw new Error(`HTTP ${r.status}: ${r.data?.detail || r.text || "no body"}`);
        }

        const reason = r.data?.reason;
        if (reason === "owner_has_dib") {
          badge.title = `You already hold DIBS on ${r.data.dib?.target_name || "another target"}`;
          flash(badge, "HELD");
        } else if (reason === "target_taken" || reason === "conflict") {
          flash(badge, "TAKEN");
        } else if (reason === "target_online") {
          flash(badge, `${ICON.online}${GAP}LIVE`);
        } else if (reason === "unverified_status") {
          // Not enough people have loaded the page yet for the backend to
          // trust anyone's reading. Resolves itself within a poll or two.
          flash(badge, "WAIT");
        } else if (!r.data?.ok) {
          throw new Error(`refused: ${JSON.stringify(r.data)}`);
        } else {
          claimed = true;
        }
      }
      await refreshDibs();
      render();
      if (claimed) {
        announceInFactionChat(`\u{1F3AF} ${targetName(row)} [${id}] DIBS`);
      }
    } catch (e) {
      state.lastError = e?.message || "action failed";
      err("action failed", e);
      badge.dataset.state = prev.state;
      badge.textContent = prev.text;
      flash(badge, "ERR");
    }
  }

  /* ------------------------------------------------- badge positioning ----
   * Carried over verbatim from v1.9.3, which is the build that finally sat
   * correctly on every row. Do not "improve" this without a screenshot.
   * ---------------------------------------------------------------------- */

  // Compute per-row badge metrics: width and height as clamped fractions
  // of the row itself, font size scaled to the resulting height. All values
  // are integers so the browser doesn't sub-pixel the border.
  function badgeMetrics(row) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const rw = row.offsetWidth || 800;
    const rh = row.offsetHeight || 22;
    const w = Math.round(clamp(rw * CONFIG.BADGE_W_PCT,
                               CONFIG.BADGE_W_MIN, CONFIG.BADGE_W_MAX));
    const h = Math.round(clamp(rh * CONFIG.BADGE_H_PCT,
                               CONFIG.BADGE_H_MIN, CONFIG.BADGE_H_MAX));
    const fs = clamp(Math.round(h * 0.6), 7, 12);
    return { w, h, fs };
  }

  // Hang the badge off ANY corner of a given box. SIDE picks the horizontal
  // edge, VSIDE the vertical. NUDGE_X and the computed nudgeY always mean
  // "pull inward, toward the centre of the box", regardless of which corner.
  function hangOffCorner(badge, box, w, h, nudgeY) {
    const { top, left, w: bw, h: bh } = box;
    badge.style.removeProperty("right");   // clear stale value from a prior SIDE

    if (CONFIG.SIDE === "left") {
      badge.style.setProperty("left", `${left + CONFIG.NUDGE_X}px`, "important");
    } else {
      badge.style.setProperty("left",
        `${left + bw - w - CONFIG.NUDGE_X}px`, "important");
    }

    if (CONFIG.VSIDE === "top") {
      badge.style.setProperty("top", `${top + nudgeY}px`, "important");
    } else {
      badge.style.setProperty("top",
        `${top + bh - h - nudgeY}px`, "important");
    }
  }

  function positionBadge(row, badge) {
    const link = rowProfileLink(row);
    const { w, h, fs } = badgeMetrics(row);
    badge.style.setProperty("--tdibs-w", `${w}px`);
    badge.style.setProperty("--tdibs-h", `${h}px`);
    badge.style.setProperty("--tdibs-fs", `${fs}px`);
    const nudgeY = h * CONFIG.NUDGE_Y_PCT;

    // Coordinate reads force layout. Skip the whole reposition dance when
    // the row hasn't resized since we last placed the badge - the badge is
    // positioned relative to the row via offset* which stay valid until the
    // row changes size.
    const c = getRowCache(row);
    const rw = row.offsetWidth, rh = row.offsetHeight;
    const key = `${CONFIG.ANCHOR}|${CONFIG.SIDE}|${CONFIG.VSIDE}|${rw}x${rh}|${w}x${h}`;
    if (c.posKey === key) return;
    c.posKey = key;

    if (CONFIG.ANCHOR === "left-icon") {
      // ".member" is a stable UNHASHED class token (Torn's markup is
      // `class="member icons left member___xxxxx"` - "member" stands alone,
      // separate from the build-hashed suffix). Its corner is exactly where
      // the online-status dot and faction-tag icon are drawn, at the far left
      // before the avatar and name.
      const cell = row.querySelector(".member") || row;
      hangOffCorner(badge, {
        top: cell.offsetTop, left: cell.offsetLeft,
        w: cell.offsetWidth, h: cell.offsetHeight,
      }, w, h, nudgeY);
      return;
    }

    if (CONFIG.ANCHOR === "status") {
      const cell = findStatusCell(row);
      if (cell) {
        hangOffCorner(badge, {
          top: cell.offsetTop, left: cell.offsetLeft,
          w: cell.offsetWidth, h: cell.offsetHeight,
        }, w, h, nudgeY);
        return;
      }
      // Status text not found (rare states, or DOM not settled) - fall
      // through to the avatar, which is always present.
    }

    if (CONFIG.ANCHOR !== "row" && link) {
      hangOffCorner(badge, {
        top: link.offsetTop, left: link.offsetLeft,
        w: link.offsetWidth, h: link.offsetHeight,
      }, w, h, nudgeY);
      return;
    }

    // Last-resort fallback: corner of the row itself.
    badge.style.setProperty("top", `${2 + nudgeY}px`, "important");
    if (CONFIG.SIDE === "left") {
      badge.style.setProperty("left", `${CONFIG.NUDGE_X}px`, "important");
      badge.style.removeProperty("right");
    } else {
      badge.style.setProperty("right", `${CONFIG.NUDGE_X}px`, "important");
      badge.style.removeProperty("left");
    }
  }

  function render() {
    if (!warRoot()) return;
    state.writing = true;
    let drawn = 0;
    try {
      const rows = enemyRows();
      state.rowsSeen = rows.length;

      for (const row of rows) {
        const id = targetId(row);
        if (!id) continue;

        row.classList.add("tdibs-host");

        let badge = row.querySelector(":scope > .tdibs-badge");
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "tdibs-badge";
          badge.dataset.state = "idle";
          badge.textContent = `${ICON.free}${GAP}DIBS`;
          badge.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            onBadgeClick(row, badge, id);
          }, true);
          row.appendChild(badge);
        }

        positionBadge(row, badge);
        paint(row, badge, id);
        drawn++;

        // If anything ever stretches the badge back into a full-width bar,
        // say so loudly rather than silently covering Torn's own columns.
        if (!state.widthWarned) {
          const bw = badge.getBoundingClientRect().width;
          const expected = badgeMetrics(row).w;
          if (bw > expected * 2.5) {
            state.widthWarned = true;
            err(`badge rendered ${Math.round(bw)}px wide (expected ${expected}px) - ` +
                `an old version's stylesheet is probably still active. Remove every ` +
                `older "Torn RW DIBS" entry in your userscript manager and reload.`);
          }
        }
      }
      state.badgesDrawn = drawn;
    } finally {
      setTimeout(() => { state.writing = false; }, 0);
    }
    installButton();
  }

  /* ------------------------------------------------------------------- polls */

  async function refreshDibs() {
    if (!state.rankedWarId || !isConfigured()) return;
    try {
      const r = await api("GET", `/api/dibs/${state.rankedWarId}`);
      if (r.status !== 200) {
        state.lastError = `GET /api/dibs -> ${r.status}`;
        return;
      }
      state.dibs = new Map((r.data.dibs || []).map(x => [Number(x.target_id), x]));
      state.lastError = "";
    } catch (e) {
      state.lastError = e?.message || "dibs poll failed";
    }
  }

  function installObserver() {
    let timer = null;
    let rafPending = false;
    const runRender = () => { rafPending = false; render(); };
    const schedule = () => {
      if (state.writing) return;
      clearTimeout(timer);
      // Debounce, then coalesce into a single frame so multiple mutation
      // bursts (Torn Tools/TWSE etc.) collapse into one render pass.
      timer = setTimeout(() => {
        if (rafPending) return;
        rafPending = true;
        (window.requestAnimationFrame || setTimeout)(runRender);
      }, 150);
    };

    const mo = new MutationObserver(muts => {
      if (state.writing) return;
      for (const m of muts) {
        if (m.type !== "childList") continue;
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          // Ignore mutations we caused ourselves or that live outside the
          // roster entirely (chat panels, PDA UI, third-party toolbars).
          if (node.classList.contains("tdibs-badge")) continue;
          if (node.id === "tdibs-btn" || node.id === "tdibs-overlay") continue;
          if (node.matches?.(".enemy, .faction-war") ||
              node.querySelector?.(".enemy, .faction-war")) {
            schedule();
            return;
          }
        }
      }
    });

    mo.observe(document.querySelector("#factions") || document.body,
               { childList: true, subtree: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("hashchange", schedule);
    window.navigation?.addEventListener?.("currententrychange", schedule);
  }

  // Release automatically when you actually launch the attack on your target.
  document.addEventListener("click", async e => {
    const trigger = e.target.closest?.('a[href*="sid=attack"]');
    if (!trigger || !state.rankedWarId) return;
    const row = trigger.closest(".enemy");
    if (!row) return;
    const id = targetId(row);
    if (!id) return;
    const dib = state.dibs.get(id);
    if (dib && Number(dib.owner_id) === Number(state.myId)) {
      try {
        await api("DELETE", `/api/dibs/${state.rankedWarId}/${id}`);
        state.dibs.delete(id);
        render();
      } catch (e2) { err("implicit release failed", e2); }
    }
  }, true);

  /* -------------------------------------------------------------------- boot */

  async function tick() {
    // Backgrounded tabs get throttled by the browser anyway; skipping the
    // work outright saves the DOM scan + API round-trip when nobody is
    // looking at the page.
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const active = await syncIdentityAndWar(false);
      if (active) {
        // Report first, then read: the backend's view of this target should
        // include our latest observation before we look at the result.
        await pushStatus();
        await refreshDibs();
      }
    } catch (e) {
      state.lastError = e?.message || "sync failed";
      err("sync failed", e);
    }
    render();
  }

  function start() {
    if (!document.body) return;
    purgeLegacy();
    installStyle();
    installButton();
    installObserver();
    render();
    tick();
    setInterval(tick, CONFIG.POLL_MS);
    try { GM_registerMenuCommand("Torn DIBS settings", () => openSetup()); } catch {}

    // Live tuning without reinstalling. Exposed on the REAL page window so it
    // is reachable from DevTools, which evaluates against the page and not
    // the userscript sandbox.
    const helpers = {
      state, config: CONFIG, render,
      anchor(where) {
        CONFIG.ANCHOR = ["row", "status", "avatar", "left-icon"].includes(where)
          ? where : "left-icon";
        render();
      },
      side(where) { CONFIG.SIDE = where === "right" ? "right" : "left"; render(); },
      vside(where) { CONFIG.VSIDE = where === "bottom" ? "bottom" : "top"; render(); },
      // Horizontal nudge in px, vertical nudge as a fraction of badge height
      // (negative = hang below the anchor cell).
      nudge(x, yPct = 0) { CONFIG.NUDGE_X = x; CONFIG.NUDGE_Y_PCT = yPct; render(); },
      // Both arguments are fractions of the row size (e.g. size(0.22, 0.7)).
      size(wPct, hPct) {
        if (wPct != null) CONFIG.BADGE_W_PCT = wPct;
        if (hPct != null) CONFIG.BADGE_H_PCT = hPct;
        render();
      },
      // Move the settings button without editing the file. Accepts any CSS
      // length: btn("20%"), btn("120px"), btn("15%", "40px").
      btn(top, right) {
        if (top) CONFIG.BTN_TOP = top;
        if (right) CONFIG.BTN_RIGHT = right;
        installStyle();
      },
      tint(on) { CONFIG.ROW_TINT = !!on; installStyle(); },
      chat(text) { return announceInFactionChat(String(text || "test")); },
      diag: () => { const t = diagText(); log("\n" + t); return t; },
      readRow: () => enemyRows().slice(0, 3).map(readRowStatus),
      reset() {
        drop(KEYS.API_BASE); drop(KEYS.SHARED_TOKEN); drop(KEYS.TORN_API_KEY);
        location.reload();
      },
    };
    try { pageWindow.tornDibs = helpers; } catch {}
    window.tornDibs = helpers;

    log(`v${VERSION} ready \u2014 enemy side only. tornDibs.diag() for diagnostics.`);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
