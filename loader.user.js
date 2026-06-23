// ==UserScript==
// @name         Affable Auto (Loader)
// @namespace    mturk-affable-auto
// @version      2.3.1
// @description  Encrypted loader — fetches your AES-encrypted Affable logic (repo-hosted Affable.json) and runs it after you enter the password once. Maintainer ships updates by committing a new Affable.json; no reinstall.
// @author       nkorim321
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      gist.githubusercontent.com
// @connect      raw.githubusercontent.com
// @connect      githubusercontent.com
// @connect      api.wit.ai
// @connect      www.google.com
// @connect      google.com
// @connect      recaptcha.net
// @connect      *.google.com
// @connect      *.gstatic.com
// @connect      *
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/nkorim321-creator/Affable/claude/pensive-babbage-b3k36t/loader.user.js
// @downloadURL  https://raw.githubusercontent.com/nkorim321-creator/Affable/claude/pensive-babbage-b3k36t/loader.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================ LOADER CONFIG ============================
  // 🔒 Your ENCRYPTED Test.user.js, hosted in the repo (raw link). Public is fine — it's AES-GCM
  //    encrypted, useless without your password. The maintainer can update it by committing a new
  //    Affable.json; this loader auto-pulls it. (A runtime URL set via the Tampermonkey menu still
  //    overrides this and survives loader auto-updates.)
  const PAYLOAD_URL = 'https://raw.githubusercontent.com/nkorim321-creator/Affable/claude/pensive-babbage-b3k36t/Affable.json';

  const CFG = {
    urlKey:     'aff_payload_url_v2',  // GM-stored payload URL (survives loader updates; optional override)
    payloadKey: 'aff_payload_enc_v2',  // GM cache of the last good encrypted blob (shared across frames)
    pwKey:      'aff_pw_v1',           // GM cache of the password (so it asks only once)
    cacheFreshMs: 300000,              // reuse the shared cached payload if newer than this (no re-fetch)
    cacheMaxMs: 86400000,              // run cached payload up to 24h old if the network is down
    subWaitMs:  9000,                  // how long a sub-frame waits for the top frame's copy + password
    fetchTimeoutMs: 20000,
  };
  // ======================================================================

  const LTAG  = '[AffLoader]';
  const llog  = (m) => { try { console.log(`${LTAG} ${m}`); } catch (e) {} };
  const lerr  = (m, e) => { try { console.error(`${LTAG} ${m}`, e || ''); } catch (x) {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (window.__affLoaderBooted) return;   // one boot per frame
  window.__affLoaderBooted = true;

  const isTop = (() => { try { return window.top === window.self; } catch (e) { return true; } })();
  const subtle = (self.crypto && self.crypto.subtle) || (window.crypto && window.crypto.subtle) || null;

  // Tampermonkey menu helpers (change password / change gist URL without reinstalling).
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Affable: reset password', () => {
        try { GM_setValue(CFG.pwKey, ''); GM_setValue(CFG.payloadKey, ''); } catch (e) {}
        try { alert('Affable: saved password + cached payload cleared.\nReload the page to enter the password again.'); } catch (e) {}
      });
      GM_registerMenuCommand('Affable: set / change gist URL', () => {
        let u = '';
        try { u = (window.prompt('Affable — paste your ENCRYPTED gist RAW link:', cacheGet(CFG.urlKey)) || '').trim(); } catch (e) {}
        if (u && /^https?:\/\//.test(u)) {
          try { GM_setValue(CFG.urlKey, u); GM_setValue(CFG.payloadKey, ''); } catch (e) {}
          try { alert('Affable: gist URL saved.\nReload the page.'); } catch (e) {}
        } else if (u) {
          try { alert('That does not look like a URL — not saved.'); } catch (e) {}
        }
      });
    }
  } catch (e) {}

  // ---- GM bridge (sandbox side) ----
  // Strict-CSP pages (e.g. Instagram) forbid eval, so the logic must run in the PAGE world via a
  // blob: <script>. Page-world code can't see Tampermonkey's GM_* — so it talks to this listener
  // over CustomEvents (JSON-string detail crosses the world boundary) and we run the real GM_* here.
  function setupGmBridge() {
    if (window.__affGmBridge) return;
    window.__affGmBridge = true;
    document.addEventListener('aff-gm-req', async (e) => {
      let d; try { d = JSON.parse(e.detail); } catch (_) { return; }
      const reply = (o) => { try { document.dispatchEvent(new CustomEvent('aff-gm-res-' + d.id, { detail: JSON.stringify(o) })); } catch (_) {} };
      try {
        if (d.op === 'get') { const v = await GM_getValue(d.key, d.def); reply({ ok: true, v }); }
        else if (d.op === 'set') { await GM_setValue(d.key, d.val); reply({ ok: true }); }
        else if (d.op === 'openInTab') { try { GM_openInTab(d.url, d.opts || {}); } catch (_) {} reply({ ok: true }); }
        else if (d.op === 'xhr') {
          const req = { method: d.method || 'GET', url: d.url, headers: d.headers || {}, responseType: d.responseType, timeout: d.timeout };
          if (d.dataB64 != null) req.data = new Blob([b64ToBytes(d.dataB64)], { type: d.dataType || 'application/octet-stream' });
          else if (d.dataStr != null) req.data = d.dataStr;
          req.onload = (r) => { const o = { ev: 'load', status: r.status, responseText: r.responseText }; if (r.response && d.responseType === 'arraybuffer') { try { o.responseB64 = bytesToB64(new Uint8Array(r.response)); } catch (_) {} } reply(o); };
          req.onerror = () => reply({ ev: 'error' });
          req.ontimeout = () => reply({ ev: 'timeout' });
          GM_xmlhttpRequest(req);
        }
      } catch (err) { reply({ ev: 'error', ok: false }); }
    });
  }

  // ---- GM bridge (page side) — prepended to the logic in blob mode so its GM_* calls reach us ----
  const AFF_PRELUDE =
    '(function(){if(window.__affBridged)return;window.__affBridged=true;var n=0;' +
    'function b2b(b){var s="",a=new Uint8Array(b);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s);}' +
    'function f2b(s){var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}' +
    'function rpc(p){return new Promise(function(res){var id="b"+(++n)+"_"+Date.now();p.id=id;function h(e){document.removeEventListener("aff-gm-res-"+id,h);var r;try{r=JSON.parse(e.detail);}catch(_){r={};}res(r);}document.addEventListener("aff-gm-res-"+id,h);document.dispatchEvent(new CustomEvent("aff-gm-req",{detail:JSON.stringify(p)}));});}' +
    'window.GM_getValue=function(k,d){return rpc({op:"get",key:k,def:d}).then(function(r){return r&&r.ok?r.v:d;});};' +
    'window.GM_setValue=function(k,v){return rpc({op:"set",key:k,val:v}).then(function(){return true;});};' +
    'window.GM_openInTab=function(u,o){rpc({op:"openInTab",url:u,opts:o||{}});return{close:function(){},closed:false};};' +
    'window.GM_xmlhttpRequest=function(opts){function fire(b64,t){var id="x"+(++n)+"_"+Date.now();var p={op:"xhr",id:id,method:opts.method||"GET",url:opts.url,headers:opts.headers||{},responseType:opts.responseType,timeout:opts.timeout};if(b64!=null){p.dataB64=b64;p.dataType=t;}else if(typeof opts.data==="string"){p.dataStr=opts.data;}function h(e){var r;try{r=JSON.parse(e.detail);}catch(_){r={};}if(r.ev==="load"){document.removeEventListener("aff-gm-res-"+id,h);var resp={status:r.status,responseText:r.responseText||""};if(r.responseB64!=null){resp.response=f2b(r.responseB64).buffer;}if(opts.onload)try{opts.onload(resp);}catch(_){}}else if(r.ev==="error"){document.removeEventListener("aff-gm-res-"+id,h);if(opts.onerror)try{opts.onerror({});}catch(_){}}else if(r.ev==="timeout"){document.removeEventListener("aff-gm-res-"+id,h);if(opts.ontimeout)try{opts.ontimeout({});}catch(_){}}}document.addEventListener("aff-gm-res-"+id,h);document.dispatchEvent(new CustomEvent("aff-gm-req",{detail:JSON.stringify(p)}));}' +
    'var d=opts.data;if(d&&typeof Blob!=="undefined"&&d instanceof Blob){var fr=new FileReader();fr.onload=function(){fire(String(fr.result).split(",")[1],d.type||"application/octet-stream");};fr.readAsDataURL(d);}else if(d&&d instanceof ArrayBuffer){fire(b2b(d),"application/octet-stream");}else{fire(null,null);}};' +
    '})();';

  // ---- Run the decrypted logic in THIS frame ----
  function runLogic(code, src) {
    if (window.__affLogicRan) return;       // never run twice in one frame
    window.__affLogicRan = true;
    setupGmBridge();
    // 1) Sandbox eval — works on lenient-CSP pages (mturk etc.), keeps GM_* native and in-scope.
    try { eval(code); llog(`logic running (${src})`); return; }
    catch (e) { llog(`eval blocked by page CSP — switching to blob mode (${String(e).slice(0, 50)})`); }
    // 2) Strict-CSP pages (e.g. Instagram) allow blob: scripts → run there; GM_* go via the bridge.
    try {
      const blob = new Blob([AFF_PRELUDE + '\n;\n' + code], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const s = document.createElement('script');
      s.src = url;
      s.onload = function () { try { URL.revokeObjectURL(url); } catch (_) {} };
      (document.head || document.documentElement || document.body).appendChild(s);
      llog(`logic running (${src}, blob/page mode)`);
    } catch (e2) { lerr('could not run logic under strict CSP:', e2); }
  }

  // ---- GM cache helpers (synchronous in Tampermonkey) ----
  function cacheGet(key) { try { return GM_getValue(key, ''); } catch (e) { return ''; } }
  function cacheSet(key, val) { try { GM_setValue(key, val); } catch (e) {} }

  function readPayload() {
    const raw = cacheGet(CFG.payloadKey);
    if (raw) { try { const c = JSON.parse(raw); if (c && c.blob) return c; } catch (e) {} }
    return null;
  }
  function writePayload(blob) { cacheSet(CFG.payloadKey, JSON.stringify({ blob, ts: Date.now() })); }

  // ---- base64 <-> bytes ----
  function b64ToBytes(str) {
    const bin = atob(String(str).trim());
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function bytesToB64(bytes) {
    let s = ''; const a = new Uint8Array(bytes);
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }

  // ---- AES-GCM / PBKDF2 decrypt (matches encrypt.html exactly) ----
  async function decryptBlob(blobText, password) {
    if (!subtle) throw new Error('WebCrypto unavailable (need an https page)');
    const obj = JSON.parse(blobText);
    const enc = new TextEncoder();
    const salt = b64ToBytes(obj.salt);
    const iv   = b64ToBytes(obj.iv);
    const ct   = b64ToBytes(obj.ct);
    const keyMaterial = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: obj.iter || 200000, hash: obj.hash || 'SHA-256' },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  // ---- Masked password dialog: a custom overlay with <input type="password"> so the typed
  //      characters show as dots (window.prompt would show them in plaintext). Styles are set via
  //      the CSSOM (el.style.*) so a strict page CSP can't strip them. ----
  function promptPasswordMasked(message) {
    return new Promise((resolve) => {
      let waited = 0;
      (function build() {
        if (!document.body) {
          if ((waited += 50) > 15000) return resolve('');   // body never appeared
          return setTimeout(build, 50);
        }
        const S = (el, styles) => { Object.assign(el.style, styles); return el; };
        const ov = S(document.createElement('div'), {
          position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', zIndex: '2147483647',
          background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
        });
        const box = S(document.createElement('div'), {
          background: '#fff', color: '#111', minWidth: '300px', maxWidth: '92vw',
          padding: '18px 20px', borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.35)'
        });
        const title = S(document.createElement('div'), { fontSize: '15px', fontWeight: '600', marginBottom: '10px' });
        title.textContent = message || '🔒 Enter password';
        const inp = S(document.createElement('input'), {
          width: '100%', boxSizing: 'border-box', padding: '9px 10px', fontSize: '14px',
          border: '1px solid #bbb', borderRadius: '8px', outline: 'none', color: '#111', background: '#fff'
        });
        inp.type = 'password';
        inp.autocomplete = 'off';
        const row = S(document.createElement('div'), { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' });
        const mkBtn = (txt, bg, fg) => S(Object.assign(document.createElement('button'), { textContent: txt, type: 'button' }), {
          padding: '8px 16px', fontSize: '14px', fontWeight: '600', border: 'none', borderRadius: '8px', cursor: 'pointer', background: bg, color: fg
        });
        const ok = mkBtn('OK', '#0095f6', '#fff');
        const cancel = mkBtn('Cancel', '#e4e6eb', '#111');
        row.appendChild(cancel); row.appendChild(ok);
        box.appendChild(title); box.appendChild(inp); box.appendChild(row);
        ov.appendChild(box);
        document.body.appendChild(ov);
        setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);

        let done = false;
        const finish = (val) => { if (done) return; done = true; try { ov.remove(); } catch (e) {} resolve(val || ''); };
        ok.addEventListener('click', () => finish(inp.value));
        cancel.addEventListener('click', () => finish(''));
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); finish(inp.value); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(''); }
        });
      })();
    });
  }

  // ---- Password: cached, else a VISIBLE top frame prompts once (masked); everything else waits ----
  async function getPassword(forcePrompt) {
    if (!forcePrompt) { const p = cacheGet(CFG.pwKey); if (p) return p; }
    // Only a foreground tab prompts. A background tab we opened ourselves (the Instagram follower
    // tab opens with active:false) must NOT show an invisible prompt that would freeze it — it waits
    // for the password the visible tab already cached.
    const visible = (typeof document === 'undefined') || document.visibilityState !== 'hidden';
    if (isTop && visible) {
      let p = '';
      try { p = await promptPasswordMasked('🔒 Affable — enter password to unlock the script:'); } catch (e) {}
      if (p) cacheSet(CFG.pwKey, p);
      return p;
    }
    // sub-frame OR background tab: wait for the password a visible tab cached
    const start = Date.now();
    while (Date.now() - start < CFG.subWaitMs) {
      const p = cacheGet(CFG.pwKey);
      if (p) return p;
      await sleep(250);
    }
    return '';
  }

  // ---- Where the encrypted blob lives: GM-stored URL (survives loader updates) > hard-coded default ----
  function getPayloadURL() {
    const u = cacheGet(CFG.urlKey);
    if (u && /^https?:\/\//.test(u)) return u;
    if (PAYLOAD_URL && PAYLOAD_URL.indexOf('PASTE_YOUR') !== 0 && /^https?:\/\//.test(PAYLOAD_URL)) return PAYLOAD_URL;
    return '';
  }
  // Top frame: ask for the gist URL once if none is set yet, and remember it.
  async function ensurePayloadURL() {
    let u = getPayloadURL();
    if (u) return u;
    const visible = (typeof document === 'undefined') || document.visibilityState !== 'hidden';
    if (isTop && visible) {
      try { u = (window.prompt('Affable — paste your ENCRYPTED gist RAW link (asked once):') || '').trim(); } catch (e) {}
      if (u && /^https?:\/\//.test(u)) { cacheSet(CFG.urlKey, u); return u; }
      lerr('no gist URL provided');
      return '';
    }
    const start = Date.now();                          // sub-frame: wait for the top frame to store it
    while (Date.now() - start < CFG.subWaitMs) {
      u = getPayloadURL();
      if (u) return u;
      await sleep(250);
    }
    return '';
  }

  // ---- Fetch the encrypted blob from the Gist (promise) ----
  function fetchPayload(baseUrl) {
    return new Promise((resolve) => {
      if (!baseUrl) { lerr('no payload URL'); return resolve(''); }
      const url = baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: CFG.fetchTimeoutMs,
        onload: (r) => {
          const txt = r && r.responseText;
          const ok = r && r.status >= 200 && r.status < 300 && txt && txt.indexOf('"ct"') !== -1;
          if (ok) { writePayload(txt); llog(`fetched encrypted payload (${(txt.length / 1024).toFixed(1)} KB)`); resolve(txt); }
          else { llog(`payload fetch HTTP ${r && r.status} / invalid (is the gist RAW link correct?)`); resolve(''); }
        },
        onerror:   () => { llog('payload fetch network error'); resolve(''); },
        ontimeout: () => { llog('payload fetch timeout'); resolve(''); },
      });
    });
  }

  // ---- Get the encrypted blob ----
  // A RECENT shared cache wins first — so the Instagram tab and the reCAPTCHA iframes (opened
  // mid-session) reuse exactly what the mturk page just fetched, instead of each hitting GitHub
  // again (which can hang or get rate-limited in a background tab). Only fetch fresh when the
  // cache is stale/missing; updates still land within cacheFreshMs of the next page load.
  async function getBlob() {
    const recent = readPayload();
    if (recent && recent.blob && (Date.now() - recent.ts) < CFG.cacheFreshMs) return recent.blob;

    if (isTop) {
      const url = await ensurePayloadURL();
      if (url) { const fresh = await fetchPayload(url); if (fresh) return fresh; }
      if (recent && recent.blob && (Date.now() - recent.ts) < CFG.cacheMaxMs) { llog('using cached payload'); return recent.blob; }
      return '';
    }
    // sub-frame: wait for the top frame's cached payload, else fetch self
    const start = Date.now();
    while (Date.now() - start < CFG.subWaitMs) {
      const c = readPayload();
      if (c && c.blob && (Date.now() - c.ts) < CFG.cacheMaxMs) return c.blob;
      await sleep(250);
    }
    const url = getPayloadURL();
    return url ? await fetchPayload(url) : '';
  }

  // ---- Main: fetch → decrypt (retry on wrong password) → run ----
  async function load() {
    const blob = await getBlob();
    if (!blob) { lerr('no payload available — check PAYLOAD_URL / network'); return; }

    for (let attempt = 0; attempt < 3; attempt++) {
      const pw = await getPassword(attempt > 0);     // re-prompt on a failed attempt (top frame)
      if (!pw) { if (isTop) lerr('no password entered'); return; }
      try {
        const code = await decryptBlob(blob, pw);
        if (code && code.indexOf('Affable') !== -1) { runLogic(code, 'decrypted'); return; }
        throw new Error('decrypted, but it is not the expected script');
      } catch (e) {
        lerr('decrypt failed (wrong password?)', e);
        cacheSet(CFG.pwKey, '');                      // clear bad password
        if (!isTop) return;                           // sub-frames don't prompt; top frame retries
      }
    }
    lerr('giving up after 3 password attempts — use the Tampermonkey menu to reset, then reload');
  }

  // ---- Only run on relevant frames (don't hit the gist on every random website) ----
  function isRelevantFrame() {
    const h = location.hostname || '';
    const href = location.href || '';
    if (href.indexOf('google.com/recaptcha/') !== -1) return true;   // reCAPTCHA anchor/bframe iframes
    if (/(^|\.)mturk\.com$/.test(h)) return true;                    // queue + HIT pages
    if (/(^|\.)instagram\.com$/.test(h)) return true;                // Instagram follower tab
    return false;
  }
  function bodyHasAffableForm() {
    const bt = document.body ? (document.body.innerText || '') : '';
    return bt.indexOf('CLICK HERE TO ACCESS') !== -1 ||
           (bt.indexOf('credentials to login to Instagram') !== -1 && bt.indexOf('Followers') !== -1);
  }

  function boot() {
    if (isRelevantFrame()) { load(); return; }
    // Unknown-origin frame (the Affable form iframe) → load only if its body shows the form markers.
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (window.__affLogicRan) { clearInterval(iv); return; }
      if (bodyHasAffableForm()) { clearInterval(iv); load(); return; }
      if (tries >= 14) clearInterval(iv);   // ~21s, no markers → not an Affable frame, stay idle
    }, 1500);
  }

  boot();
})();
