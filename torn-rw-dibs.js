// ==UserScript==
// @name         Torn RW DIBS
// @namespace    https://github.com/deyandimonov/torn-dibs-userinterface
// @version      1.2.2
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
    DEFAULT_API_BASE: "https://gcloud.d3software.eu",

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
    NUDGE_X: 0,
    NUDGE_Y: -12.5,        // negative pushes further past the bottom edge

    BADGE_W: 150,
    BADGE_H: 15,

    ROW_TINT: true,

    // Settings button position. Percent so it tracks the viewport rather
    // than sitting at a fixed pixel offset on tall monitors.
    BTN_TOP: "15%",
    BTN_RIGHT: "14px",
  };

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

  const log = (...a) => console.log("[Torn DIBS]", ...a);
  const err = (...a) => console.error("[Torn DIBS]", ...a);

  /* ---------------------------------------------------------------- storage */

  const get = k => { try { return String(GM_getValue(k, "") || "").trim(); } catch { return ""; } };
  const put = (k, v) => { try { GM_setValue(k, String(v || "").trim()); } catch {} };
  const drop = k => { try { GM_deleteValue(k); } catch {} };

  const apiBase = () => get(KEYS.API_BASE).replace(/\/+$/, "");
  const token = () => get(KEYS.SHARED_TOKEN);
  const apiKey = () => get(KEYS.TORN_API_KEY);
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
    const w = CONFIG.BADGE_W, h = CONFIG.BADGE_H;
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
        /* Width is pinned four ways on purpose: no stray rule from an older
           build, from Torn, or from another script may stretch this back
           into a full-width bar covering Level/FF/Score/Status/Attack. */
        width:${w}px !important;
        min-width:${w}px !important;
        max-width:${w}px !important;
        flex:0 0 ${w}px !important;
        inset:auto !important;
        float:none !important;
        clear:none !important;
        height:${h}px !important;
        line-height:${h - 2}px !important;
        box-sizing:border-box !important;
        display:block !important;
        margin:0 !important;
        padding:0 2px !important;
        /* Tight tracking: at BADGE_W=38 an icon plus a four-letter word only
           just fits. Letter-spacing is what pushes it over the edge, so it
           goes negative rather than the badge getting wider. */
        font:700 9px/${h - 2}px Arial,Helvetica,sans-serif !important;
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
  font-size:6px !important;
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
        <label>Torn PUBLIC API key<input id="tdibs-key" type="password" autocomplete="off"></label>
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
    $("#tdibs-base").value = apiBase() || CONFIG.DEFAULT_API_BASE;
    $("#tdibs-token").value = token();
    $("#tdibs-key").value = apiKey();

    $("#tdibs-close").onclick = closeSetup;
    o.addEventListener("click", e => { if (e.target === o) closeSetup(); });

    $("#tdibs-save").onclick = async () => {
      const base = $("#tdibs-base").value.trim().replace(/\/+$/, "");
      const tok = $("#tdibs-token").value.trim();
      const key = $("#tdibs-key").value.trim();
      if (!base || !tok || !key) {
        $("#tdibs-msg").textContent = "All three fields are required.";
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
    const a = rowProfileLink(row);
    if (!a) return 0;
    try { return Number(new URL(a.href, location.origin).searchParams.get("XID") || 0); }
    catch { return Number(String(a.getAttribute("href") || "").match(/[?&]XID=(\d+)/i)?.[1] || 0); }
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
    for (const el of row.querySelectorAll("div, span")) {
      if (el.children.length > 0) continue;   // leaf text nodes only
      const txt = (el.textContent || "").trim();
      if (txt && STATUS_WORDS.test(txt)) return el;
    }
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
        }
      }
      await refreshDibs();
      render();
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

  // Hang the badge off ANY corner of a given box. SIDE picks the horizontal
  // edge, VSIDE the vertical. NUDGE_X/Y always mean "pull inward, toward the
  // centre of the box", regardless of which corner is chosen.
  function hangOffCorner(badge, box) {
    const { top, left, w, h } = box;
    badge.style.removeProperty("right");   // clear stale value from a prior SIDE

    if (CONFIG.SIDE === "left") {
      badge.style.setProperty("left", `${left + CONFIG.NUDGE_X}px`, "important");
    } else {
      badge.style.setProperty("left",
        `${left + w - CONFIG.BADGE_W - CONFIG.NUDGE_X}px`, "important");
    }

    if (CONFIG.VSIDE === "top") {
      badge.style.setProperty("top", `${top + CONFIG.NUDGE_Y}px`, "important");
    } else {
      badge.style.setProperty("top",
        `${top + h - CONFIG.BADGE_H - CONFIG.NUDGE_Y}px`, "important");
    }
  }

  function positionBadge(row, badge) {
    const link = rowProfileLink(row);

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
      });
      return;
    }

    if (CONFIG.ANCHOR === "status") {
      const cell = findStatusCell(row);
      if (cell) {
        hangOffCorner(badge, {
          top: cell.offsetTop, left: cell.offsetLeft,
          w: cell.offsetWidth, h: cell.offsetHeight,
        });
        return;
      }
      // Status text not found (rare states, or DOM not settled) - fall
      // through to the avatar, which is always present.
    }

    if (CONFIG.ANCHOR !== "row" && link) {
      hangOffCorner(badge, {
        top: link.offsetTop, left: link.offsetLeft,
        w: link.offsetWidth, h: link.offsetHeight,
      });
      return;
    }

    // Last-resort fallback: corner of the row itself.
    badge.style.setProperty("top", `${2 + CONFIG.NUDGE_Y}px`, "important");
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
          if (bw > CONFIG.BADGE_W * 2.5) {
            state.widthWarned = true;
            err(`badge rendered ${Math.round(bw)}px wide (expected ${CONFIG.BADGE_W}px) - ` +
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
    const schedule = () => {
      if (state.writing) return;
      clearTimeout(timer);
      timer = setTimeout(render, 120);
    };

    const mo = new MutationObserver(muts => {
      if (state.writing) return;
      for (const m of muts) {
        if (m.type !== "childList") continue;
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.classList.contains("tdibs-badge")) continue;
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
      nudge(x, y = 0) { CONFIG.NUDGE_X = x; CONFIG.NUDGE_Y = y; render(); },
      size(w, h) {
        CONFIG.BADGE_W = w;
        if (h) CONFIG.BADGE_H = h;
        installStyle(); render();
      },
      // Move the settings button without editing the file. Accepts any CSS
      // length: btn("20%"), btn("120px"), btn("15%", "40px").
      btn(top, right) {
        if (top) CONFIG.BTN_TOP = top;
        if (right) CONFIG.BTN_RIGHT = right;
        installStyle();
      },
      tint(on) { CONFIG.ROW_TINT = !!on; installStyle(); },
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
