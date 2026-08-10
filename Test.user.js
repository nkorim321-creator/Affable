// ==UserScript==
// @name         Affable Auto v5.7.9
// @namespace    mturk-affable-auto
// @version      5.7.9
// @description  Auto-fill Affable HITs — HTML followers (with pics) + Location + audio captcha self-solve + fresh-reload on expired captcha + Worker-ID allowlist (live)
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      api.wit.ai
// @connect      www.google.com
// @connect      google.com
// @connect      docs.google.com
// @connect      recaptcha.net
// @connect      *.google.com
// @connect      *.gstatic.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============ CONFIG ============
  const CFG = {
    location: 'US',          // only this + followers matter
    minFollowers: 30,        // push past the ~24 plateau to ensure 25+
    scrollDelay: 1000,
    maxScrolls: 30,
    autoSubmit: true,        // submit automatically once CAPTCHA is solved
    captchaWait: 40000,
    captchaWindow: 180000,   // how long to try solving in one tab before a fresh reload (ms)
    reloadOnExpire: true,    // when reCAPTCHA expires / can't be solved → reload fresh (close & reopen equivalent)
    maxReloads: 3,           // max fresh reloads per profile before falling back to manual
    witAiToken: 'ZUIDLU46WHNXDZ4QP66QMA7DVNJRDQDR',          // ← PUT YOUR WIT.AI SERVER ACCESS TOKEN HERE (free: wit.ai)
    // Worker-ID allowlist — only Worker IDs listed in this Google Sheet may run the automation.
    // (gviz CSV export of the sheet; the sheet must be shared "anyone with the link can view".)
    sheetCsvUrl: 'https://docs.google.com/spreadsheets/d/1p03KacnfGQhtXm7umEnbktki3wCpaVzC_16W51iKn6U/gviz/tq?tqx=out:csv',
    allowlistTtl: 30000,     // soft cache for the periodic re-check (ms); work-time check is always fresh
    authMaxAge:   90000,     // an aff_auth result older than this is treated as stale (not trusted)
    recheckMs:    8000,      // how often worker.mturk.com re-verifies the Worker ID against the sheet
  };
  const TAG = '[AffV5.7.9]';
  const SKIP = ['explore','direct','stories','reels','accounts','p','tv','reel','about','session','emails','nux','terms','privacy','directory','lite'];
  // ================================

  const log = (m) => console.log(`${TAG} ${m}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const href = location.href;
  const openedHITs = new Set();   // queue: track HITs already opened (declared early to avoid TDZ)
  let bframeDumps = 0;            // captcha bframe diagnostic counter (declared early to avoid TDZ)
  let __expiredFlagged = false;   // per-frame guard: signal "captcha expired" only once (declared early to avoid TDZ)

  // ================================================================
  //  ACCESS CONTROL — Worker-ID allowlist (Google Sheet)
  //  Only Worker IDs listed in the sheet may run the automation. On worker.mturk.com we detect the
  //  Worker ID, check it against the sheet, and publish the result (aff_auth) so EVERY frame/tab can
  //  read it. Unlisted workers get a warning banner and all automation stays disabled.
  // ================================================================
  function detectWorkerIds() {
    const out = new Set();
    let html = '';
    try { html = (document.documentElement && document.documentElement.innerHTML) || ''; } catch (e) {}
    // strong signals: the worker site embeds the id as "workerId"/"subjectId" in its state JSON
    let primary = null;
    const strong = html.matchAll(/"(?:workerId|subjectId)"\s*:\s*"(A[A-Z0-9]{8,20})"/g);
    for (const m of strong) { const id = m[1].toUpperCase(); if (!primary) primary = id; out.add(id); }
    // a "Worker ID" label in the visible text
    try {
      const bt = (document.body && document.body.innerText) || '';
      const m = bt.match(/Worker\s*ID[\s:#]*?(A[A-Z0-9]{8,20})/i);
      if (m) { const id = m[1].toUpperCase(); if (!primary) primary = id; out.add(id); }
    } catch (e) {}
    // weak fallback: any worker-id-shaped token on the page (helps if the strong patterns miss)
    const weak = html.matchAll(/\b(A[A-Z0-9]{12,13})\b/g);
    let n = 0; for (const m of weak) { if (n++ > 80) break; out.add(m[1].toUpperCase()); }
    return { primary: primary || ([...out][0] || null), all: [...out] };
  }

  function fetchAllowlist() {
    return new Promise((resolve) => {
      try {
        const url = CFG.sheetCsvUrl + (CFG.sheetCsvUrl.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 15000,
          onload: (r) => {
            if (r && r.status >= 200 && r.status < 300 && r.responseText) {
              const ids = (r.responseText.toUpperCase().match(/A[A-Z0-9]{9,}/g) || []);
              resolve([...new Set(ids)]);
            } else resolve(null);
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } catch (e) { resolve(null); }
    });
  }

  async function getAllowlist(force) {
    if (!force) {
      try {
        const raw = await GM_getValue('aff_allow', '');
        if (raw) { const c = JSON.parse(raw); if (c && Array.isArray(c.ids) && Date.now() - c.ts < CFG.allowlistTtl) return c.ids; }
      } catch (e) {}
    }
    const ids = await fetchAllowlist();
    if (ids && ids.length) { try { await GM_setValue('aff_allow', JSON.stringify({ ids, ts: Date.now() })); } catch (e) {} return ids; }
    // fetch failed → reuse any cached list (even stale) so a transient hiccup can't lock everyone out
    try { const raw = await GM_getValue('aff_allow', ''); if (raw) { const c = JSON.parse(raw); if (Array.isArray(c.ids)) return c.ids; } } catch (e) {}
    return [];
  }

  // true = authorized, false = denied, null = not determined / stale.
  // A result older than authMaxAge is treated as stale (null) so removals can't ride on an old "true".
  async function authState() {
    try {
      const raw = await GM_getValue('aff_auth', '');
      if (raw) { const a = JSON.parse(raw); if (a && typeof a.authorized === 'boolean' && Date.now() - a.ts < CFG.authMaxAge) return a.authorized; }
    } catch (e) {}
    return null;
  }

  // Used right before doing real work (processForm): ask worker.mturk.com to re-verify against the
  // sheet RIGHT NOW (bypassing the cache) and wait for that fresh result. Removing a Worker ID from
  // the sheet therefore blocks the very next HIT — no stale-cache window.
  async function requireFreshAuth() {
    const reqTs = Date.now();
    try { await GM_setValue('aff_auth_req', String(reqTs)); } catch (e) {}
    const t0 = Date.now();
    for (;;) {
      try {
        const raw = await GM_getValue('aff_auth', '');
        if (raw) { const a = JSON.parse(raw); if (a && typeof a.authorized === 'boolean' && a.ts >= reqTs) return a.authorized; }
      } catch (e) {}
      if (Date.now() - t0 > 15000) {                        // mturk frame didn't answer in time
        const a = await authState();                        // accept a still-fresh result, else fail closed
        return a === true;
      }
      await sleep(300);
    }
  }

  function removeAccessWarning() { try { const el = document.getElementById('aff-acc-warn'); if (el) el.remove(); } catch (e) {} }
  function showAccessWarning(wid) {
    const make = () => {
      try {
        if (!document.body) { setTimeout(make, 150); return; }
        if (document.getElementById('aff-acc-warn')) return;
        const d = document.createElement('div');
        d.id = 'aff-acc-warn';
        Object.assign(d.style, {
          position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
          background: '#c0392b', color: '#fff', textAlign: 'center', padding: '11px 16px',
          font: '600 14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif', boxShadow: '0 2px 12px rgba(0,0,0,0.45)'
        });
        d.textContent = '⛔ Affable: Worker ID ' + (wid || '?') + ' is NOT authorized to use this script. Contact the admin.';
        document.body.appendChild(d);
      } catch (e) {}
    };
    make();
  }

  function startAccessControl() {
    if (location.hostname !== 'worker.mturk.com') return;   // the Worker ID only lives on mturk
    if (window.__affAccCtl) return; window.__affAccCtl = true;
    let lastReq = 0;
    const doCheck = async (force) => {
      const det = detectWorkerIds();
      if (!det.all.length) return false;                    // id not in the page yet
      const list = await getAllowlist(force);
      const matched = det.all.find((id) => list.indexOf(id) !== -1);
      const authorized = !!matched;
      const shownId = det.primary || matched || det.all[0];
      try { await GM_setValue('aff_auth', JSON.stringify({ id: shownId, authorized, ts: Date.now() })); } catch (e) {}
      log(`Access check: Worker ${shownId} → ${authorized ? 'AUTHORIZED ✓' : 'NOT AUTHORIZED ⛔'} (allowlist ${list.length})`);
      authorized ? removeAccessWarning() : showAccessWarning(shownId);
      return true;
    };
    (async () => { for (let i = 0; i < 25; i++) { if (await doCheck(true)) break; await sleep(1000); } })();  // initial fresh check
    setInterval(() => doCheck(false), CFG.recheckMs);       // keep aff_auth fresh (cached list within TTL)
    setInterval(async () => {                               // honor "verify NOW" requests from processForm
      try { const raw = await GM_getValue('aff_auth_req', ''); const ts = parseInt(raw || '0', 10);
        if (ts && ts > lastReq) { lastReq = ts; await doCheck(true); } } catch (e) {}
    }, 800);
  }
  startAccessControl();

  // Detect the reCAPTCHA "Verification expired. Check the checkbox again." / "Try again later"
  // states. Runs inside the anchor & bframe iframes; when seen, signals the main form to reload
  // fresh — the user found a brand-new tab solves smoothly where in-place retries keep failing.
  function detectExpiredCaptcha() {
    // 1) direct element check (most reliable) — the red "…expired. Check the checkbox again." msg
    const em = document.querySelector('.rc-anchor-error-msg, .rc-audiochallenge-error-message');
    if (em && /expired/i.test(em.textContent || '')) {
      const cont = em.closest('.rc-anchor-error-msg-container');
      let shown = true;
      try { shown = !cont || getComputedStyle(cont).display !== 'none'; } catch (e) {}
      if (shown) return true;
    }
    // 2) visible-text fallback
    const txt = (document.body ? (document.body.innerText || '') : '').toLowerCase();
    if (txt.includes('expired') && txt.includes('checkbox again')) return true;   // exact expiry message
    // 3) "Try again later" / automated-queries block
    const dos = document.querySelector('.rc-doscaptcha-header-text, .rc-doscaptcha-body-text');
    if (dos && /try again later|automated queries/i.test(dos.textContent || '')) return true;
    return false;
  }
  // Hard block ("Try again later" / automated queries) — re-clicking can't fix this, only a fresh tab.
  function detectHardBlock() {
    const dos = document.querySelector('.rc-doscaptcha-header-text, .rc-doscaptcha-body-text');
    return !!(dos && /try again later|automated queries/i.test(dos.textContent || ''));
  }
  async function flagExpired(where) {
    if (__expiredFlagged) return;
    __expiredFlagged = true;
    try { await GM_setValue('aff_captcha_expired', JSON.stringify({ ts: Date.now(), where })); } catch (e) {}
    log(`⚠ reCAPTCHA expired/blocked (${where}) — requesting fresh reload`);
  }

  // ================================================================
  //  RECAPTCHA IFRAMES — checkbox + Buster (re-acts on each new trigger)
  // ================================================================
  if (href.includes('google.com/recaptcha/api2/anchor')) {
    // Log clicks in anchor iframe
    document.addEventListener('click', (e) => {
      const t = e.target;
      const cls = (t.className || '').toString().trim().replace(/\s+/g, '.').slice(0, 40);
      log(`CLICK[anchor trusted=${e.isTrusted}] <${t.tagName.toLowerCase()}${t.id ? '#' + t.id : ''} cls="${cls}">`);
    }, true);
    // DIAGNOSTIC: log clicks in the checkbox iframe too
    document.addEventListener('click', (e) => {
      const t = e.target;
      log(`CLICK[anchor trusted=${e.isTrusted}] <${t.tagName.toLowerCase()}${t.id ? '#' + t.id : ''} cls="${(t.className || '').toString().slice(0, 40)}">`);
    }, true);
    // checkbox iframe — click ONCE to open the challenge, then leave it alone
    // (re-clicking resets the challenge and stops Buster from finishing)
    let clicked = false;
    setInterval(async () => {
      if (clicked) return;
      let trig; try { trig = await GM_getValue('aff_captcha', ''); } catch (e) { return; }
      if (!trig) return;
      let ts; try { ts = JSON.parse(trig).ts; } catch (e) { return; }
      if (!ts || Date.now() - ts > 120000) return;
      const cb = document.querySelector('#recaptcha-anchor') || document.querySelector('.recaptcha-checkbox-border');
      if (cb && cb.getAttribute('aria-checked') !== 'true') {
        cb.click();
        clicked = true;
        log('reCAPTCHA checkbox clicked (once)');
      }
    }, 1000);
    // "Verification expired. Check the checkbox again." → do EXACTLY that: re-click the checkbox.
    // Programmatic checkbox clicks trigger reCAPTCHA here (the first one opened the challenge), so
    // re-clicking re-arms a fresh verification WITHOUT reloading or losing the filled form. Only if
    // repeated re-clicks don't recover it do we escalate (flag the form to reload fresh).
    let reExpiry = 0, lastReclick = 0;
    setInterval(() => {
      if (!detectExpiredCaptcha()) return;
      if (Date.now() - lastReclick < 4000) return;          // cooldown between re-clicks
      if (reExpiry >= 6) { flagExpired('anchor-giveup'); return; }   // re-clicks not working → reload
      const cb = document.querySelector('#recaptcha-anchor') || document.querySelector('.recaptcha-checkbox-border');
      if (cb) {
        ['mousedown', 'mouseup', 'click'].forEach(t => {
          try { cb.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
        });
        try { cb.click(); } catch (e) {}
        reExpiry++; lastReclick = Date.now();
        log(`reCAPTCHA expired — re-clicked the checkbox (${reExpiry}/6)`);
      }
    }, 1000);
    return;
  }

  if (href.includes('google.com/recaptcha/api2/bframe')) {
    // === DIAGNOSTIC: log every click (real vs fake) ===
    document.addEventListener('click', (e) => {
      const t = e.target;
      const path = [];
      let el = t;
      for (let i = 0; i < 5 && el && el.tagName; i++) {
        const cls = (el.className || '').toString().trim().replace(/\s+/g, '.').slice(0, 40);
        path.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`);
        el = el.parentElement;
      }
      log(`CLICK[trusted=${e.isTrusted}] ${path.join(' < ')}`);
    }, true);

    // === DIAGNOSTIC: watch audio answer box ===
    let lastAudioVal = '';
    setInterval(() => {
      const inp = document.querySelector('#audio-response');
      if (inp && inp.value && inp.value !== lastAudioVal) {
        lastAudioVal = inp.value;
        log(`AUDIO ANSWER: "${inp.value.slice(0, 50)}"`);
      }
    }, 800);

    // === MAIN: on each fresh trigger, self-solve audio captcha ===
    let lastTs = 0, busy = false;
    setInterval(async () => {
      let trig; try { trig = await GM_getValue('aff_captcha', ''); } catch (e) { return; }
      if (!trig) return;
      let ts; try { ts = JSON.parse(trig).ts; } catch (e) { return; }
      if (!ts || Date.now() - ts > 120000) return;
      if (ts === lastTs || busy) return;
      lastTs = ts; busy = true;
      try { await handleBframe(); } finally { busy = false; }
    }, 1500);
    // Only a HARD block ("Try again later" / automated queries) escalates to a fresh reload here —
    // a normal expiry is handled by re-clicking the checkbox in the anchor iframe (no reload needed).
    setInterval(() => { if (detectHardBlock()) flagExpired('bframe-block'); }, 1500);
    return;
  }

  // ================================================================
  //  AUDIO CAPTCHA SELF-SOLVE (replaces Buster — no isTrusted issue)
  // ================================================================
  async function handleBframe() {
    // 1) Switch to audio challenge if we're on image
    const audioBtn = document.querySelector('#recaptcha-audio-button, button.rc-button-audio');
    const respField = document.querySelector('#audio-response');
    if (audioBtn && !respField) {
      audioBtn.click();
      log('STEP 1: Switched to audio challenge');
      await sleep(2000);
    } else {
      log('STEP 1: Already on audio challenge (or no audio button)');
    }

    // Check wit.ai token once
    if (!CFG.witAiToken) {
      log('STEP 3: ❌ No wit.ai token! Set CFG.witAiToken in script. Trying Buster fallback...');
      tryBusterClick();
      return;
    }

    // Try up to 4 rounds — if wit.ai can't hear this audio, grab a FRESH challenge and retry
    for (let round = 1; round <= 4; round++) {
      log(`=== AUDIO SOLVE round ${round}/4 ===`);
      const ok = await solveOneAudio();
      if (ok === 'solved') return;            // typed + verified
      if (ok === 'fatal') { tryBusterClick(); return; }  // no audio element at all

      // wit.ai missed this audio → get a NEW challenge (fresh audio) and retry
      if (round < 4) {
        const reload = document.querySelector('#recaptcha-reload-button, button[title*="new challenge" i]');
        if (reload) {
          reload.click();
          log('↻ wit.ai missed — requesting a NEW audio challenge...');
          await sleep(2500);
        } else {
          log('↻ wit.ai missed but no reload button found');
          break;
        }
      }
    }
    log('Audio not solved after 4 fresh challenges — will retry on next attempt / manual ok');
  }

  // Solve ONE audio challenge. Returns 'solved' | 'retry' | 'fatal'
  async function solveOneAudio() {
    const audioSrc = getAudioSrc();
    if (!audioSrc) {
      log('STEP 2: ❌ No audio source URL found');
      return 'fatal';
    }
    log(`STEP 2: Audio URL found (${audioSrc.slice(0, 70)}...)`);

    log('STEP 3: Downloading audio...');
    let audioData;
    try {
      audioData = await downloadAudio(audioSrc);
      const b = new Uint8Array(audioData).slice(0, 4);
      const hex = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');
      log(`STEP 3: Audio downloaded (${audioData.byteLength} bytes, first4=${hex})`);
    } catch (e) {
      log(`STEP 3: ❌ Audio download failed: ${e.message}`);
      return 'retry';
    }

    log('STEP 4: Sending to wit.ai...');
    let transcript;
    try {
      transcript = await transcribeWitAi(audioData);
    } catch (e) {
      log(`STEP 4: ❌ wit.ai error: ${e.message}`);
      return 'retry';
    }

    if (!transcript) {
      log('STEP 4: ❌ wit.ai empty — will fetch a fresh audio challenge');
      return 'retry';
    }
    log(`STEP 4: ✓ Transcript: "${transcript}"`);

    // Type answer
    const inp = document.querySelector('#audio-response');
    if (!inp) { log('STEP 5: ❌ Response input gone'); return 'retry'; }
    inp.focus();
    inp.value = transcript;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    log(`STEP 5: ✓ Answer typed: "${transcript}"`);

    // Verify
    await sleep(500);
    const verifyBtn = document.querySelector('#recaptcha-verify-button') ||
                      document.querySelector('button.rc-button-default');
    if (verifyBtn) {
      verifyBtn.click();
      log('STEP 6: ✓ Verify clicked');
    } else {
      log('STEP 6: ❌ Verify button not found');
      return 'retry';
    }

    // Wait briefly and check if reCAPTCHA rejected it (response field still present & empty = likely rejected)
    await sleep(2500);
    const stillThere = document.querySelector('#audio-response');
    const errMsg = document.querySelector('.rc-audiochallenge-error-message');
    if (errMsg && errMsg.textContent.trim()) {
      log(`STEP 6: ✗ reCAPTCHA rejected ("${errMsg.textContent.trim().slice(0, 40)}") — fresh audio`);
      return 'retry';
    }
    if (stillThere && !stillThere.value) {
      // field cleared & still showing → may have been accepted or moved on; treat as solved attempt
      log('STEP 6: answer submitted (response field cleared)');
    }
    return 'solved';
  }

  function getAudioSrc() {
    // audio source can be in <audio> element or download link
    const audioEl = document.querySelector('audio#audio-source, audio');
    if (audioEl && audioEl.src) return audioEl.src;
    const dl = document.querySelector('a.rc-audiochallenge-tdownload-link, a[href*="payload"]');
    if (dl && dl.href) return dl.href;
    // also try source inside audio
    const src = document.querySelector('audio source');
    if (src && src.src) return src.src;
    return null;
  }

  function downloadAudio(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        onload: (resp) => {
          if (resp.status >= 200 && resp.status < 400 && resp.response) {
            resolve(resp.response);
          } else {
            reject(new Error(`HTTP ${resp.status}`));
          }
        },
        onerror: (e) => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout'))
      });
    });
  }

  function transcribeWitAi(audioBuffer) {
    return new Promise((resolve, reject) => {
      // Send as a typed Blob (preserves binary exactly) with NO Content-Type header,
      // so the Blob's type becomes the single Content-Type (no corruption, no duplicate).
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.wit.ai/speech?v=20240304',
        headers: {
          'Authorization': 'Bearer ' + CFG.witAiToken
        },
        data: new Blob([audioBuffer], { type: 'audio/mpeg3' }),
        responseType: 'text',
        onload: (resp) => {
          try {
            log(`wit.ai response: ${resp.responseText.replace(/\s+/g, ' ').slice(0, 160)}`);
            // wit.ai streams multiple pretty-printed JSON objects. Extract every "text":"..."
            // and take the last non-empty one (the final transcription).
            let text = '';
            const matches = [...resp.responseText.matchAll(/"text"\s*:\s*"([^"]*)"/g)];
            for (const m of matches) {
              if (m[1] && m[1].trim()) text = m[1].trim();
            }
            resolve(text.toLowerCase());
          } catch (e) {
            reject(new Error('parse error: ' + e.message));
          }
        },
        onerror: (e) => reject(new Error('wit.ai request failed')),
        ontimeout: () => reject(new Error('wit.ai timeout'))
      });
    });
  }

  function tryBusterClick() {
    const holder = document.querySelector('.help-button-holder');
    if (holder) {
      const target = holder.querySelector('button') || holder.querySelector('svg') || holder;
      ['mousedown', 'mouseup', 'click'].forEach(type => {
        try { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
      });
      log('Buster fallback click attempted (may not work — isTrusted issue)');
    }
  }


  // ================================================================
  //  STEP 0 — QUEUE PAGE: auto-open matching Affable HIT in new tab
  // ================================================================
  if (location.hostname === 'worker.mturk.com' && /^\/tasks\/?$/.test(location.pathname)) {
    log('Queue watcher active — waiting for matching Affable HIT');
    watchQueue();
    return;
  }

  // ================================================================
  //  STEP A — INSTAGRAM
  // ================================================================
  if (href.includes('instagram.com/')) {
    log('Instagram detected');
    initIG();
    return;
  }

  // ================================================================
  //  STEP B — AFFABLE FORM PAGE (runs inside iframe on worker.mturk.com)
  //  NOTE: redirect removed — script works directly in the iframe
  // ================================================================
  setTimeout(() => {
    const bt = document.body ? (document.body.innerText || '') : '';
    if (bt.includes('CLICK HERE TO ACCESS') ||
        (bt.includes('credentials to login to Instagram') && bt.includes('Followers'))) {
      log('Affable form page detected!');
      processForm();
    }
  }, 1500);
  // also retry for late-loading iframes
  let chk = 0;
  const chkIv = setInterval(() => {
    const bt = document.body ? (document.body.innerText || '') : '';
    if (bt.includes('CLICK HERE TO ACCESS') ||
        (bt.includes('credentials to login to Instagram') && bt.includes('Followers'))) {
      clearInterval(chkIv);
      if (!window.__affStarted) { window.__affStarted = true; log('Affable form (delayed)!'); processForm(); }
    }
    if (++chk > 8) clearInterval(chkIv);
  }, 2000);

  // ================================================================
  //  QUEUE WATCHER — auto-open matching Affable HIT
  // ================================================================
  function watchQueue() {
    let logged = false;
    const check = () => {
      const works = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]'))
        .filter(b => /^\s*work\s*$/i.test((b.textContent || b.value || '').trim()));

      const pageText = document.body ? document.body.innerText : '';
      const pageHasAffable = pageText.includes('Affable');
      const pageHasTitle = pageText.includes('Infer Data From Website');
      const pageHasReward = /0\.03/.test(pageText);

      if (!logged) {
        log(`Queue watcher: ${works.length} Work btn(s) | page Affable=${pageHasAffable} title=${pageHasTitle} $0.03=${pageHasReward}`);
        if (works.length) logged = true;  // only mark logged once buttons exist
      }

      // Primary: match a Work button to its row
      for (const work of works) {
        let row = work;
        for (let i = 0; i < 12 && row; i++) {
          row = row.parentElement;
          if (!row) break;
          const text = row.textContent || '';
          if (text.includes('Affable') && text.includes('Infer Data From Website') && /0\.03/.test(text)) {
            return openWork(work, text);
          }
          if (row.tagName === 'BODY') break;
        }
      }

      // Fallback: exactly one Work button + page clearly has the Affable HIT
      if (works.length === 1 && pageHasAffable && pageHasTitle && pageHasReward) {
        return openWork(works[0], pageText.slice(0, 60));
      }
    };

    setTimeout(check, 1200);
    setInterval(check, 1500);
  }

  async function openWork(work, keyText) {
    if ((await authState()) !== true) return;   // only allowlisted Worker IDs auto-open HITs
    const url = work.href || work.getAttribute('href') || '';
    const key = url || (keyText || '').replace(/\s+/g, ' ').slice(0, 60);
    if (openedHITs.has(key)) return;
    openedHITs.add(key);
    if (url) {
      log('✓ Affable HIT matched — opening new tab');
      GM_openInTab(url, { active: false, insert: true });
    } else {
      log('✓ Affable HIT matched — clicking Work');
      work.click();
    }
  }

  // ================================================================
  //  FORM PROCESSING
  // ================================================================
  async function processForm() {
    if (window.__affStarted) return;
    window.__affStarted = true;

    // ACCESS CONTROL — re-verify against the sheet RIGHT NOW (fresh, no cache) before any work
    if (!(await requireFreshAuth())) { log('⛔ Worker not authorized — automation disabled (check the Google Sheet)'); return; }

    // Cross-context lock — main frame + iframe both match the form; only ONE should run.
    // Last writer wins: both write a unique id, wait, then only the last writer proceeds.
    const myId = 'inst_' + Math.random().toString(36).slice(2, 10);
    try {
      await GM_setValue('aff_lock', JSON.stringify({ ts: Date.now(), id: myId }));
      await sleep(400);
      const raw = await GM_getValue('aff_lock', '');
      const lk = raw ? JSON.parse(raw) : null;
      if (!lk || lk.id !== myId) { log('Another instance is handling this HIT — skipping duplicate'); return; }
    } catch (e) {}

    const igURL = findIGLink();
    if (!igURL) { log('ERROR: Instagram link not found'); return; }
    log(`Instagram URL: ${igURL}`);

    const m = igURL.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    if (!m) { log('Cannot extract username'); return; }
    const taskUser = m[1];   // keys the fresh-reload guard so one profile can't reload forever
    window.__affUser = taskUser;   // share the key with the persistent expiry watcher

    await GM_setValue('aff_task', JSON.stringify({ username: m[1], url: igURL, status: 'pending', ts: Date.now() }));
    log('Opening Instagram tab...');
    // Open ACTIVE — background tabs are throttled, IG lazy-load won't fire there
    const igTab = GM_openInTab(igURL, { active: false, insert: true });

    log('Waiting for follower data...');
    const result = await pollResult(120000);  // up to 2 min — collecting 28 takes time
    if (!result || !result.followers || result.followers.length < 1) {
      log('ERROR: No follower data received');
      return;
    }
    log(`Got ${result.followers.length} followers!`);
    try { igTab.close(); } catch (e) {}

    await fillForm(result.followers);

    // CAPTCHA — hand off to a persistent driver. It keeps the challenge triggered, auto-submits the
    // instant the token appears (even much later), and — via the anchor iframe — RE-CLICKS the
    // checkbox whenever "Verification expired. Check the checkbox again." shows. If re-clicking can't
    // recover it, the driver does a fresh reload (the user's proven fix), capped by maxReloads.
    log('Form filled — starting CAPTCHA driver (auto re-click on expiry, auto-submit on solve)…');
    startCaptchaDriver(taskUser);
  }

  function findIGLink() {
    for (const a of document.querySelectorAll('a')) {
      const text = (a.textContent || '').trim();
      if (a.href && a.href.includes('instagram.com/')) {
        const m = a.href.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
        if (m && !SKIP.includes(m[1])) return a.href;
      }
      if (text.includes('CLICK HERE') || text.includes('ACCESS THE PAGE')) {
        if (a.href && a.href.includes('instagram.com')) return a.href;
        const um = text.match(/of[:\s]+([a-zA-Z0-9._]+)/i);
        if (um) return `https://www.instagram.com/${um[1]}/`;
      }
    }
    const hm = (document.body.innerHTML || '').match(/https?:\/\/(www\.)?instagram\.com\/([a-zA-Z0-9._]+)/);
    return hm ? hm[0] : null;
  }

  async function fillForm(followerData) {
    // Diagnostic: list crowd-* elements so we can target shadow-DOM fields
    const crowds = Array.from(document.querySelectorAll('crowd-input, crowd-text-area, crowd-button, crowd-slider, crowd-radio-button')).map(c =>
      `${c.tagName.toLowerCase()}{id:"${c.id}" name:"${c.getAttribute('name')||''}" label:"${(c.getAttribute('label')||'').slice(0,20)}"}`
    );
    if (crowds.length) log(`crowd elements: ${crowds.join(' | ')}`);

    // LOCATION
    const locEl = findLocationField();
    if (locEl) {
      const tag = (locEl.tagName || '').toLowerCase();
      if (tag === 'crowd-input' || tag === 'crowd-text-area') {
        try { locEl.value = CFG.location; } catch (e) {}
        const inner = locEl.shadowRoot && locEl.shadowRoot.querySelector('input, textarea');
        if (inner) setVal(inner, CFG.location);
        locEl.dispatchEvent(new Event('input', { bubbles: true }));
        locEl.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Location ✓ (${CFG.location}) → crowd-input id="${locEl.id}"`);
      } else if (locEl.isContentEditable || locEl.getAttribute('contenteditable') !== null) {
        locEl.focus();
        try { document.execCommand('insertText', false, CFG.location); } catch (e) { locEl.innerText = CFG.location; }
        if (!locEl.innerText.trim()) locEl.innerText = CFG.location;
        locEl.dispatchEvent(new Event('input', { bubbles: true }));
        log(`Location ✓ (${CFG.location}) → contenteditable`);
      } else {
        setVal(locEl, CFG.location);
        log(`Location ✓ (${CFG.location}) → ${tag} id="${locEl.id}"`);
      }
    } else {
      log('Location field NOT found');
    }
    await sleep(250);

    // FOLLOWERS — build clean HTML (small pics + username + name + Follow) like manual copy
    const fBox = findFollowersBox();
    if (fBox) {
      log(`Followers box: tag=${fBox.tagName} id="${fBox.id}" editable=${fBox.isContentEditable}`);
      const html = buildFollowerHTML(followerData);
      pasteHTML(fBox, html);
      await sleep(300);
      const imgs = fBox.querySelectorAll('img').length;
      const chars = (fBox.innerText || '').trim().length;
      log(`Followers pasted ✓ (${followerData.length} rows, ${imgs} imgs, ${chars} chars in box)`);
    } else {
      log('Followers box NOT found');
    }
  }

  // Build clean follower entries that render like a manual Instagram copy-paste
  function buildFollowerHTML(data) {
    const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    return data.map(f => {
      const uname = esc(f.username);
      const dname = esc(f.displayName);
      const src = esc(f.avatarSrc);
      return `<div style="display:flex;align-items:center;padding:6px 2px;font-family:sans-serif;">` +
               `<img src="${src}" alt="${uname}'s profile picture" width="44" height="44" ` +
                 `style="width:44px;height:44px;border-radius:50%;margin-right:12px;object-fit:cover;flex:0 0 auto;">` +
               `<div style="display:flex;flex-direction:column;line-height:1.2;flex:1 1 auto;">` +
                 `<span style="font-weight:600;color:#262626;">${uname}</span>` +
                 (dname ? `<span style="color:#8e8e8e;">${dname}</span>` : ``) +
               `</div>` +
               `<button type="button" style="margin-left:auto;background:#0095f6;color:#fff;border:none;` +
                 `border-radius:8px;padding:7px 16px;font-weight:600;cursor:pointer;flex:0 0 auto;">Follow</button>` +
             `</div>`;
    }).join('');
  }

  function findLocationField() {
    // 1) crowd-input / crowd-text-area matching location
    for (const ci of document.querySelectorAll('crowd-input, crowd-text-area')) {
      const meta = [ci.id, ci.getAttribute('name') || '', ci.getAttribute('label') || '', ci.getAttribute('placeholder') || ''].join(' ').toLowerCase();
      const near = (((ci.previousElementSibling || {}).textContent || '') + ' ' + ((ci.parentElement || {}).textContent || '').slice(0, 80)).toLowerCase();
      if (/location|country|united/.test(meta) || near.includes('location')) return ci;
    }
    // 2) standard text inputs
    const std = findInput(['location', 'country', 'e.g. United']);
    if (std) return std;
    for (const inp of document.querySelectorAll('input')) {
      const ph = (inp.placeholder || '').toLowerCase();
      if (ph.includes('united') || ph.includes('country') || ph.includes('location')) return inp;
    }
    // 3) input/contenteditable near "Location" label
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (/^location/i.test(n.textContent.trim())) {
        let el = n.parentElement;
        for (let i = 0; i < 6 && el; i++) {
          el = el.nextElementSibling;
          if (!el) break;
          if (el.matches && el.matches('input, crowd-input')) return el;
          const inner = el.querySelector && el.querySelector('input, crowd-input');
          if (inner) return inner;
        }
      }
    }
    // 4) only-one-crowd-input fallback (if there's a single crowd-input, it's likely location)
    const cis = document.querySelectorAll('crowd-input');
    if (cis.length === 1) return cis[0];
    return null;
  }

  function findInput(keywords) {
    const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])');
    for (const inp of inputs) {
      const hay = [inp.placeholder||'', inp.name||'', inp.id||'',
        (inp.closest('label')||{}).textContent||'',
        (inp.previousElementSibling||{}).textContent||'',
        ((inp.parentElement||{}).textContent||'').slice(0,120)].join(' ').toLowerCase();
      for (const kw of keywords) if (hay.includes(kw.toLowerCase())) return inp;
    }
    return null;
  }

  function findFollowersBox() {
    const pasteArea = document.querySelector('#pasteArea');
    if (pasteArea) return pasteArea;
    for (const ce of document.querySelectorAll('[contenteditable]')) {
      if (ce.offsetParent !== null && ce.id !== 'g-recaptcha-response') return ce;
    }
    return null;
  }

  function pasteHTML(box, html) {
    box.focus();
    // Method 1: direct innerHTML (renders the follower rows with imgs)
    box.innerHTML = html;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    // Method 2: also fire a paste event carrying text/html (in case form listens)
    try {
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', box.innerText || '');
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (e) {}
    box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Solved when the reCAPTCHA response token is populated
  function isCaptchaSolved() {
    const resp = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
    return !!(resp && resp.value && resp.value.length > 20);
  }

  async function clearCaptchaState() {
    await GM_setValue('aff_captcha', '');
    await GM_setValue('aff_captcha_expired', '');
  }

  // Fresh-reload guard so a stuck profile can't reload forever (keyed per Instagram username,
  // auto-expires after 10 min so a later HIT on the same profile starts with a clean count)
  async function getReloadCount(username) {
    try {
      const raw = await GM_getValue('aff_reload', '');
      if (raw) {
        const r = JSON.parse(raw);
        if (r.username === username && Date.now() - r.ts < 600000) return r.count || 0;
      }
    } catch (e) {}
    return 0;
  }
  async function bumpReloadCount(username, n) {
    try { await GM_setValue('aff_reload', JSON.stringify({ username, count: n, ts: Date.now() })); } catch (e) {}
  }

  // Shared key for the reload guard (cached username, or derived from the form's IG link)
  function formUserKey() {
    if (window.__affUser) return window.__affUser;
    try {
      const link = findIGLink();
      const mm = link && link.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
      if (mm) { window.__affUser = mm[1]; return mm[1]; }
    } catch (e) {}
    return 'form';
  }

  // PERSISTENT captcha driver (form frame). Runs until the captcha is solved — it does NOT give up
  // when the HIT's time runs low — so a late solve (e.g. after several checkbox re-clicks) still
  // gets submitted. Each tick it:
  //   1) submits the instant the reCAPTCHA token appears (solved by re-click / audio / manual),
  //   2) keeps the challenge triggered so the anchor (re)clicks and the bframe self-solves,
  //   3) on an escalated expiry (anchor gave up re-clicking, or a hard block) does a fresh reload,
  //      capped by maxReloads — the user's proven fix when in-place recovery fails.
  function startCaptchaDriver(user) {
    if (window.__affCapDriver) return;
    window.__affCapDriver = true;
    try { GM_setValue('aff_captcha_expired', ''); } catch (e) {}   // clear any stale flag
    let lastTrigger = 0, firstLog = true, busy = false;
    const iv = setInterval(async () => {
      if (window.__affReloading) { clearInterval(iv); return; }
      if (busy) return;                 // don't let async ticks overlap (avoid double-submit)
      busy = true;
      try {

      // 1) Solved → submit once and stop.
      if (isCaptchaSolved()) {
        clearInterval(iv);
        window.__affCapDriver = false;
        log('CAPTCHA solved ✓');
        await clearCaptchaState();
        await bumpReloadCount(user, 0);              // reset the fresh-reload guard on success
        if (CFG.autoSubmit) { await sleep(700); clickSubmit(); log('Submitted ✓'); }
        else log('autoSubmit OFF — solved, submit manually (set autoSubmit:true for full auto)');
        await GM_setValue('aff_task', '');
        await GM_setValue('aff_result', '');
        await GM_setValue('aff_ig_debug', '');
        return;
      }

      // 2) Keep the challenge triggered so the anchor (re)clicks + the bframe self-solves.
      if (Date.now() - lastTrigger > 12000) {
        lastTrigger = Date.now();
        try { await GM_setValue('aff_captcha', JSON.stringify({ ts: Date.now() })); } catch (e) {}
        if (firstLog) { log('CAPTCHA: driving — auto re-click on expiry, auto-submit on solve.'); firstLog = false; }
      }

      // 3) Escalated expiry (anchor re-clicks failed, or hard block) → fresh reload, capped.
      let flagged = false;
      try {
        const raw = await GM_getValue('aff_captcha_expired', '');
        if (raw) { const e = JSON.parse(raw); flagged = !!(e && e.ts && Date.now() - e.ts < 90000); }
      } catch (e) {}
      if (flagged && CFG.reloadOnExpire) {
        const n = await getReloadCount(user);
        if (n < CFG.maxReloads) {
          window.__affReloading = true;
          clearInterval(iv);
          await bumpReloadCount(user, n + 1);
          await clearCaptchaState();
          await GM_setValue('aff_result', '');
          await GM_setValue('aff_ig_debug', '');
          log(`CAPTCHA couldn't be recovered — fresh reload ${n + 1}/${CFG.maxReloads} (close & reopen)…`);
          await sleep(600);
          location.reload();
          return;
        }
        try { await GM_setValue('aff_captcha_expired', ''); } catch (e) {}  // capped — clear, keep watching for a manual solve
      }

      } finally { busy = false; }
    }, 1000);
  }

  function clickSubmit() {
    // Amazon Crowd HTML <crowd-button> (custom element, real button in shadow DOM)
    const cb = document.querySelector('crowd-button[form-action="submit"]') ||
               document.querySelector('crowd-button[data-testid="crowd-submit"]') ||
               document.querySelector('crowd-button[variant="primary"]') ||
               document.querySelector('crowd-button');
    if (cb) {
      const inner = cb.shadowRoot && cb.shadowRoot.querySelector('button');
      if (inner) { inner.click(); log('Submit clicked (crowd-button shadow)'); return true; }
      cb.click(); log('Submit clicked (crowd-button)'); return true;
    }
    // standard submit
    let btn = document.querySelector('#submitButton, button[type="submit"], input[type="submit"]');
    if (btn) { btn.click(); log('Submit clicked'); return true; }
    // by text
    let found = false;
    document.querySelectorAll('button, input[type="button"]').forEach(b => {
      if (!found && /^\s*submit\s*$/i.test(b.textContent || b.value || '')) { b.click(); found = true; }
    });
    if (found) { log('Submit clicked (by text)'); return true; }
    log('Submit button NOT found');
    return false;
  }

  async function pollResult(timeout) {
    const t0 = Date.now();
    let lastDbg = '';
    while (Date.now() - t0 < timeout) {
      try {
        const dRaw = await GM_getValue('aff_ig_debug', '');
        if (dRaw) { const d = JSON.parse(dRaw); if (d.msg !== lastDbg) { log(`IG> ${d.msg}`); lastDbg = d.msg; } }
      } catch (e) {}
      try {
        const raw = await GM_getValue('aff_result', '');
        if (raw) { const d = JSON.parse(raw); if (d.status === 'done' && d.ts > t0 - 5000) return d; }
      } catch (e) {}
      await sleep(600);
    }
    return null;
  }

  // ================================================================
  //  INSTAGRAM MODE — capture follower ROW HTML (with imgs + Follow btn)
  // ================================================================
  function initIG() {
    setInterval(checkTask, 2000);
    setTimeout(checkTask, 800);
  }

  async function checkTask() {
    if ((await authState()) === false) return;   // block only if explicitly denied (processForm already gated)
    let raw;
    try { raw = await GM_getValue('aff_task', ''); } catch (e) { return; }
    if (!raw) return;
    let task;
    try { task = JSON.parse(raw); } catch (e) { return; }
    if (task.status !== 'pending') return;
    const cur = location.pathname.replace(/\/$/, '').toLowerCase();
    if (cur !== '/' + task.username.toLowerCase()) return;

    task.status = 'working';
    await GM_setValue('aff_task', JSON.stringify(task));
    log(`Extracting follower HTML for ${task.username}...`);
    await doExtract();
  }

  async function doExtract() {
    await GM_setValue('aff_ig_debug', '');  // clear stale debug from prior runs
    const uname = location.pathname.replace(/^\/+|\/+$/g, '');

    // ===== PRIMARY: Instagram internal API (no scrolling needed) =====
    try {
      await dbg('trying API...');
      const apiF = await fetchFollowersAPI(uname);
      if (apiF && apiF.length >= 25) {
        await dbg(`API SUCCESS: ${apiF.length} followers`);
        await sendResult(apiF, 'done');
        return;
      }
      await dbg(`API got only ${apiF ? apiF.length : 0} — falling back to scroll`);
    } catch (e) {
      await dbg(`API error (${e.message}) — falling back to scroll`);
    }

    // ===== FALLBACK: scroll the followers modal =====
    let clicked = false;
    const fLink = document.querySelector('a[href*="/followers"]');
    if (fLink) { fLink.click(); clicked = true; }
    else {
      document.querySelectorAll('a, span, button').forEach(el => {
        const t = (el.textContent || '').toLowerCase();
        if (!clicked && t.includes('follower') && !t.includes('following')) { el.click(); clicked = true; }
      });
    }
    if (!clicked) { await sendResult([], 'error'); return; }

    await sleep(3000);
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) { await sendResult([], 'error'); return; }

    const collected = new Map();
    grabRows(dialog, collected);
    await dbg(`initial: ${collected.size} followers`);

    let stuck = 0;
    for (let i = 0; i < 50 && collected.size < CFG.minFollowers; i++) {
      const before = collected.size;

      const scroller = findFollowerScroller(dialog);
      const beforeTop = scroller ? scroller.scrollTop : -1;

      // GRADUAL SCROLL — small steps with real wheel events (mimics manual scrolling)
      await gradualScroll(scroller, dialog);

      // Settle + grab — give Instagram time to load the next batch
      for (let w = 0; w < 6; w++) {
        await sleep(500);
        grabRows(dialog, collected);
        if (collected.size >= CFG.minFollowers) break;
      }
      const afterTop = scroller ? scroller.scrollTop : -1;

      if (collected.size === before) {
        stuck++;
        await dbg(`scroll ${i}: ${collected.size} | top ${beforeTop}→${afterTop} sh=${scroller ? scroller.scrollHeight : '?'} ch=${scroller ? scroller.clientHeight : '?'} stuck ${stuck}/8`);
        // Strong jiggle: up substantially then gradual back down
        if (scroller) {
          try {
            scroller.scrollTop = Math.floor(scroller.scrollHeight * 0.4);
            await sleep(600);
          } catch (e) {}
        }
        await gradualScroll(scroller, dialog);
        await sleep(1200);  // extra patience for slow batch loads
        grabRows(dialog, collected);
        if (stuck >= 8) { await dbg(`stuck at ${collected.size} — stopping`); break; }
      } else {
        stuck = 0;
        await dbg(`scroll ${i}: ${collected.size} | top ${beforeTop}→${afterTop}`);
      }
    }

    grabRows(dialog, collected);
    const rows = Array.from(collected.values());
    await dbg(`DONE: ${rows.length} followers`);
    await sendResult(rows, 'done');

    const closeBtn = dialog.querySelector('[aria-label="Close"]');
    if (closeBtn) (closeBtn.closest('button') || closeBtn).click();
  }

  // Gradual scroll to the bottom in small steps with real wheel events —
  // this mimics manual mouse-wheel scrolling, which reliably triggers IG lazy-load
  async function gradualScroll(scroller, dialog) {
    if (!scroller) {
      const links = dialog.querySelectorAll('a[href^="/"]');
      if (links.length) { try { links[links.length - 1].scrollIntoView({ block: 'end' }); } catch (e) {} }
      return;
    }
    const step = Math.max(180, Math.floor((scroller.clientHeight || 400) * 0.75));
    for (let k = 0; k < 10; k++) {
      try {
        scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + step);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true }));
      } catch (e) {}
      await sleep(140);
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break; // hit bottom
    }
    // nudge the last follower into view too
    const links = dialog.querySelectorAll('a[href^="/"]');
    if (links.length) { try { links[links.length - 1].scrollIntoView({ block: 'end' }); } catch (e) {} }
  }

  // Find the scrollable container that actually holds the follower links
  function findFollowerScroller(dialog) {
    const link = dialog.querySelector('a[href^="/"]');
    if (link) {
      let el = link.parentElement;
      while (el && el !== dialog.parentElement) {
        try {
          const s = getComputedStyle(el);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5) {
            return el;
          }
        } catch (e) {}
        el = el.parentElement;
      }
    }
    // fallback: largest scrollable div in dialog
    let best = null, bestAmt = 0;
    dialog.querySelectorAll('div').forEach(d => {
      const amt = d.scrollHeight - d.clientHeight;
      if (amt > bestAmt) {
        try {
          const s = getComputedStyle(d);
          if (s.overflowY === 'auto' || s.overflowY === 'scroll') { best = d; bestAmt = amt; }
        } catch (e) {}
      }
    });
    return best || dialog;
  }

  // Extract structured data per follower: {username, avatarSrc, displayName}
  function grabRows(dialog, collected) {
    dialog.querySelectorAll('a[href]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (!m) return;
      const u = m[1];
      if (SKIP.includes(u)) return;
      if (collected.has(u)) return;

      // Walk up to the row (ancestor with a Follow button)
      let row = a.parentElement;
      for (let i = 0; i < 10 && row && row !== dialog; i++) {
        if (row.querySelector('button, [role="button"]')) break;
        row = row.parentElement;
      }
      if (!row) row = a.closest('div') || a.parentElement;

      // Avatar src
      const img = row ? row.querySelector('img') : null;
      const avatarSrc = img ? (img.src || img.getAttribute('src') || '') : '';

      // Display name: first span that isn't the username/Follow/etc.
      let displayName = '';
      if (row) {
        row.querySelectorAll('span').forEach(sp => {
          const t = sp.textContent.trim();
          if (!displayName && t && t !== u &&
              !['Follow','Following','Requested','Verified','Message'].includes(t) &&
              t.length > 0 && t.length < 60 && !/^\d+$/.test(t)) {
            displayName = t;
          }
        });
      }

      collected.set(u, { username: u, avatarSrc, displayName });
    });
  }

  // Apply EVERY scroll technique — one of them will trigger Instagram's lazy-load
  function scrollEverything(dialog, scroller) {
    // 1. The detected scroller
    if (scroller) {
      try {
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1500, bubbles: true }));
      } catch (e) {}
    }
    // 2. EVERY scrollable div inside the dialog
    dialog.querySelectorAll('div').forEach(d => {
      if (d.scrollHeight > d.clientHeight + 20) {
        try {
          d.scrollTop = d.scrollHeight;
          d.dispatchEvent(new Event('scroll', { bubbles: true }));
        } catch (e) {}
      }
    });
    // 3. Bring the last follower row into view (most reliable lazy-load trigger)
    const links = dialog.querySelectorAll('a[href^="/"]');
    if (links.length) {
      try { links[links.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' }); } catch (e) {}
    }
    // 4. Wheel event on the dialog itself
    try { dialog.dispatchEvent(new WheelEvent('wheel', { deltaY: 1500, bubbles: true })); } catch (e) {}
  }

  async function findRealScroller(dialog) {
    const candidates = [];
    dialog.querySelectorAll('div').forEach(d => {
      if (d.scrollHeight > d.clientHeight + 20) candidates.push(d);
    });
    candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    for (const c of candidates) {
      const orig = c.scrollTop;
      c.scrollTop = 50;
      if (c.scrollTop > orig) { c.scrollTop = orig; return c; }
      c.scrollTop = orig;
    }
    return candidates[0] || dialog;
  }

  async function dbg(msg) {
    log(`[IG] ${msg}`);
    try { await GM_setValue('aff_ig_debug', JSON.stringify({ msg, ts: Date.now() })); } catch (e) {}
  }

  // Fetch followers via Instagram's internal API — works regardless of tab focus/scroll
  async function fetchFollowersAPI(username) {
    const APP_ID = '936619743392459';
    const headers = { 'x-ig-app-id': APP_ID, 'x-requested-with': 'XMLHttpRequest' };

    // Step 1: resolve user id
    let userId = null;
    try {
      const r = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
                            { headers, credentials: 'include' });
      const j = await r.json();
      userId = j && j.data && j.data.user ? j.data.user.id : null;
    } catch (e) { await dbg('web_profile_info failed: ' + e.message); }

    if (!userId) {
      // fallback: scrape id from page HTML
      const html = document.documentElement.innerHTML;
      const m = html.match(/"profilePage_(\d+)"/) || html.match(/"user_id":"(\d+)"/) ||
                html.match(/"id":"(\d+)","is_private"/) || html.match(/"id":"(\d+)"/);
      userId = m ? m[1] : null;
    }
    if (!userId) throw new Error('no user id');
    await dbg('user id: ' + userId);

    // Step 2: paginate followers
    const out = [];
    let maxId = '';
    for (let page = 0; page < 4 && out.length < CFG.minFollowers; page++) {
      let url = `/api/v1/friendships/${userId}/followers/?count=25`;
      if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
      const r = await fetch(url, { headers, credentials: 'include' });
      if (!r.ok) throw new Error('followers HTTP ' + r.status);
      const j = await r.json();
      if (!j.users || !j.users.length) break;
      j.users.forEach(u => out.push({
        username: u.username,
        displayName: u.full_name || '',
        avatarSrc: u.profile_pic_url || ''
      }));
      await dbg(`API page ${page}: total ${out.length}`);
      if (!j.next_max_id) break;
      maxId = j.next_max_id;
      await sleep(700);
    }
    return out;
  }

  async function sendResult(followers, status) {
    await GM_setValue('aff_result', JSON.stringify({ followers, status, ts: Date.now() }));
  }

})();
