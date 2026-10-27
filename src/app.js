/* ===== App: data loading, UI, exports ===== */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const uiDefaults = () => { const d = Engine.defaults(); delete d.apiPages; return d; };
  const App = { S: uiDefaults(), bulk: null, bulkCombos: null, R: null, tab: 'setup', groupBy: 'type', openSwap: null, busy: false, tests: null, cmdIndex: null };
  window.EDHApp = App;

  /* ---------- storage helpers (optional conveniences) ---------- */
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
  const IDB = {
    open() { return new Promise((res, rej) => { try { const r = indexedDB.open('edhgen', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
    async put(k, v) { try { const db = await IDB.open(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
    async get(k) { try { const db = await IDB.open(); return await new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly'); const r = tx.objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch (e) { return null; } },
    async del(k) { try { const db = await IDB.open(); await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = res; }); } catch (e) { } }
  };

  /* ---------- bulk file loading ---------- */
  /* ---------- streaming JSON: yields each object that sits directly in a top-level array or in an array under one of `keys` ----------
     Works on minified or pretty-printed files of any size, and on .gz files where DecompressionStream exists. */
  async function parseBulkFile(file, onProgress) {
    const out = []; let parsed = 0;
    const handle = line => { let t = line.trim(); if (t.endsWith(',')) t = t.slice(0, -1); if (t[0] !== '{' || t[t.length - 1] !== '}') return; try { const c = JSON.parse(t); parsed++; const n = Engine.norm(c); if (n) out.push(n); } catch (e) { } };
    if (file.stream && typeof TextDecoderStream !== 'undefined') {
      const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
      let buf = '', read = 0;
      for (; ;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += value; read += value.length;
        let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
        onProgress(Math.min(0.99, read / Math.max(1, file.size)));
      }
      handle(buf);
    }
    if (!parsed) {
      const j = JSON.parse(await file.text());
      const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
      for (const c of arr) { parsed++; const n = Engine.norm(c); if (n) out.push(n); }
    }
    onProgress(1);
    return { cards: out, parsed };
  }
  const NORM_V = 2; // 2: card P/T and image path
  async function loadBulk(file, extra) {
    const prog = $('bulkProg'); prog.classList.remove('hidden');
    setStatus('Reading ' + file.name + '…');
    try {
      const { cards, parsed } = await parseBulkFile(file, f => { prog.firstElementChild.style.width = (f * 100).toFixed(0) + '%'; });
      if (!cards.length) throw new Error('No Scryfall card objects found (' + parsed + ' records parsed).');
      const meta = { source: 'Scryfall bulk file', ...(extra || {}), nv: NORM_V, file: file.name, fileModified: file.lastModified ? new Date(file.lastModified).toISOString() : null, loadedAt: new Date().toISOString(), records: parsed };
      App.bulk = Engine.buildDB(cards, meta); App.cmdIndex = null; $('secData').open = false; buildComboProvider(); loadAliases();
      setStatus('Loaded ' + App.bulk.all.length + ' unique cards from ' + file.name + '.');
      IDB.put('bulk', { cards, meta }).then(ok => { $('idbNote').textContent = ok ? 'Stored in this browser for next visit.' : ''; });
    } catch (e) { setStatus('Bulk file error: ' + e.message); showMsgs([e.message], []); }
    prog.classList.add('hidden'); renderSources();
  }
  /* ---------- data in the site's repo (GitHub Pages): the newest Scryfall bulk file in data/ ----------
     Finds it via data/index.json (written by the repo's "Data files" workflow), else the GitHub contents API (owner/repo
     from the Pages URL) when the index is missing, else a server directory listing, else fixed names.
     Accepts .json, .jsonl and their .gz forms, e.g. oracle-cards-20261016090200.jsonl.gz as downloaded from Scryfall.
     Reloads only when the file's sha / ETag changes; otherwise uses the copy stored in this browser. */
  const BULK_RE = /^(?:oracle-cards|default-cards|all-cards|unique-artwork|cards)[\w.-]*\.jsonl?(?:\.gz)?$/i;
  const pickNewest = files => { const ok = files.filter(f => BULK_RE.test(f.name)); const rank = n => /^oracle/i.test(n) ? 0 : /^default/i.test(n) ? 1 : 2; ok.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? 1 : -1)); return ok[0] || null; };
  async function repoFile() {
    if (!window.EDH_SITE || !/^https?:$/.test(location.protocol)) return null; // only the site build sets EDH_SITE
    const ix = await dataIndex();
    if (ix) { const f = pickNewest(ix.files.map(x => ({ name: x.name, size: x.size, sha: x.sha256 }))); if (f) return { url: 'data/' + f.name, tag: f.sha, size: f.size }; }
    const m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
    if (m) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      const repo = seg && !/\.html?$/i.test(seg) ? seg : m[1] + '.github.io';
      try {
        const r = await fetch('https://api.github.com/repos/' + m[1] + '/' + repo + '/contents/data', { cache: 'no-cache' });
        if (r.ok) { const f = pickNewest((await r.json()).map(x => ({ name: x.name, size: x.size, sha: x.sha }))); if (f) return { url: 'data/' + f.name, tag: f.sha, size: f.size }; }
      } catch (e) { }
    }
    try {
      const r = await fetch('data/', { cache: 'no-cache' });
      if (r.ok && /html/.test(r.headers.get('content-type') || '')) { const names = [...(await r.text()).matchAll(/href="([^"?#/]+)"/g)].map(x => ({ name: decodeURIComponent(x[1]) })); const f = pickNewest(names); if (f) return headInfo('data/' + f.name); }
    } catch (e) { }
    for (const n of ['data/cards.json.gz', 'data/cards.json', 'data/cards.jsonl.gz']) { const h = await headInfo(n); if (h) return h; }
    return null;
  }
  async function dataIndex() {
    if (App.dataIndex !== undefined) return App.dataIndex;
    let ix = null;
    try { const r = await fetch('data/index.json', { cache: 'no-cache' }); if (r.ok) ix = await r.json(); } catch (e) { }
    return (App.dataIndex = ix && Array.isArray(ix.files) ? ix : null);
  }
  /* ---------- Commander Spellbook combos: data/spellbook/ (manifest, name tables, row shards from tools/spellbook-shard.js).
     Static files from this site only. Downloaded when the manifest changes, otherwise read from this browser.
     Card data loads first and never depends on this step; a failure here only leaves combos unavailable. ---------- */
  const SB_FORMAT = 'edhgen-spellbook/1';
  async function loadSpellbook() {
    if (!window.EDH_SITE || !/^https?:$/.test(location.protocol)) return;
    App.combosLoading = true; renderSources();
    try {
      let man = null;
      try { const r = await fetch('data/spellbook/manifest.json', { cache: 'no-cache' }); if (r.ok) man = await r.json(); } catch (e) { }
      if (man && man.format !== SB_FORMAT) { setStatus('Combo data has an unknown format (' + man.format + '); combos are off.'); man = null; }
      const stored = await IDB.get('combos');
      const tag = man ? [man.format, man.timestamp, man.variants, man.tables.bytes].concat(man.shards.map(x => x.bytes)).join('|') : null;
      let data = stored && stored.format === SB_FORMAT && (!man || stored.tag === tag) ? stored : null;
      if (!data && man) {
        setStatus('Loading Commander Spellbook combos (' + man.variants.toLocaleString() + ')…');
        const get = async f => { const r = await fetch('data/spellbook/' + f, { cache: 'no-cache' }); if (!r.ok) throw new Error(f + ': HTTP ' + r.status); return r.json(); };
        const [tables, ...shards] = await Promise.all([get(man.tables.file)].concat(man.shards.map(x => get(x.file))));
        const rows = [].concat(...shards.map(x => x.rows));
        if (rows.length !== man.variants) throw new Error('expected ' + man.variants + ' combos, files hold ' + rows.length);
        data = { format: SB_FORMAT, tag, tables, rows, meta: { source: 'Commander Spellbook', timestamp: man.timestamp, version: man.version, count: man.variants } };
        IDB.put('combos', data);
        setStatus('Loaded ' + rows.length.toLocaleString() + ' Commander Spellbook combos.');
      }
      App.sbData = data; buildComboProvider();
    } catch (e) { App.bulkCombos = null; setStatus('Combo data not loaded: ' + e.message + '. Decks still build; combo checks are off.'); }
    App.combosLoading = false; renderSources(); renderView();
  }
  function buildComboProvider() {
    const d = App.sbData; App.bulkCombos = null; if (!d) return;
    App.bulkCombos = Engine.localComboProvider(Engine.spellbookVariants(d.tables, d.rows, App.bulk), d.meta);
  }
  async function headInfo(n) {
    try { const h = await fetch(n, { method: 'HEAD', cache: 'no-cache' }); if (h.ok) return { url: n, tag: h.headers.get('etag') || h.headers.get('last-modified') || '', size: +h.headers.get('content-length') || 0 }; } catch (e) { }
    return null;
  }
  async function fromRepo(f, loader) {
    const res = await fetch(f.url, { cache: 'no-cache' }); if (!res.ok || !res.body) throw new Error(f.url + ': HTTP ' + res.status);
    const gz = /\.gz$/.test(f.url) && !/gzip/i.test(res.headers.get('content-encoding') || ''); // a server that already sends Content-Encoding: gzip is unzipped by the browser
    if (gz && typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unzip ' + f.url);
    const body = gz ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
    let used = false;
    const src = { name: f.url.split('/').pop(), size: gz ? f.size * 8 : f.size, stream: () => { used = true; return body; }, text: () => used ? Promise.resolve('[]') : new Response(body).text() };
    await loader(src, { source: 'site data', tag: f.tag });
  }
  async function autoload() {
    const bulk = await IDB.get('bulk');
    const rc = await repoFile();
    const fresh = (stored, f) => stored && stored.meta && f && f.tag && stored.meta.tag === f.tag && stored.meta.nv === NORM_V; // NORM_V: stored cards predate a change to Engine.norm
    if (rc && !fresh(bulk, rc)) { try { await fromRepo(rc, loadBulk); } catch (e) { setStatus('Site card data: ' + e.message); } }
    if (!App.bulk && bulk && bulk.cards && bulk.cards.length) { App.bulk = Engine.buildDB(bulk.cards, bulk.meta); $('idbNote').textContent = 'Using stored card data: ' + (bulk.meta.file || '') + '.'; }
    renderSources(); renderView();
    await loadAliases();
    await loadSpellbook();
  }
  /* ---------- data/aliases.json: Universes Beyond flavour names and other printed names → Oracle names (tools/scryfall-aliases.js),
     so a pasted list that uses them matches. Optional: without the file only Oracle names match. ---------- */
  async function loadAliases() {
    if (!App.bulk || App.bulk.aliased != null || !window.EDH_SITE || !/^https?:$/.test(location.protocol)) return;
    try {
      const r = await fetch('data/aliases.json', { cache: 'no-cache' }); if (!r.ok) return;
      const j = await r.json(); if (j && j.format === 'edhgen-aliases/1') App.bulk.aliased = Engine.addAliases(App.bulk, j.names);
    } catch (e) { }
  }

  /* ---------- data state ---------- */
  function comboProvider() { return App.bulkCombos || null; }
  function renderSources() {
    const set = (id, cls, text) => { const el = $(id); el.innerHTML = '<span class="dot ' + cls + '"></span>' + esc(text); };
    set('pBulk', App.bulk ? 'ok' : '', App.bulk ? App.bulk.all.length.toLocaleString() + ' cards' : 'Card data not loaded');
    $('pBulk').title = App.bulk ? (App.bulk.meta.file || 'stored data') : '';
    $('dataHint').textContent = App.bulk ? (App.bulk.meta.file || 'loaded') : 'load a file';
    if (!App.bulk) $('secData').open = true;
    $('genBtn').disabled = App.busy || !App.bulk || !!App.combosLoading;
    $('qGen').disabled = $('genBtn').disabled;
    const cb = App.bulkCombos;
    $('pCombo').classList.toggle('hidden', !cb && !App.combosLoading);
    $('pCombo').innerHTML = '<span class="dot ' + (cb ? 'ok' : 'warn') + '"></span>' + (cb ? cb.count.toLocaleString() + ' combos' : 'Loading combos…');
    $('pCombo').title = cb ? 'Commander Spellbook, ' + (cb.meta.timestamp || '').slice(0, 10) : '';
    $('testBtn').disabled = App.busy || !App.bulk;
    if (!App.R && App.tab !== 'setup') renderView();
  }

  /* ---------- form binding ---------- */
  const getPath = (o, p) => p.split('.').reduce((a, k) => a == null ? undefined : a[k], o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) { if (a[ks[i]] == null) a[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {}; a = a[ks[i]]; } a[ks[ks.length - 1]] = v; };
  function readEl(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.dataset.type === 'num' || el.type === 'range') return el.value === '' ? null : +el.value;
    return el.value;
  }
  function readForm() { document.querySelectorAll('[data-k]').forEach(el => setPath(App.S, el.dataset.k, readEl(el))); return App.S; }
  function writeForm(S) {
    document.querySelectorAll('[data-k]').forEach(el => { const v = getPath(S, el.dataset.k); if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v; });
    $('varOut').textContent = (+S.variance).toFixed(2);
    { const B = Engine.BRACKETS[S.bracket] || {}; $('brHint').textContent = B.name ? 'Bracket ' + S.bracket + ' · games end turn ' + B.turns : ''; }
    syncQuick(S);
  }
  /* ---------- quick start: writes into the regular settings ---------- */
  const PLANS = {
    balanced: { label: 'Balanced', t: { lands: 37, ramp: 10, draw: 10, removal: 9, wipes: 3, protection: 3, recursion: 2, wincon: 3 }, mv: 3.0 },
    fast: { label: 'Fast', t: { lands: 34, ramp: 12, draw: 9, removal: 8, wipes: 1, protection: 3, recursion: 1, wincon: 5 }, mv: 2.6 },
    late: { label: 'Late game', t: { lands: 38, ramp: 13, draw: 10, removal: 8, wipes: 4, protection: 3, recursion: 3, wincon: 4 }, mv: 3.6 },
    control: { label: 'Control', t: { lands: 37, ramp: 10, draw: 12, removal: 12, wipes: 5, protection: 2, recursion: 2, wincon: 2 }, mv: 3.1 }
  };
  const tagList = S => String(S.tags || '').split(',').map(x => x.trim()).filter(Boolean);
  function syncQuick(S) {
    const plan = S.plan || 'balanced', P = PLANS[plan];
    document.querySelectorAll('#qPlan button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.plan === plan)));
    if ($('qPlanNote')) $('qPlanNote').textContent = P ? P.t.lands + ' lands · ' + P.t.ramp + ' ramp · ' + P.t.draw + ' draw · ' + P.t.removal + ' removal · ' + P.t.wipes + ' wipe' + (P.t.wipes === 1 ? '' : 's') + ' · avg MV ' + P.mv.toFixed(1) + '.' : '';
    const tags = new Set(tagList(S).map(t => t.toLowerCase()));
    document.querySelectorAll('#qThemes button').forEach(b => b.setAttribute('aria-pressed', String(tags.has(b.dataset.tag))));
    const bv = S.budget && S.budget.total != null && S.budget.total !== '' ? String(+S.budget.total) : '';
    document.querySelectorAll('#qBudget button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.b === bv)));
    document.querySelectorAll('#qBracket button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.br === +S.bracket)));
    if ($('budHint')) $('budHint').textContent = bv ? Engine.fmt(+bv, S.budget.cur || 'usd') + ' cap' : 'no limit';
  }
  function wireQuick() {
    const box = $('qThemes');
    box.innerHTML = Object.entries(Engine.TAGS).map(([k, t]) => '<button type="button" data-tag="' + esc(k) + '" aria-pressed="false">' + esc(t.label) + '</button>').join('');
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-tag]'); if (!b) return;
      const cur = tagList(App.S), k = b.dataset.tag, i = cur.findIndex(t => t.toLowerCase() === k);
      if (i >= 0) cur.splice(i, 1); else cur.push(k);
      App.S.tags = cur.join(', '); writeForm(App.S); persistSettings();
    });
    $('qPlan').addEventListener('click', e => {
      const b = e.target.closest('button[data-plan]'); if (!b) return; const P = PLANS[b.dataset.plan];
      App.S.plan = b.dataset.plan; App.S.targets = Object.assign({}, App.S.targets, P.t); App.S.mana = Object.assign({}, App.S.mana, { avgMV: P.mv });
      writeForm(App.S); persistSettings();
    });
    $('qBudget').addEventListener('click', e => { const b = e.target.closest('button[data-b]'); if (!b) return; App.S.budget.total = b.dataset.b === '' ? '' : +b.dataset.b; writeForm(App.S); persistSettings(); });
    $('qBracket').addEventListener('click', e => { const b = e.target.closest('button[data-br]'); if (!b) return; App.S.bracket = +b.dataset.br; App.S.bl = Engine.bracketDefaults(App.S.bracket); writeForm(App.S); persistSettings(); });
    $('qGen').addEventListener('click', () => $('genBtn').click());
  }
  function onFormChange(ev) {
    const el = ev.target; if (!el.dataset || !el.dataset.k) return;
    setPath(App.S, el.dataset.k, readEl(el));
    if (el.id === 'bracket') { App.S.bl = Engine.bracketDefaults(App.S.bracket); writeForm(App.S); }
    if (el.id === 'variance') $('varOut').textContent = (+App.S.variance).toFixed(2);
    if (el.id === 'bTotal' || el.id === 'bCur') syncQuick(App.S);
    persistSettings();
  }
  let persistT = 0;
  function persistSettings() { clearTimeout(persistT); persistT = setTimeout(() => { LS.set('edhgen.settings', JSON.stringify(App.S)); updateShareToken(); }, 300); }

  /* ---------- share token (#anchor-safe base64url of deflated JSON) ---------- */
  const b64u = bytes => { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  function slimSettings(S) { const d = uiDefaults(), out = {}; for (const k of Object.keys(S)) if (Engine.stable(S[k]) !== Engine.stable(d[k])) out[k] = S[k]; return out; }
  async function encodeSettings(S) {
    const json = new TextEncoder().encode(JSON.stringify(slimSettings(S)));
    if (typeof CompressionStream !== 'undefined') { try { const cs = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw')); return 'z' + b64u(new Uint8Array(await new Response(cs).arrayBuffer())); } catch (e) { } }
    return 'j' + b64u(json);
  }
  async function decodeSettings(tok) {
    tok = String(tok || '').trim().replace(/^#/, '');
    const kind = tok[0], body = unb64u(tok.slice(1));
    let bytes = body;
    if (kind === 'z') { const ds = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw')); bytes = new Uint8Array(await new Response(ds).arrayBuffer()); }
    else if (kind !== 'j') throw new Error('Unrecognized token');
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function updateShareToken() { try { $('shareTok').value = await encodeSettings(App.S); } catch (e) { } }
  function applySettings(obj) { App.S = deepAssign(uiDefaults(), obj || {}); writeForm(App.S); persistSettings(); }
  function deepAssign(a, b) { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepAssign(a[k], b[k]); else a[k] = b[k]; } return a; }

  /* ---------- autocomplete ---------- */
  function commanderIndex() {
    if (App.cmdIndex) return App.cmdIndex;
    if (!App.bulk) return [];
    App.cmdIndex = App.bulk.all.filter(c => Engine.commanderEligibility(c).ok).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
    return App.cmdIndex;
  }
  function setupAC(inputId, listId) {
    const inp = $(inputId), ul = $(listId); let items = [], sel = -1, t = 0, reqId = 0;
    const close = () => { ul.classList.add('hidden'); ul.innerHTML = ''; items = []; sel = -1; inp.setAttribute('aria-expanded', 'false'); };
    const show = list => {
      items = list.slice(0, 12); sel = -1;
      if (!items.length) return close();
      ul.innerHTML = items.map((x, i) => '<li role="option" id="' + listId + i + '" data-i="' + i + '"><span>' + esc(x.n) + '</span>' + (x.ci != null ? '<span>' + pipsHTML(x.ci) + '</span>' : '') + '</li>').join('');
      ul.classList.remove('hidden'); inp.setAttribute('aria-expanded', 'true');
    };
    const pick = i => { if (!items[i]) return; inp.value = items[i].n; setPath(App.S, inp.dataset.k, inp.value); persistSettings(); close(); checkCommanders(); };
    inp.addEventListener('input', () => {
      clearTimeout(t); const q = inp.value.trim(); const my = ++reqId;
      if (q.length < 2) return close();
      t = setTimeout(async () => {
        if (App.bulk) {
          const k = Engine.nameKey(q);
          const idx = commanderIndex();
          const pre = idx.filter(c => Engine.nameKey(c.n).startsWith(k)), sub = idx.filter(c => !Engine.nameKey(c.n).startsWith(k) && Engine.nameKey(c.n).includes(k));
          show(pre.concat(sub).map(c => ({ n: c.n, ci: c.ci })));
        }
      }, 60);
    });
    inp.addEventListener('keydown', e => {
      if (ul.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; [...ul.children].forEach((li, i) => li.setAttribute('aria-selected', i === sel)); inp.setAttribute('aria-activedescendant', listId + sel); }
      else if (e.key === 'Enter') { if (sel >= 0) { e.preventDefault(); pick(sel); } }
      else if (e.key === 'Escape') close();
    });
    ul.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
    inp.addEventListener('blur', () => setTimeout(close, 150));
    inp.addEventListener('change', () => { clearTimeout(t); reqId++; close(); checkCommanders(); });
  }
  async function checkCommanders() {
    const note = $('cmdNote'); const names = App.S.commanders.map(s => (s || '').trim()).filter(Boolean);
    if (!names.length) { note.textContent = ''; return; }
    let cards = [];
    if (!App.bulk) return;
    cards = names.map(n => Engine.lookup(App.bulk, n));
    const parts = [];
    cards.forEach((c, i) => { if (!c) parts.push('<span style="color:var(--bad)">Unknown: ' + esc(names[i]) + '</span>'); else { const el = Engine.commanderEligibility(c); parts.push(esc(c.n) + ' ' + pipsHTML(c.ci) + (el.ok ? '' : ' <span style="color:var(--bad)">' + esc(el.msg) + '</span>')); } });
    if (cards.length === 2 && cards[0] && cards[1]) { const pc = Engine.pairCheck(cards[0], cards[1]); parts.push(pc.ok ? 'Pair: ' + esc(pc.kind) : '<span style="color:var(--bad)">' + esc(pc.msg) + '</span>'); }
    const ci = 'WUBRG'.split('').filter(x => cards.some(c => c && c.ci.includes(x))).join('');
    if (cards.every(Boolean)) parts.push('Color identity: ' + pipsHTML(ci) + (ci ? '' : ' colorless'));
    note.innerHTML = parts.join('<br>');
  }

  /* ---------- rendering helpers ---------- */
  function pipsHTML(ci) { if (!ci) return '<span class="ms C">C</span>'; return ci.split('').map(x => '<span class="ms ' + x + '">' + x + '</span>').join(''); }
  function manaHTML(mc) {
    if (!mc) return '';
    return '<span class="mcost">' + esc(mc).replace(/\{([^}]+)\}/g, (m, s) => { const cols = s.split('/').filter(x => 'WUBRG'.includes(x)); const cls = cols.length === 1 ? cols[0] : ''; return '<span class="ms ' + cls + '">' + s.replace('/', '') + '</span>'; }) + '</span>';
  }
  const fmtP = (v) => Engine.fmt(v, App.R ? App.R.settings.budget.cur : App.S.budget.cur);
  function setStatus(t) { $('status').textContent = t || ''; syncActions(); }
  function syncActions() { const has = App.R && App.R.stats, locks = has && (App.R.deck.some(e => e.locked && !e.inc && !e.imp) || (App.R.bans || []).length > 0); $('regenBtn').classList.toggle('hidden', !locks); const ops = has && App.chain ? App.chain.ops : []; $('undoBtn').classList.toggle('hidden', !ops.length); $('undoBtn').disabled = !!App.busy; if (ops.length) $('undoBtn').title = 'Undo ' + opLabel(ops[ops.length - 1]) + ' (U or Ctrl+Z)'; document.querySelector('.actions').classList.toggle('hidden', !locks && !ops.length && !$('status').textContent && App.tab !== 'tests'); }
  function setProg(f) { const p = $('genProg'); if (f == null) { p.classList.add('hidden'); return; } p.classList.remove('hidden'); p.firstElementChild.style.width = (f * 100).toFixed(0) + '%'; }
  function showMsgs(errors, warnings, extraHTML) {
    let h = '';
    if (errors && errors.length) h += '<div class="msg err" role="alert"><b>Cannot generate</b><ul>' + errors.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul></div>';
    if (warnings && warnings.length) h += '<div class="msg warn"><b>Notes</b><ul>' + warnings.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul></div>';
    if (extraHTML) h += extraHTML;
    $('msgs').innerHTML = h;
  }
  function shortfallHTML(R) {
    if (!R.shortfalls || !R.shortfalls.length) return '';
    return '<div class="msg warn"><b>Category targets not met</b><ul>' + R.shortfalls.map(s => {
      const rej = Object.entries(s.rejected).map(([k, v]) => k + ' ' + v).join(', ');
      const ex = Object.entries(s.excluded).map(([k, v]) => k + ' ' + v).join(', ');
      return '<li>' + esc(Engine.SLOT_LABEL[s.role]) + ': ' + s.have + '/' + s.target + ' (short by ' + (s.target - s.have) + '). ' + s.pool + ' tagged candidates in pool' + (rej ? '; rejected at fill: ' + esc(rej) : '') + (ex ? '; removed before scoring: ' + esc(ex) : '') + '.</li>';
    }).join('') + '</ul></div>';
  }
  function sourceLine(R) {
    const m = R.dbMeta || {};
    const t = m.fileModified ? 'file modified ' + new Date(m.fileModified).toLocaleString() + ', loaded ' + new Date(m.loadedAt).toLocaleString() : '';
    return 'Prices (' + R.settings.budget.cur.toUpperCase() + '), legality, Game Changer flags and EDHREC ranks: ' + esc(m.source || '') + (m.file ? ' "' + esc(m.file) + '"' : '') + (t ? ', ' + esc(t) : '') + '.';
  }

  /* ---------- collection: one list (Collection page, kept with the settings) and one choice of how to use it.
     off = mark only (owned cards get a green dot), prefer = new decks favour owned cards, only = new decks and every
     suggestion on Analysis and Improve come from the collection (basic lands always allowed). ---------- */
  let ownC = null;
  function ownedCards() {
    if (!App.bulk) return null;
    const l = App.S.owned.list || '';
    if (!ownC || ownC.l !== l || ownC.db !== App.bulk) {
      const set = new Set(), missNames = [];
      for (const it of Engine.parseList(l)) { const c = Engine.lookup(App.bulk, it.name); if (c) set.add(c.n); else missNames.push(it.name); }
      ownC = { l, db: App.bulk, set, miss: missNames.length, missNames, key: Engine.hashStr(l) };
    }
    return ownC;
  }
  const ownOnly = () => App.S.owned.mode === 'only';
  const ownSet = () => { const o = ownedCards(); return o && o.set.size ? o.set : null; }; // for the owned marks
  const ownOpt = () => { const o = ownOnly() && ownedCards(); return o ? o.set : null; }; // Analysis.run opts.owned
  const ownKey = () => ownOnly() ? 'own:' + (ownedCards() || {}).key : 'all';
  const OWN_MODES = [
    ['off', 'Mark the cards I own', 'A green dot after every card you own. Builds and suggestions use all cards.'],
    ['prefer', 'Prefer cards I own', 'New decks favour your cards. Suggestions use all cards, with yours marked.'],
    ['only', 'Only cards I own', 'New decks and every suggestion on Analysis and Improve come from your cards. Basic lands are always allowed.']
  ];
  function setOwnMode(m) {
    if ((App.S.owned.mode || 'off') === m) return;
    if (m !== 'only') LS.set('edhgen.ownPrev', m);
    App.S.owned.mode = m; persistSettings(); ownChanged();
  }
  // owned and missing cards of the current deck (commanders included, basic lands left out)
  function deckOwned() {
    const R = App.R, set = ownSet(); if (!R || !R.stats || !set) return null;
    const cur = R.settings.budget.cur, all = R.commanders.map(c => ({ c, qty: 1 })).concat(R.deck).filter(e => !Engine.isBasic(e.c));
    const miss = all.filter(e => !set.has(e.c.n)), n = all.reduce((a, e) => a + e.qty, 0), m = miss.reduce((a, e) => a + e.qty, 0);
    return { n, have: n - m, miss, cost: miss.reduce((a, e) => a + (e.c.p[cur] || 0) * e.qty, 0), cur };
  }
  function ownSumHTML() {
    const D = deckOwned(); if (!D) return '';
    return '<span class="note"><span class="ownmk"></span> ' + D.have + ' of ' + D.n + ' nonbasic cards in your collection' + (D.miss.length ? '; the other ' + (D.n - D.have) + ' cost ' + Engine.fmt(D.cost, D.cur) : '') + '</span>';
  }
  // Improve header: where suggestions come from
  function ownBarHTML() {
    const o = ownedCards(), on = ownOnly(), n = o ? o.set.size : 0;
    const seg = '<div class="seg" role="group" aria-label="Suggest cards from"><button type="button" data-own="all" aria-pressed="' + !on + '">All cards</button><button type="button" data-own="only" aria-pressed="' + on + '">My collection</button></div>';
    const note = (n ? n.toLocaleString() + ' card' + (n === 1 ? '' : 's') + ' in your collection' : 'No collection yet') + ' · <button type="button" class="link" data-go="collection">' + (n ? 'edit' : 'add one') + '</button>';
    return '<div class="own-bar"><span class="note">Suggest cards from</span>' + seg + '<span class="note">' + note + '</span></div>';
  }
  // Start: the collection tile
  function renderOwnTile() {
    const el = $('ownTile'); if (!el) return;
    const o = ownedCards(), n = o ? o.set.size : 0, m = App.S.owned.mode || 'off';
    $('ownHint').textContent = n ? n.toLocaleString() + ' cards' : 'optional';
    el.innerHTML = '<p class="note" style="margin:0">' + (n ? 'Your cards are marked with a green dot.' : 'Add the cards you own to see which ones a deck needs, or to build only from them.') + '</p>' +
      (n ? '<div class="seg wide" role="radiogroup" aria-label="Use my collection">' + OWN_MODES.map(([k, l]) => '<button type="button" data-ownmode="' + k + '" aria-pressed="' + (k === m) + '">' + ({ off: 'Mark', prefer: 'Prefer', only: 'Only mine' })[k] + '</button>').join('') + '</div>' : '') +
      '<div class="row"><button type="button" class="small" data-go="collection">' + (n ? 'Edit collection' : 'Add my collection') + ' ›</button></div>';
  }
  /* ---------- Collection page ---------- */
  function renderCollection() {
    const o = ownedCards(), n = o ? o.set.size : 0, m = App.S.owned.mode || 'off', R = App.R && App.R.stats ? App.R : null;
    const list = '<div class="tile"><div class="tile-h"><h3>Your cards</h3><span class="hint">' + (!o ? 'card data loading…' : n ? n.toLocaleString() + ' recognised' + (o.miss ? ' · ' + o.miss + ' not found' : '') : 'empty') + '</span></div>' +
      '<label class="f">One card per line ("1 Card Name" or just the name), or a CSV export with a Name column (Moxfield, Archidekt, Deckbox, ManaBox)<textarea id="collList" rows="12" spellcheck="false" placeholder="1 Sol Ring&#10;1 Swords to Plowshares&#10;1 Cultivate&#10;...">' + esc(App.ownDraft != null ? App.ownDraft : App.S.owned.list || '') + '</textarea></label>' +
      '<div class="row"><button type="button" class="primary" data-own="save">Save collection</button><label class="small own-file">Load a file <input type="file" id="ownFile" accept=".txt,.csv,text/plain,text/csv"></label>' + (App.S.owned.list ? '<button type="button" class="small" data-own="clear">Clear</button>' : '') + '<span class="note" id="collNote">' + esc(App.collNote || '') + '</span></div>' +
      (o && o.miss ? '<details class="tdet"><summary class="note">Not found in the card data (' + o.miss + ')</summary><p class="note">' + esc(o.missNames.slice(0, 60).join('; ')) + (o.miss > 60 ? ' …' : '') + '</p></details>' : '') +
      '<p class="note" style="margin:0">Kept in this browser with your settings. Nothing is uploaded.</p></div>';
    const use = '<div class="tile"><div class="tile-h"><h3>Use it to</h3></div><div class="own-modes" role="radiogroup" aria-label="Use my collection">' + OWN_MODES.map(([k, l, d]) => '<button type="button" data-ownmode="' + k + '" aria-pressed="' + (k === m) + '">' + l + '<span>' + d + '</span></button>').join('') + '</div></div>';
    const D = deckOwned();
    const deck = D ? '<div class="tile"><div class="tile-h"><h3>Current deck</h3><span class="hint">' + R.commanders.map(c => esc(c.n)).join(' + ') + '</span></div><div class="own-sum"><span class="kv"><span>Owned</span><b>' + D.have + ' / ' + D.n + '</b></span><span class="kv"><span>To get</span><b>' + (D.n - D.have) + ' · ' + Engine.fmt(D.cost, D.cur) + '</b></span></div>' +
      '<div class="row">' + (D.miss.length ? '<button type="button" class="small" data-own="buy">Copy the cards to get</button>' : '') + '<button type="button" class="small" data-go="deck">See the deck ›</button><span class="note" id="buyNote"></span></div></div>' : '';
    const next = R ? '<div class="next-tile"><p><b>Next:</b> check the deck on Analysis, then improve it' + (n && m === 'only' ? ' with your cards' : '') + '.</p><button type="button" class="primary" data-go="analysis">Analysis ›</button></div>'
      : '<div class="next-tile"><p><b>Next:</b> build a deck or import yours.</p><button type="button" class="primary" data-go="setup">Start ›</button></div>';
    $('view').innerHTML = '<div class="coll-grid">' + list + '<div style="display:flex;flex-direction:column;gap:14px;min-width:0">' + use + deck + '</div></div>' + next;
  }
  // the suggestion source or the collection changed: measured results no longer apply
  function ownChanged() {
    App.DEEP = null; App.PC = null; App.UP = null; App.PX = null;
    anStale(); renderOwnTile(); renderView();
    if (App.AN && App.AN.stale) runAnalysis(); // Suggested swaps and By card start their own
  }
  // the analysed list or the suggestion source changed: on Analysis the page stays up, marked stale, until the new
  // analysis replaces it (so the page doesn't jump); elsewhere the analysis is dropped
  function anStale() { if (App.tab === 'analysis' && App.AN && App.AN.sim) App.AN.stale = true; else App.AN = null; }

  /* ---------- analysis tab ---------- */
  function analysisInput(forcePaste) {
    if (forcePaste || App.anSource === 'paste') {
      if (!App.bulk) return { error: 'Load the Scryfall bulk file first.' };
      const P = Analysis.parseDecklist(App.anText || ''), K = Analysis.pickCommanders(P, App.bulk);
      const unknown = K.missing.slice(), cmds = K.cmds.slice(), deck = [];
      if (!cmds.length) for (const n of App.S.commanders.map(s => (s || '').trim()).filter(Boolean)) { const c = Engine.lookup(App.bulk, n); if (c) cmds.push(c); else unknown.push(n); }
      for (const it of K.main) { const c = Engine.lookup(App.bulk, it.name); if (!c) { unknown.push(it.name); continue; } if (cmds.includes(c)) continue; const ex = deck.find(e => e.c === c); if (ex) ex.qty += it.qty; else deck.push({ c, qty: it.qty }); }
      if (!cmds.length) return { error: 'No commander found. Put it under a "Commander" header, tag it [Commander], or fill the Commander field in settings.', unknown };
      if (!deck.length) return { error: 'Decklist is empty.', unknown };
      return { deck, cmds, unknown, label: 'Pasted list' };
    }
    if (!App.R || !App.R.stats) return { error: 'Build or import a deck on Start first.' };
    // imported cards are locked so rebuilds keep them, but analysis may still suggest cutting them
    const deck = App.R.deck.map(e => e.imp ? Object.assign({}, e, { locked: false }) : e);
    return { deck, asIs: !!App.R.asIs, cmds: App.R.commanders, unknown: [], label: App.chain && App.chain.env && App.chain.env.imported ? 'Imported deck' : 'Generated deck', combos: App.R.combos };
  }
  const anGames = () => { const g = +App.anGames || 100000; return [1500, 10000, 25000, 50000, 100000].includes(g) ? g : 100000; };
  async function runAnalysis() {
    if (App.anSource === 'compare') return runCompare();
    const inp = analysisInput();
    if (inp.error) { App.AN = { error: inp.error, unknown: inp.unknown || [] }; renderAnView(); return; }
    const key = App.anSource + '|' + inp.cmds.map(c => c.n).join('+') + '|' + inp.deck.map(e => e.qty + e.c.n).join(',') + '|' + JSON.stringify(App.S.targets) + App.S.bracket + '|' + anGames() + '|' + JSON.stringify(App.S.budget) + '|' + [...(App.denied || [])].join(',') + '|' + ownKey();
    if (App.AN && App.AN.key === key && !App.AN.stale) { renderAnView(); return; }
    setStatus('Analyzing (' + anGames().toLocaleString() + ' simulated games)…'); await new Promise(r => setTimeout(r, 30));
    let combos = inp.combos || null, almost = null;
    const cp = comboProvider();
    if (cp) {
      const names = inp.cmds.map(c => c.n).concat(inp.deck.map(e => e.c.n));
      try {
        if (!combos || App.anSource === 'paste') combos = await cp.find(names, inp.cmds.map(c => c.n));
        const CI = 'WUBRG'.split('').filter(x => inp.cmds.some(c => c.ci.includes(x))).join('');
        const own = ownOpt(), poolNames = App.bulk.all.filter(c => c.leg === 'legal' && [...c.ci].every(x => CI.includes(x)) && (!own || own.has(c.n) || Engine.isBasic(c))).map(c => c.n);
        almost = (await cp.almost(names, poolNames)).filter(x => x.missing.length === 1).slice(0, 8).map(x => ({ cards: x.v.c, missing: x.missing, produces: x.v.p }));
      } catch (e) { }
    }
    const t0 = performance.now();
    App.denied = App.denied || new Set();
    const X = Analysis.run(App.bulk, inp.deck, inp.cmds, { settings: App.S, combos, almost, games: anGames(), deny: [...App.denied], owned: ownOpt() });
    X.inp = inp; X.combosIn = combos;
    X.key = key; X.label = inp.label; X.unknown = inp.unknown; X.cmds = inp.cmds; X.comboLoaded = !!cp;
    App.AN = X;
    setStatus('Analysis done in ' + ((performance.now() - t0) / 1000).toFixed(2) + ' s (' + X.sim.games.toLocaleString() + ' simulated games).');
    X.impact = []; X.impactDone = !X.plans.length;
    X.held = !!inp.asIs && !App.recsShown && X.plans.length > 0; // imported deck: changes are scored only once Improve is opened
    renderAnView();
    if (!X.plans.length || X.held) { if (!X.held && App.DEEP) { deepMerge(X); renderSwaps(); } return; }
    return scoreSwaps(X);
  }
  // swap impact: one plan per tick so the page stays responsive
  async function scoreSwaps(X) {
    if (X.scoring) return; X.scoring = true;
    const inp = X.inp, combos = X.combosIn, cp = comboProvider();
    const names = inp.cmds.map(c => c.n).concat(inp.deck.map(e => e.c.n));
    const combosFor = (cut, add) => {
      let out = (combos || []).filter(v => !v.c.some(n => Engine.nameKey(n) === Engine.nameKey(cut.n)));
      if (cp && cp.completes) { const rest = names.filter(n => n !== cut.n); const seen = new Set(out.map(v => v.id)); for (const v of cp.completes(add.n, rest)) if (!seen.has(v.id)) { out.push(v); seen.add(v.id); } }
      return combos == null && !cp ? null : out;
    };
    const prep = Analysis.impactPrep(App.bulk, inp.deck, inp.cmds, { settings: App.S, combos, combosFor, impactGames: 5000 });
    for (const p of X.plans) {
      if (App.AN !== X) return; // a newer analysis replaced this one
      await new Promise(r => setTimeout(r, 0));
      X.impact.push(Analysis.impactOne(prep, p));
      setStatus('Evaluating changes ' + X.impact.length + '/' + X.plans.length + '…');
      if (App.tab === 'analysis' || App.tab === 'changes') renderSwaps();
    }
    X.impactDone = true; setStatus('Analysis done; ' + X.plans.length + ' changes evaluated.'); deepMerge(X);
    if (App.tab === 'analysis' || App.tab === 'changes') renderSwaps();
  }
  // apply one swap to the analysed list: the generated deck (validated, locked) or the pasted text
  async function applyChange(cut, add, quiet) {
    if (App.anSource !== 'paste' && App.R) {
      const entry = App.R.deck.find(e => e.c === cut); if (!entry) { setStatus(cut.n + ' is no longer in the deck.'); return; }
      await App.R.swapOne(entry, add); histOp({ op: 'swap', cut: cut.n, add: add.n }); App.QS = null; if (!quiet) histPush('edit', cut.n + ' → ' + add.n); setStatus('Swapped ' + cut.n + ' → ' + add.n + ' (locked).'); return;
    }
    const inp = App.AN && App.AN.inp; if (!inp) return;
    const deck = inp.deck = Analysis.applySwap(inp.deck, cut, add); // kept on inp so several accepts in a row build on each other
    App.anText = 'Commander\n' + inp.cmds.map(c => '1 ' + c.n).join('\n') + '\n\nDeck\n' + deck.map(e => (e.qty || 1) + ' ' + e.c.n).join('\n');
    setStatus('Swapped ' + cut.n + ' → ' + add.n + ' in the pasted list.');
  }
  // Accept all / Accept group: applies each change in order; a change whose cut is already gone or whose add is
  // already in the list (from an earlier change in the batch) is skipped. One history entry for the batch.
  async function acceptMany(list) {
    const cur = () => App.anSource !== 'paste' && App.R ? App.R.deck : (App.AN && App.AN.inp ? App.AN.inp.deck : []);
    let done = 0, skipped = 0;
    for (const p of list) {
      const d = cur(), has = c => d.some(e => e.c === c && (e.qty || 1) > 0);
      if (!has(p.cut) || (has(p.add) && !Engine.isBasic(p.add))) { skipped++; continue; }
      await applyChange(p.cut, p.add, true);
      (App.accepted = App.accepted || []).push({ cut: p.cut, add: p.add, src: App.anSource }); done++;
    }
    if (done && App.anSource !== 'paste' && App.R) histPush('edit', 'Accepted ' + done + ' change' + (done === 1 ? '' : 's'));
    App.acceptNote = 'Accepted ' + done + ' change' + (done === 1 ? '' : 's') + (skipped ? '; skipped ' + skipped + ' whose card was already cut or added by an earlier change' : '') + '. The list below is re-scored against the new deck.';
  }
  /* ---------- deep search (Improve page): Deep.search in Web Workers, results join the swap list ---------- */
  const deepWorkers = () => Math.max(1, Math.min(8, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 1));
  function deepBarHTML(X) {
    const D = App.DEEP, busy = D && D.busy;
    const res = D && !busy && D.res ? D.res.stats : null;
    return '<div class="an-card wide deep" id="deepBox"><div class="row" style="gap:8px;align-items:center">' +
      (busy ? '<button type="button" class="small" data-deep="cancel">Cancel</button>' : '<button type="button" class="small primary" data-deep="run">Deep search (~30 s)</button><button type="button" class="small" data-deep="wide">Thorough (~1 min)</button>') +
      '<progress id="deepBar" max="1" value="' + (busy ? D.frac || 0 : res ? 1 : 0) + '"' + (busy || res ? '' : ' hidden') + '></progress><span class="note" id="deepNote">' + esc(D && D.note || 'Measures several hundred candidate swaps and builds a package of swaps that work together. Thorough screens twice as many cards and refines the package more widely.') + '</span></div>' +
      (res ? '<p class="note">' + (D.wide ? 'Thorough: ' : '') + res.evals.toLocaleString() + ' measured lists: ' + res.cands + ' candidate swaps screened at ' + Deep.G1.toLocaleString() + ' games, ' + res.confirmed + ' confirmed at ' + Deep.G2.toLocaleString() + ', ' + res.cuts + ' cut candidates, ' + (res.refined ? res.refined + ' package change' + (res.refined === 1 ? '' : 's') + ' from refinement, ' : '') + res.workers + ' worker' + (res.workers === 1 ? '' : 's') + ', ' + D.secs.toFixed(1) + ' s.' + (D.X !== X ? ' Measured before your last accepted change' + (D.repaired ? '; ' + D.repaired + ' swap' + (D.repaired === 1 ? '' : 's') + ' re-paired with the next cut because the measured cut is gone' : '') + '. Run again to re-measure.' : '') + '</p>' : '') + '</div>';
  }
  const deepSay = (t, frac) => { const D = App.DEEP; if (D) { D.note = t; if (frac != null) D.frac = frac; } const n = $('deepNote'), b = $('deepBar'); if (n) n.textContent = t; if (b && frac != null) { b.hidden = false; b.value = frac; } };
  async function deepRun(wide) {
    const X = App.AN; if (!X || !X.planner || (App.DEEP && App.DEEP.busy)) return;
    const inp = X.inp, cp = comboProvider(), t0 = performance.now();
    const keep = new Set(inp.cmds.map(c => c.n).concat(App.anSource !== 'paste' && App.R ? App.R.deck.filter(e => e.inc).map(e => e.c.n) : []));
    const src = ['src-engine', 'src-mech', 'src-plan', 'src-analysis', 'src-deep'].map(id => { const el = document.getElementById(id); return el ? el.textContent : null; });
    const useW = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && src.every(Boolean);
    let ex = null;
    const D = App.DEEP = { busy: true, wide: !!wide, frac: 0, note: 'Preparing candidates…', X, cancel: () => { if (ex) ex.cancel(); } };
    renderView();
    try {
      // swaps accepted on this list: their cut cards are not added back and their added cards are not cut (no A → B → A)
      const history = (App.accepted || []).filter(a => a.src === App.anSource).map(a => ({ cut: a.cut.n, add: a.add.n }));
      const res = await Deep.search(X, { deck: inp.deck, cmds: inp.cmds, combos: X.combos || null, prov: cp, keep, settings: App.S, history },
        init => (ex = useW ? Deep.workerExec(init, src.join('\n'), deepWorkers()) : Deep.localExec(init)),
        (d, t) => { const el = (performance.now() - t0) / 1000, eta = d > 20 ? el / d * (t - d) : null; deepSay('Measured ' + d + '/' + t + (eta != null ? ' · about ' + Math.max(1, Math.round(eta)) + ' s left' : '') + '…', d / t); return useW ? null : new Promise(r => setTimeout(r, 0)); }, wide ? Deep.WIDE : null);
      D.res = res; D.secs = (performance.now() - t0) / 1000; D.rows = Deep.rows(X, res); D.note = res.pkg.length ? 'Package of ' + res.pkg.length + ' swap' + (res.pkg.length === 1 ? '' : 's') + ', ' + res.singles.length + ' best single swaps.' : res.singles.length ? res.singles.length + ' single swaps gain ' + Deep.MIN_GAIN + ' or more; none combine into a package.' : 'Near optimal: ' + (res.small && res.small.n ? 'the best of ' + res.stats.cands + ' measured swaps add ' + (Math.round(res.small.total * 10) / 10) + ' together, below ' + Deep.PKG_MIN + ' (0.3 power level)' : 'none of the ' + res.stats.cands + ' measured swaps gains ' + Deep.MIN_GAIN + ' (0.1 power level) or more') + '. Further changes have diminishing returns.';
      if (App.AN && App.AN.impactDone) deepMerge(App.AN);
    } catch (e) {
      D.note = /cancel/.test(String(e && e.message)) ? 'Cancelled.' : 'Deep search failed: ' + (e && e.message || e); D.res = null;
    } finally { D.busy = false; if (App.tab === 'changes') renderView(); }
  }
  // put the deep rows that still apply (cut in the list, add not in it) into the analysis' swap list
  function deepMerge(X) {
    const D = App.DEEP; if (!X || !D || !D.rows || X.deepIn) return;
    const deck = X.inp ? X.inp.deck : [], has = c => deck.some(e => e.c === c || e.c.n === c.n);
    const den = App.denied || new Set();
    // a row whose measured cut was taken by an accepted swap gets the next cut of the search's cut order that is still in the list
    const order = (D.res.order || []).filter(has), taken = new Set();
    const live = []; D.repaired = 0;
    for (const p of D.rows) {
      if (has(p.add) || den.has(p.add.n)) continue;
      if (has(p.cut) && !(p.group === 'Package' && taken.has(p.cut))) { if (p.group === 'Package') taken.add(p.cut); live.push(p); continue; }
      const c = order.find(x => !taken.has(x)); if (!c) continue;
      live.push(Object.assign({}, p, { cut: c, reason: p.reason + ' · measured with ' + p.cut.n + ' as the cut' })); D.repaired++;
    }
    X.plans = live.concat(X.plans); X.impact = live.concat(X.impact); X.deepIn = true;
    const box = $('deepBox'); if (box && App.AN === X) box.outerHTML = deepBarHTML(X);
  }
  // gap and upgrade suggestions are heuristic picks; once measured, those below the deep search's minimum gain are hidden
  // (on 4 reference decks, accepting every suggestion and re-running left 13–14 suggestions a round with 0–1 above it)
  // a set of changes that can all be applied together, in list order: each card cut at most once and added at most once
  // (alternatives for the same cut, and a single swap repeating a package card, are left out)
  const compatible = list => { const cut = new Set(), add = new Set(); return list.filter(p => { if (cut.has(p.cut) || (add.has(p.add) && !Engine.isBasic(p.add))) return false; cut.add(p.cut); add.add(p.add); return true; }); };
  const worth = p => App.showWeak || !(p.group === 'Fix gaps' || p.group === 'Upgrades') || p.g == null || p.g >= Deep.MIN_GAIN;
  function renderSwaps() {
    const el = $('anSwaps'), X = App.AN; if (!el || !X) return;
    el.innerHTML = swapsHTML(X);
  }
  function swapsHTML(X) {
    const cur = X.cur || 'usd';
    const money = v => Engine.fmt(Math.abs(v), cur);
    const sign = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d == null ? 0 : d);
    const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
    const VL = { speed: 'Speed', consistency: 'Consistency', interaction: 'Interaction', manabase: 'Mana base', threats: 'Threats' };
    const AL = Object.fromEntries(X.axes.map(a => [a.key, a.label]));
    const GSUB = { Upgrades: ' (weakest power vectors)', Budget: ' (cheaper card, same role or theme)', Package: ' (deep search: swaps chosen one after another, each measured on the list as changed so far)', 'Deep search': ' (best single swaps of the wide search)' };
    // at most TOP_N per group unless Show is on; the deep search's single swaps are shown on By card's terms (one card at a time)
    // and stay behind Show here
    const TOP_N = 3, capped = g => { const l = X.impact.filter(p => p.group === g && worth(p)); return App.showWeak || g === 'Package' ? l : g === 'Deep search' ? [] : l.slice().sort((a, b) => (b.g || 0) - (a.g || 0)).slice(0, TOP_N); };
    const shownSet = new Set(['Package', 'Deep search', 'Fix gaps', 'Upgrades', 'Budget'].flatMap(capped)), shown = X.shownNow = X.impact.filter(p => shownSet.has(p)), weak = X.impact.length - shown.length;
    const groups = ['Package', 'Deep search', 'Fix gaps', 'Upgrades', 'Budget'], inOrder = groups.flatMap(g => shown.filter(p => p.group === g)), allSet = compatible(inOrder);
    const all = X.impactDone && allSet.length ? '<button type="button" class="small primary" data-sw="accept-all">Accept all (' + allSet.length + ')</button>' : '';
    const head = '<div class="an-top sw-head"><span class="note">' + (X.impactDone ? X.impact.length + ' evaluated' : 'evaluating ' + X.impact.length + '/' + X.plans.length + '…') + '</span>' + all + '</div>' + (App.acceptNote ? '<p class="note">' + esc(App.acceptNote) + '</p>' : '');
    const log = (App.accepted || []).filter(a => a.src === App.anSource);
    const logHTML = log.length ? '<div class="accepted"><span class="note">Accepted:</span> ' + log.map((a, j) => '<span class="chip">− ' + esc(a.cut.n) + ' + ' + esc(a.add.n) + ' <button type="button" class="link" data-sw="undo" data-i="' + (App.accepted.indexOf(a)) + '" aria-label="Undo">undo</button></span>').join(' ') + '</div>' : '';
    const denN = App.denied && App.denied.size ? '<span class="note"> · ' + App.denied.size + ' denied <button type="button" class="link" data-sw="clear-deny">reset</button></span>' : '';
    const own = ownOnly() && ownedCards();
    if (own && !own.set.size) return '<p class="note">Add your collection above to get suggestions from it, or switch to All cards.</p>';
    if (!X.plans.length) return head + logHTML + denN + '<p class="note">' + (own && !own.set.size ? 'Add your collection above to get suggestions from it.' : own ? 'No changes from your collection: none of its cards in your colours fills a gap, upgrades a weak area or replaces a costly card for less.' : 'No changes suggested: targets are met and no costly card has a cheaper same-role replacement in the loaded data.') + '</p>';
    // rows with the same cut sit together; after the first, a row is an alternative ("or + card") for that cut
    const byCut = list => { const order = [...new Set(list.map(p => p.cut))]; return order.flatMap(c => list.filter(p => p.cut === c)); };
    const rows = g => { const seenCut = new Set(); return byCut(shown.filter(p => p.group === g)).map(p => {
      const alt = seenCut.has(p.cut); seenCut.add(p.cut);
      const d = p.d, eff = [];
      for (const [k, v] of d.src || []) eff.push('<span class="' + cls(v) + '">' + k + ' land sources ' + sign(v) + '</span>');
      if (d.warn) eff.push('<span class="' + cls(-d.warn) + '">Colors flagged ' + sign(d.warn) + '</span>');
      if (d.castLow) eff.push('<span class="' + cls(-d.castLow) + '">Cards below ' + Math.round(Analysis.CAST_OK * 100) + '% castable ' + sign(d.castLow) + '</span>');
      if (d.pl) eff.push('<span class="' + cls(d.pl) + '">Power ' + sign(d.pl, 1) + '</span>');
      if (d.fund) eff.push('<span class="' + cls(d.fund) + '">Fundamentals ' + sign(d.fund) + '</span>');
      // the two largest vector or fundamentals changes; the full list is on the analysis
      const va = d.vectors.map(([k, v]) => [VL[k], v]).concat(d.axes.filter(([k]) => !['speed', 'consistency', 'interaction'].includes(k)).map(([k, v]) => [AL[k] || k, v]));
      for (const [l, v] of va.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2)) eff.push('<span class="' + cls(v) + '">' + esc(l) + ' ' + sign(v) + '</span>');
      if (Math.abs(d.keep) >= 0.005) eff.push('<span class="' + cls(d.keep) + '">Keepable 7 ' + sign(d.keep * 100, 1) + ' pts</span>');
      if (Math.abs(d.t4) >= 0.05) eff.push('<span class="' + cls(d.t4) + '">T4 mana ' + sign(d.t4, 2) + '</span>');
      if (d.typical) eff.push('<span class="' + cls(-d.typical) + '">Typical win T' + p.after.typical + '</span>');
      if (d.minB) eff.push('<span class="warn-t">Min. bracket → ' + p.after.minB + '</span>');
      const price = p.priceKnown ? '<span class="' + (p.dPrice > 0.005 ? 'pup' : p.dPrice < -0.005 ? 'pdown' : '') + '">' + (p.dPrice > 0.005 ? '▲ ' : p.dPrice < -0.005 ? '▼ ' : '') + money(p.dPrice) + '</span>' : '<span class="note">price n/a</span>';
      const i = X.impact.indexOf(p);
      const acts = '<div class="sw-acts"><button type="button" class="small primary" data-sw="accept" data-i="' + i + '">Accept</button><button type="button" class="small" data-sw="deny" data-i="' + i + '">Deny</button></div>';
      return '<tr' + (alt ? ' class="alt"' : '') + '><td><div class="sw">' + (alt ? '<span class="note">or, instead of the swap above:</span>' : '<span class="out">− ' + cardLink(p.cut) + '</span>') + '<span class="in">+ ' + cardLink(p.add) + '</span></div><div class="note">' + esc(p.reason) + (p.tag ? ' · ' + esc(p.tag) : '') + '</div></td><td class="n nw">' + price + '</td><td><div class="eff">' + (eff.length ? eff.join(' ') : '<span class="note">no measurable change</span>') + '</div>' + acts + '</td></tr>';
    }).join(''); };
    const weakHTML = weak || App.showWeak ? '<p class="note">' + (App.showWeak ? 'Showing every suggestion.' : weak + ' more suggestion' + (weak === 1 ? '' : 's') + ' hidden: gains below ' + Deep.MIN_GAIN + ' (0.1 power level), beyond the top ' + TOP_N + ' of a group, and the deep search\'s single swaps (see <button type="button" class="link" data-go="percard">By card</button> for options card by card).') + ' <button type="button" class="link" data-sw="weak">' + (App.showWeak ? 'Hide' : 'Show') + '</button></p>' : '';
    const nearHTML = X.impactDone && !shown.length ? '<p class="note"><b>Near optimal.</b> No measured change gains ' + Deep.MIN_GAIN + ' or more on this list; Deep search measures several hundred more.</p>' : '';
    return head + logHTML + denN + nearHTML + weakHTML + groups.filter(g => X.plans.some(p => p.group === g) && (!X.impactDone || shown.some(p => p.group === g))).map(g => '<h4 class="an-sub">' + g + (GSUB[g] || '') + (X.impactDone && shown.some(p => p.group === g) ? ' <button type="button" class="small" data-sw="accept-group" data-g="' + g + '">Accept ' + compatible(shown.filter(p => p.group === g)).length + '</button>' : '') + '</h4><div class="scroll"><table class="t compact swaps"><thead><tr><th>Change</th><th class="n">Price</th><th>Projected effect</th></tr></thead><tbody>' + (rows(g) || '<tr><td colspan="3" class="note">evaluating…</td></tr>') + '</tbody></table></div>').join('') +
      '<p class="note">Each change is applied alone and the whole analysis is re-run with 5,000 simulated games on the same shuffles as the current list, so differences come from the swap, not from random variation. Cuts are the lowest-value cards whose removal keeps every role at or above target (value = synergy links + 2×roles + Game Changer/fast/tutor bonus + EDHREC popularity). Adds come from ' + (own ? 'your collection (' + own.set.size.toLocaleString() + ' cards; basic lands always)' : 'the loaded card data') + ' within your color identity, bracket limits and per-card budget cap. Price is the difference in ' + cur.toUpperCase() + ' between the added and removed card.</p>';
  }
  // header-sized radar: no labels, the scores are in the tooltip
  function miniRadarSVG(axes, size) {
    const c = size / 2, R = c - 3, n = axes.length;
    const pt = (i, r) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return (c + Math.cos(a) * r).toFixed(1) + ',' + (c + Math.sin(a) * r).toFixed(1); };
    let g = '<title>' + esc(axes.map(a => a.label + ' ' + a.score).join(' · ')) + '</title>';
    for (const f of [0.5, 1]) g += '<polygon class="rg" points="' + axes.map((_, i) => pt(i, R * f)).join(' ') + '"/>';
    axes.forEach((_, i) => { g += '<line class="rg" x1="' + c + '" y1="' + c + '" x2="' + pt(i, R).split(',')[0] + '" y2="' + pt(i, R).split(',')[1] + '"/>'; });
    g += '<polygon class="rv" points="' + axes.map((a, i) => pt(i, R * Math.max(0.04, a.score / 100))).join(' ') + '"/>';
    return '<svg class="kradar" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" role="img" aria-label="Balance: ' + esc(axes.map(a => a.label + ' ' + a.score).join(', ')) + '">' + g + '</svg>';
  }
  function radarSVG(axes) {
    const W = 440, H = 290, cx = W / 2, cy = 145, R = 100, n = axes.length;
    const pt = (i, r) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; };
    let g = '';
    for (const f of [0.25, 0.5, 0.75, 1]) g += '<polygon class="rg" points="' + axes.map((_, i) => pt(i, R * f).join(',')).join(' ') + '"/>';
    axes.forEach((_, i) => { const [x, y] = pt(i, R); g += '<line class="rg" x1="' + cx + '" y1="' + cy + '" x2="' + x + '" y2="' + y + '"/>'; });
    g += '<polygon class="rv" points="' + axes.map((a, i) => pt(i, R * a.score / 100).join(',')).join(' ') + '"/>';
    axes.forEach((a, i) => { const [x, y] = pt(i, R * a.score / 100); g += '<circle class="rd" cx="' + x + '" cy="' + y + '" r="3"/>'; });
    axes.forEach((a, i) => { const [x, y] = pt(i, R + 18); const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end'; g += '<text class="lbl rl" x="' + x + '" y="' + (y + 3) + '" text-anchor="' + anchor + '">' + esc(a.label) + ' ' + a.score + '</text>'; });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px" role="img" aria-label="Deck profile radar">' + g + '</svg>';
  }
  function manaLineSVG(sim) {
    const W = 340, H = 150, pl = 26, pb = 22, pt = 10, T = 8, max = Math.ceil(Math.max(8, ...sim.manaByTurn.slice(1)));
    const sx = t => pl + (t - 1) * (W - pl - 10) / (T - 1), sy = v => H - pb - v / max * (H - pb - pt);
    let g = '';
    for (let v = 0; v <= max; v += 2) g += '<line class="gl" x1="' + pl + '" x2="' + (W - 10) + '" y1="' + sy(v) + '" y2="' + sy(v) + '"/><text x="' + (pl - 5) + '" y="' + (sy(v) + 3) + '" text-anchor="end">' + v + '</text>';
    g += '<polyline class="ref" points="' + [1, 2, 3, 4, 5, 6, 7, 8].map(t => sx(t) + ',' + sy(t)).join(' ') + '"/>';
    g += '<polyline class="ln" points="' + [1, 2, 3, 4, 5, 6, 7, 8].map(t => sx(t) + ',' + sy(sim.manaByTurn[t])).join(' ') + '"/>';
    for (let t = 1; t <= T; t++) g += '<circle class="rd" cx="' + sx(t) + '" cy="' + sy(sim.manaByTurn[t]) + '" r="2.5"/><text x="' + sx(t) + '" y="' + (H - 7) + '" text-anchor="middle">T' + t + '</text>';
    g += '<text class="lbl" x="' + (sx(8) - 2) + '" y="' + (sy(sim.manaByTurn[8]) - 7) + '" text-anchor="end">' + sim.manaByTurn[8].toFixed(1) + '</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px" role="img" aria-label="Average mana available by turn">' + g + '</svg>';
  }
  const pct = x => Math.round(x * 100) + '%';
  const scoreCls = s => s >= 80 ? 'pass' : s >= 55 ? 'na' : 'fail';
  function cardList(arr, max) { if (!arr || !arr.length) return '<span class="note">none</span>'; const m = max || 12; return esc(arr.slice(0, m).join(', ')) + (arr.length > m ? ' <span class="note">+' + (arr.length - m) + ' more</span>' : ''); }
  /* ---------- compare: generated deck vs a pasted list, same metrics and seed ---------- */
  async function runCompare() {
    if (!App.R || !App.R.stats) { App.AN = { error: 'Generate a deck first; it is the left column of the comparison.' }; renderAnView(); return; }
    const pin = analysisInput(true);
    if (pin.error) { App.AN = { error: pin.error, unknown: pin.unknown || [] }; renderAnView(); return; }
    const games = Math.min(anGames(), 25000);
    setStatus('Comparing (' + games.toLocaleString() + ' simulated games per deck)…'); await new Promise(r => setTimeout(r, 30));
    const cur = App.S.budget.cur || 'usd';
    const side = (deck, cmds, label) => {
      const X = Analysis.run(App.bulk, deck, cmds, { settings: App.S, games, seed: Engine.hashStr('compare') });
      const role = {}; let price = 0, unpriced = 0, creatures = 0, nonbasicLands = 0;
      for (const c of cmds) { const p = c.p[cur]; if (p == null) unpriced++; else price += p; }
      for (const e of deck) {
        const a = Engine.analyze(e.c), q = e.qty || 1, p = e.c.p[cur];
        if (p == null) { if (a.land !== 'basic') unpriced += q; } else if (!(a.land === 'basic' && !App.S.budget.inclBasics)) price += p * q;
        for (const r of Object.keys(a.roles)) role[r] = (role[r] || 0) + q;
        if (a.creature) creatures += q;
        if (a.isLand && a.land !== 'basic') nonbasicLands += q;
      }
      return { label, X, role, price, unpriced, creatures, nonbasicLands, names: new Set(deck.map(e => e.c.n)) };
    };
    const A = side(App.R.deck, App.R.commanders, 'Generated'), B = side(pin.deck, pin.cmds, 'Pasted');
    const shared = [...A.names].filter(n => B.names.has(n));
    App.AN = { compare: true, A, B, shared, onlyA: [...A.names].filter(n => !B.names.has(n)), onlyB: [...B.names].filter(n => !A.names.has(n)), unknown: pin.unknown, games, cur, key: 'compare' };
    setStatus('Comparison done (' + games.toLocaleString() + ' games per deck, same seed).');
    renderAnView();
  }
  function compareHTML(C) {
    const f1 = x => (Math.round(x * 10) / 10).toFixed(1), money = x => Engine.fmt(x, C.cur);
    const vec = (S, k) => (S.X.power.vectors.find(v => v.key === k) || {}).score;
    const ax = (S, k) => (S.X.axes.find(a => a.key === k) || {}).score;
    const rows = [
      ['Price', S => money(S.price) + (S.unpriced ? ' (' + S.unpriced + ' unpriced)' : ''), S => S.price, 0],
      ['Power level', S => f1(S.X.power.pl), S => S.X.power.pl, 1],
      ['Card quality (0–100)', S => S.X.power.qScore, S => S.X.power.qScore, 1],
      ['Fundamentals', S => S.X.overall, S => S.X.overall, 1],
      ['Min. bracket', S => S.X.power.minBracket, S => S.X.power.minBracket, 0],
      ['Typical win turn', S => 'T' + S.X.power.win.typical, S => -S.X.power.win.typical, 1],
      ['Game Changers', S => S.X.bracket.counts.gc, S => S.X.bracket.counts.gc, 0],
      ['Avg MV (nonland)', S => S.X.avgMV.toFixed(2), S => S.X.avgMV, 0],
      ['Lands (nonbasic)', S => S.X.nLands + ' (' + S.nonbasicLands + ')', S => S.X.nLands, 0],
      ['Creatures', S => S.creatures, S => S.creatures, 0]
    ].concat(['ramp', 'draw', 'removal', 'wipes', 'protection', 'recursion', 'wincon'].map(r => [Engine.SLOT_LABEL[r], S => S.role[r] || 0, S => S.role[r] || 0, 0]))
      .concat(C.A.X.power.vectors.map(v => ['Vector: ' + v.label, S => vec(S, v.key), S => vec(S, v.key), 1]))
      .concat(C.A.X.axes.map(a => ['Axis: ' + a.label, S => ax(S, a.key), S => ax(S, a.key), 1]))
      .concat([['Keep-7 rate', S => (S.X.sim.keep7 * 100).toFixed(0) + '%', S => S.X.sim.keep7, 1], ['Mana on T4 (avg)', S => (+S.X.sim.manaByTurn[4]).toFixed(2), S => +S.X.sim.manaByTurn[4], 1]]);
    const d = (a, b) => { const x = a - b; return Math.abs(x) < 1e-9 ? '' : (x > 0 ? '+' : '') + (Math.abs(x) < 10 && x % 1 ? +x.toFixed(2) : Math.round(x)); };
    const tbl = '<div class="scroll"><table class="t compact"><thead><tr><th>Metric</th><th class="n">Generated</th><th class="n">Pasted</th><th class="n">Gen − Pasted</th></tr></thead><tbody>' +
      rows.map(([lab, show, num]) => '<tr><td>' + esc(lab) + '</td><td class="n">' + show(C.A) + '</td><td class="n">' + show(C.B) + '</td><td class="n note">' + d(num(C.A), num(C.B)) + '</td></tr>').join('') + '</tbody></table></div>';
    const list = (t, arr) => '<details><summary class="note" style="cursor:pointer">' + esc(t) + ' (' + arr.length + ')</summary><p class="note">' + esc(arr.sort().join(', ')) + '</p></details>';
    return '<div class="an-card wide" style="margin-top:10px"><div class="an-top"><h3>Generated vs pasted</h3><span class="chip">' + C.shared.length + ' shared cards</span></div>' + tbl +
      '<p class="note">Both decks scored by the same rules with ' + C.games.toLocaleString() + ' simulated games and the same seed. Win turn: lower is faster, so its difference column is sign-flipped. Price uses ' + esc(C.cur.toUpperCase()) + ' from your bulk file' + (App.S.budget.inclBasics ? '' : ', basics excluded') + '.</p>' +
      list('Only in generated', C.onlyA) + list('Only in pasted', C.onlyB) + list('Shared', C.shared.slice()) +
      (C.unknown && C.unknown.length ? '<div class="msg warn">Not found in bulk data: ' + esc(C.unknown.join(', ')) + '</div>' : '') + '</div>';
  }
  /* ---------- per-turn expectations: goldfish simulation (mean or share of games) + exact draw odds ---------- */
  function turnsHTML(X) {
    const rows = (X.sim.perTurn || []).filter(r => r.t <= 10);
    if (!rows.length) return '';
    const f1 = v => v.toFixed(1), pc = v => Math.round(v * 100) + '%';
    const RL = [['ramp', 'Ramp'], ['draw', 'Draw'], ['removal', 'Removal'], ['wipes', 'Wipe'], ['wincon', 'Win con']];
    const head = '<tr><th class="n">Turn</th><th class="n">Cards seen</th><th class="n">Lands in play</th><th class="n">Mana available</th><th class="n">Mana spent</th><th class="n">Spells cast</th><th class="n">Hand size</th><th class="n">Land drop made</th><th class="n">Commander out</th>' + RL.map(r => '<th class="n">≥1 ' + r[1] + ' seen</th>').join('') + '</tr>';
    const body = rows.map(r => '<tr><td class="n">T' + r.t + '</td><td class="n">' + r.seen + '</td><td class="n">' + f1(r.lands) + '</td><td class="n">' + f1(r.mana) + '</td><td class="n">' + f1(r.spent) + '</td><td class="n">' + f1(r.spells) + '</td><td class="n">' + f1(r.hand) + '</td><td class="n">' + pc(r.pDrop) + '</td><td class="n">' + (X.cmds.length ? pc(r.pCmd) : '—') + '</td>' + RL.map(k => '<td class="n">' + pc(r.pRole[k[0]]) + '</td>').join('') + '</tr>').join('');
    const n = X.sim.roleN || {};
    return '<div class="an-card wide"><h3>Expected state by turn</h3><div class="scroll"><table class="t compact turns"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<p class="note">Lands, mana, spells, hand size, land drops and commander: mean (or share) across ' + X.sim.games.toLocaleString() + ' seeded goldfish games on the play, no opponents, with the mulligan and casting rules under Method. "Seen" columns are exact hypergeometric odds of at least one such card among the cards seen by that turn (deck counts: ' + RL.map(k => k[1].toLowerCase() + ' ' + (n[k[0]] || 0)).join(', ') + ').</p></div>';
  }
  // gaps against the benchmarks; with cards, each gap also lists candidate cards to add (Improve)
  const SEV = { high: 0, med: 1, low: 2, info: 3 };
  const rankedRecs = X => X.recs.slice().sort((a, b) => SEV[a.sev] - SEV[b.sev]);
  // on Analysis (no cards) high and medium problems are listed and the rest folded away
  function findingsHTML(X, cards) {
    const sevLabel = { high: 'High', med: 'Medium', low: 'Low', info: 'Info' };
    const li = r => '<li><span class="chip sev-' + r.sev + '">' + sevLabel[r.sev] + '</span> ' + esc(cards ? r.text : (r.text.replace(/\s*[^.]*:$/, '') || r.text)) +
      (!cards ? '' : r.cards.length ? '<div class="recc">' + r.cards.map(c => '<span class="chip">' + (c.uri ? '<a href="' + esc(c.uri) + '" target="_blank" rel="noopener">' + esc(c.n) + '</a>' : esc(c.n)) + (c.price != null ? ' · ' + fmtP(c.price) : '') + (c.rank ? ' · #' + c.rank : '') + '</span>').join('') + '</div>' : '') +
      (r.combos && cards ? '<div class="recc">' + r.combos.map(v => '<span class="chip">+ ' + esc(v.missing.join(', ')) + ' → ' + esc(v.cards.join(' + ')) + (v.produces.length ? ' (' + esc(v.produces[0]) + ')' : '') + '</span>').join('') + '</div>' : '') + '</li>';
    const list = rankedRecs(X);
    if (!list.length) return '<div class="an-card wide"' + (cards ? '' : ' id="anProblems"') + '><h3>' + (cards ? 'Candidate cards by problem' : 'Problems') + '</h3><p class="note">No gaps against the benchmarks.</p></div>';
    if (cards) return '<div class="an-card wide"><h3>Candidate cards by problem</h3><ol class="recs">' + list.map(li).join('') + '</ol></div>';
    const top = list.filter(r => r.sev === 'high' || r.sev === 'med'), rest = list.slice(top.length);
    return '<div class="an-card wide" id="anProblems"><h3>Problems, most serious first</h3>' + (top.length ? '<ol class="recs">' + top.map(li).join('') + '</ol>' : '<p class="note">No high or medium problems.</p>') +
      (rest.length ? '<details class="an-more"><summary class="note">' + rest.length + ' minor note' + (rest.length === 1 ? '' : 's') + ' (low and info)</summary><ol class="recs" start="' + (top.length + 1) + '">' + rest.map(li).join('') + '</ol></details>' : '') + '</div>';
  }
  // Analysis and Improve share one analysis (App.AN)
  function renderAnView() { if (App.tab === 'changes') renderChanges(); else if (App.tab === 'percard') renderPerCard(); else if (App.tab === 'analysis') renderAnalysis(); }
  function renderChanges() {
    if (App.anSource === 'compare') { $('view').innerHTML = '<p class="note">Suggested swaps apply to one list. On <button type="button" class="link" data-go="analysis">Analysis</button>, choose the deck or a pasted list instead of Compare.</p>'; return; }
    App.recsShown = true; // opening Changes is asking for them
    const X = App.AN;
    if (!X || X.stale) { $('view').innerHTML = '<p class="note">Analyzing…</p>'; App.AN = null; runAnalysis(); return; }
    if (X.error) { $('view').innerHTML = '<div class="msg err">' + esc(X.error) + '</div>'; return; }
    if (X.held) { X.held = false; setTimeout(() => scoreSwaps(X), 0); }
    const who = X.label + ': ' + X.cmds.map(c => esc(c.n)).join(' + ') + ' · power ' + X.power.pl.toFixed(1) + ' · fundamentals ' + X.overall + '/100';
    $('view').innerHTML = '<p class="note">' + who + '. Each change is scored alone against the current list. Accept applies it; Deny hides that card.</p>' +
      deepBarHTML(X) + '<div class="an-card wide"><h3>Recommended changes</h3><div id="anSwaps">' + swapsHTML(X) + '</div></div>' + (X.recs.length ? '<details class="an-more"><summary class="note">More candidate cards for each problem (' + X.recs.length + ')</summary>' + findingsHTML(X, true) + '</details>' : '');
  }
  /* ---------- By card (Improve): up to three better cards for each card, one per price band, each measured as a swap ---------- */
  async function perCardRun() {
    const X = App.AN; if (!X || !X.planner || (App.PC && App.PC.busy)) return;
    const inp = X.inp, cp = comboProvider(), t0 = performance.now();
    const keep = new Set(inp.cmds.map(c => c.n).concat(App.anSource !== 'paste' && App.R ? App.R.deck.filter(e => e.inc).map(e => e.c.n) : []));
    const src = ['src-engine', 'src-mech', 'src-plan', 'src-analysis', 'src-deep'].map(id => { const el = document.getElementById(id); return el ? el.textContent : null; });
    const useW = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && src.every(Boolean);
    let ex = null;
    const PC = App.PC = { busy: true, X, frac: 0, cancel: () => { if (ex) ex.cancel(); } };
    renderView();
    try {
      PC.res = await Deep.perCard(X, { deck: inp.deck, cmds: inp.cmds, combos: X.combos || null, prov: cp, keep, settings: App.S },
        init => (ex = useW ? Deep.workerExec(init, src.join('\n'), deepWorkers()) : Deep.localExec(init)),
        (d, t) => { PC.frac = d / t; const b = $('pcBar'), n = $('pcNote'); if (b) b.value = d / t; if (n) n.textContent = 'Measured ' + d + '/' + t + '…'; return useW ? null : new Promise(r => setTimeout(r, 0)); });
      PC.secs = (performance.now() - t0) / 1000;
    } catch (e) { PC.err = /cancel/.test(String(e && e.message)) ? 'Cancelled.' : 'Failed: ' + (e && e.message || e); PC.res = null; }
    finally { PC.busy = false; if (App.tab === 'percard') renderView(); }
  }
  function renderPerCard() {
    if (App.anSource === 'compare') { $('view').innerHTML = '<p class="note">By card applies to one list. On <button type="button" class="link" data-go="analysis">Analysis</button>, choose the deck or a pasted list instead of Compare.</p>'; return; }
    const X = App.AN;
    if (!X || X.stale) { $('view').innerHTML = '<p class="note">Analyzing…</p>'; App.AN = null; runAnalysis(); return; }
    if (X.error) { $('view').innerHTML = '<div class="msg err">' + esc(X.error) + '</div>'; return; }
    const PC = App.PC, busy = PC && PC.busy, res = PC && !busy ? PC.res : null, cur = X.cur || 'usd', money = v => Engine.fmt(v, cur);
    const BL = { budget: 'Budget', mid: 'Mid', premium: 'Premium' };
    const bar = '<div class="an-card wide deep"><div class="row" style="gap:8px;align-items:center">' + (busy ? '<button type="button" class="small" data-pc="cancel">Cancel</button>' : '<button type="button" class="small primary" data-pc="run">' + (res ? 'Measure again' : 'Find options (~20 s)') + '</button>') +
      '<progress id="pcBar" max="1" value="' + (busy ? PC.frac || 0 : 1) + '"' + (busy ? '' : ' hidden') + '></progress><span class="note" id="pcNote">' + (busy ? 'Preparing…' : PC && PC.err ? esc(PC.err) : res ? res.rows.length + ' of ' + res.cards + ' cards have a better option; ' + res.evals + ' swaps measured at ' + res.games.toLocaleString() + ' games, ' + PC.secs.toFixed(1) + ' s.' + (PC.X !== X ? ' Measured before your last swap.' : '') : 'For each card: the best measured replacement at up to its price or $1 (Budget), up to 3× its price or $5 (Mid), and above (Premium). Options that gain less than ' + Deep.MIN_GAIN / 2 + ' are left out.') + '</span></div></div>';
    if (!res) { $('view').innerHTML = bar; return; }
    const deck = X.inp ? X.inp.deck : [], has = c => deck.some(e => e.c === c || e.c.n === c.n);
    const rows = res.rows.filter(r => has(r.cut)).map(r => Object.assign({}, r, { opts: r.opts.filter(o => !has(o.add)) })).filter(r => r.opts.length);
    App.pcRows = rows;
    const body = rows.map((r, i) => '<tr><td><b>' + cardLink(r.cut) + '</b><div class="note">' + money(r.price) + (r.roles.length ? ' · ' + r.roles.map(k => esc(Engine.SLOT_LABEL[k] || k)).join(', ') : '') + '</div></td>' +
      '<td><div class="pc-opts">' + r.opts.map((o, j) => '<div class="pc-opt"><span class="note">' + BL[o.band] + '</span> <span class="in">+ ' + cardLink(o.add) + '</span> <span class="note">' + money(o.price) + ' · gain ' + (Math.round(o.g * 10) / 10) + (o.d && o.d.pl ? ' · power ' + (o.d.pl > 0 ? '+' : '') + o.d.pl : '') + '</span> <button type="button" class="small" data-pc="swap" data-i="' + i + '" data-j="' + j + '">Swap</button></div>').join('') + '</div></td></tr>').join('');
    $('view').innerHTML = bar + '<div class="an-card wide"><div class="scroll"><table class="t compact swaps"><thead><tr><th>Card</th><th>Better options</th></tr></thead><tbody>' + (body || '<tr><td colspan="2" class="note">No card has a better option that gains ' + Deep.MIN_GAIN / 2 + ' or more.</td></tr>') + '</tbody></table></div>' + (res.none ? '<p class="note">' + res.none + ' other nonland cards have no better option in the loaded data.</p>' : '') + '</div>';
  }
  // Analysis, in order: overview, problems, counts against real decks, measured swaps, detail. One page for checking a list
  // and fixing it; Improve keeps the slower searches (deep search, by card, budget upgrades, combos).
  function anCountsHTML(X) {
    const R = App.anSource === 'paste' ? { deck: X.inp.deck, CI: X.CI, settings: App.S } : App.R;
    if (!R || !R.deck) return '';
    const C = countsHTML(R, App.anSource === 'paste' || X.inp.asIs ? X.power.minBracket : null);
    return '<div class="an-card wide" id="anCounts"><div class="an-top wrap"><h3>Counts against real decks</h3>' + C.seg + '</div>' + C.html + '</div>';
  }
  // the end of Analysis: hand-off to Improve, where the swaps are measured
  function anNextHTML(X) {
    if (App.anSource === 'paste') return '';
    const o = ownedCards(), mine = ownOnly() && o && o.set.size, own = ownSumHTML();
    const what = X.plans.length ? X.plans.length + ' candidate swap' + (X.plans.length === 1 ? '' : 's') + ' for the problems above' : 'No obvious swaps; deep search and budget upgrades look further';
    return '<div class="next-tile" id="anNext"><div><p><b>Next: Improve.</b> ' + what + ', measured with simulated games, from ' + (mine ? 'your collection (' + o.set.size.toLocaleString() + ' cards)' : 'all cards') + '.</p>' + (own ? '<p>' + own + '</p>' : '') + '</div><button type="button" class="primary" data-go="changes">Improve this deck ›</button></div>';
  }
  function renderAnalysis() {
    const X = App.AN;
    const src = '<div class="row an-src"><div class="seg" role="radiogroup" aria-label="Analyze"><button type="button" data-an="src-deck" aria-pressed="' + (App.anSource !== 'paste' && App.anSource !== 'compare') + '">' + (App.chain && App.chain.env && App.chain.env.imported ? 'Imported deck' : 'This deck') + '</button>' + (App.anSource === 'paste' ? '<button type="button" data-an="src-paste" aria-pressed="true">Pasted list</button>' : '') + '<button type="button" data-an="src-compare" aria-pressed="' + (App.anSource === 'compare') + '">Compare</button></div><label class="f inline">Simulated games <select id="anGames">' + [1500, 10000, 25000, 50000, 100000].map(g => '<option value="' + g + '"' + (g === anGames() ? ' selected' : '') + '>' + g.toLocaleString() + '</option>').join('') + '</select></label><button type="button" class="primary small" data-an="run">Analyze</button></div>' +
      (App.anSource === 'paste' || App.anSource === 'compare' ? '<label class="f" style="margin-top:8px">' + (App.anSource === 'compare' ? 'List to compare against the generated deck. ' : '') + 'Decklist (Moxfield, Archidekt, MTGO or plain "1 Name"; commander under a "Commander" header or tagged [Commander])<textarea id="anText" rows="8" spellcheck="false">' + esc(App.anText || '') + '</textarea></label>' : '');
    if (!X && !App.R && App.anSource !== 'compare') { $('view').innerHTML = '<div class="next-tile"><p><b>No deck yet.</b> Build one or import your list on Start, and its analysis opens here.</p><button type="button" class="primary" data-go="setup">Start ›</button></div>'; return; }
    if (!X) { $('view').innerHTML = src + '<p class="note" style="margin-top:10px">Scores speed, mana, card advantage, interaction, resilience, synergy, consistency and win pressure from card data, exact probabilities and a seeded goldfish simulation. Runs entirely in this page.</p>'; return; }
    if (X.error) { $('view').innerHTML = src + '<div class="msg err" style="margin-top:10px">' + esc(X.error) + (X.unknown && X.unknown.length ? '<br>Unknown names: ' + esc(X.unknown.join(', ')) : '') + '</div>'; return; }
    if (X.compare) { $('view').innerHTML = src + compareHTML(X); return; }
    const s = X.sim, b = X.bracket, W = X.power.win;
    // the header cards already show power, bracket and win turn for the deck; a pasted list shows them here
    const own = App.anSource === 'paste';
    const castLow = X.mana.cast.filter(r => r.p < X.mana.castOk), low = X.axes.slice().sort((a, b) => a.score - b.score)[0];
    const head = '<div class="summary an-head">' + [
      own && ['Power level', '<span class="big">' + X.power.pl.toFixed(1) + '</span><span class="note"> ±' + X.power.ci.toFixed(1) + '</span>'],
      own && ['Min. bracket', String(X.power.minBracket)],
      own && ['Win turn', 'T' + W.typical + (W.range ? '<span class="note"> T' + W.range[0] + '–' + W.range[1] + '</span>' : '')],
      ['Commander', X.cmds.map(c => esc(c.n)).join(' + ') + ' ' + pipsHTML(X.CI)],
      ['Fundamentals', X.overall + '<span class="note"> / 100</span>'],
      ['Balance', '<span class="kbal">' + miniRadarSVG(X.axes, 44) + '<span class="note">lowest<br>' + esc(low.label) + ' ' + low.score + '</span></span>'],
      ['Cards', X.deckSize + X.cmds.length + (X.deckSize + X.cmds.length !== 100 ? ' <span class="st fail">≠100</span>' : '') + (!own ? fillBtnHTML() : '')],
      ['Lands', X.nLands + '<span class="note"> curve estimate ' + X.mana.landEst.lands.toFixed(1) + '</span>'],
      ['Castable on curve', castLow.length ? '<span class="pup">' + castLow.length + ' card' + (castLow.length === 1 ? '' : 's') + ' below ' + Math.round(X.mana.castOk * 100) + '%</span>' : 'all ≥ ' + Math.round(X.mana.castOk * 100) + '%'],
      ['Commander turn (median)', s.cmdMedianTurn > 8 ? '>8' : 'T' + s.cmdMedianTurn],
      ['Combo turn (median)', W.combo ? 'T' + W.combo.median + '<span class="note"> T' + W.combo.q25 + '–' + W.combo.q75 + '</span>' : '<span class="note">no win combo</span>'],
      ['Avg MV', X.avgMV.toFixed(2)]
    ].filter(Boolean).map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>' +
      '<p class="note an-win">Win turn T' + W.typical + ' comes from ' + (W.source === 'simulated combo' ? 'the simulated combo turn (middle half of games T' + W.range[0] + '–T' + W.range[1] + ')' : 'the power level' + (W.combo ? '; the simulated combo median, T' + W.combo.median + ', is not faster' : '')) + '.' + (W.combo ? ' A win combo is assembled by T6 in ' + pct(W.combo.by6) + ' of games, by T8 in ' + pct(W.combo.by8) + '.' : '') +
      (castLow.length ? ' Hardest to cast on curve: ' + castLow.slice(0, 3).map(r => esc(r.n) + ' (' + r.k + r.color + ' by T' + r.t + ', ' + pct(r.p) + ')').join(', ') + '.' : '') + '</p>' +
      (X.unknown && X.unknown.length ? '<div class="msg warn">Not found in card data (skipped): ' + esc(X.unknown.join(', ')) + '</div>' : '');
    const axes = '<div class="an-grid">' + X.axes.map(a => '<div class="an-card"><div class="an-top"><h3>' + esc(a.label) + '</h3><span class="st ' + scoreCls(a.score) + '">' + a.score + '</span></div><div class="meter-1"><span style="width:' + a.score + '%"></span></div><table class="t compact"><tbody>' +
      a.factors.map(f => '<tr><td>' + esc(f.name) + '</td><td class="n">' + esc(f.value) + '</td><td class="n note nw">' + esc(String(f.target)) + '</td><td class="sc"><i style="width:' + Math.round(f.score * 100) + '%"></i></td></tr>').join('') + '</tbody></table></div>').join('') + '</div>';
    const P = X.power;
    const vecRows = P.vectors.map(v => '<div class="an-card"><div class="an-top"><h3>' + esc(v.label) + '</h3><span class="st ' + scoreCls(v.score) + '">' + v.score + ' · ' + esc(v.band) + '</span></div><div class="meter-1"><span style="width:' + v.score + '%"></span></div><table class="t compact"><tbody>' +
      v.parts.map(c => '<tr><td>' + esc(c.label) + '</td><td class="n">' + c.n + '</td><td class="n note nw">' + (c.w > 0 ? '×' + (Math.round(c.w * 100) / 100) : c.w) + '</td><td class="why">' + cardList(c.cards, 4) + '</td></tr>').join('') + '</tbody></table>' +
      (v.k ? '<p class="note">Score = 100·(1 − e^(−points/' + v.k + ')); points ' + v.pts.toFixed(1) + (P.weights[v.key] != null ? '; weight in power ' + P.weights[v.key] : '') + '.</p>' : '<p class="note">Starts at 100; multiplies power by ' + P.manaMult.toFixed(2) + '. Multicolor lands: ' + pct(v.fixShare) + '.</p>') + '</div>').join('');
    const comboRows = P.combos.length ? '<div class="scroll"><table class="t compact"><thead><tr><th class="n">Fam.</th><th>Cards</th><th>Outcome</th><th class="n">MV</th><th class="n">Turn</th><th>Early</th></tr></thead><tbody>' +
      P.combos.slice().sort((a, b) => a.family - b.family || b.score - a.score).slice(0, 40).map(cb => '<tr><td class="n">' + cb.family + '</td><td>' + esc(cb.cards.join(' + ')) + (cb.usesCmd ? ' <span class="chip">commander</span>' : '') + '</td><td>' + esc(cb.outcome) + '</td><td class="n" title="' + esc(cb.costSrc) + '">' + (cb.cost == null ? '—' : cb.cost) + '</td><td class="n">' + (cb.turn == null ? '>8' : 'T' + cb.turn) + '</td><td>' + (cb.early ? '<span class="chip flag">yes</span>' : 'no') + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="note">' + (X.combos == null ? 'Load the Spellbook file to score combos.' : 'No complete combos.') + '</p>';
    const power = '<div class="an-card wide"><div class="an-top"><h3>Power level ' + P.pl.toFixed(1) + ' ±' + P.ci.toFixed(1) + ' · ' + esc(P.label) + '</h3><span class="chip">' + esc(P.confidence) + ' confidence</span></div>' +
      '<table class="t compact"><tbody>' +
      '<tr><td>Archetype</td><td>' + esc(P.primary) + '</td><td class="why">' + esc(P.archetypes.slice(1, 4).map(a => a.name + ' ' + a.score.toFixed(2)).join(' · ')) + '</td></tr>' +
      '<tr><td>Vector mix → raw</td><td class="n">' + P.plRaw.toFixed(1) + '</td><td class="why">speed ' + P.weights.speed + ', consistency ' + P.weights.consistency + ', interaction ' + P.weights.interaction + ', threats ' + P.weights.threats + ' (' + esc(P.primary) + ' weights)</td></tr>' +
      '<tr><td>Card quality</td><td class="n">' + P.qScore + '</td><td class="why">mean card power of top 60 nonland cards ' + P.cardQ + ' (scaled to 100 at 0.6); 30% of raw power</td></tr>' +
      '<tr><td>Mana base multiplier</td><td class="n">×' + P.manaMult.toFixed(2) + '</td><td></td></tr>' +
      '<tr><td>Strategy ceiling</td><td class="n">' + P.ceiling.toFixed(1) + '</td><td class="why">' + (P.ceilingBinding ? 'binding. ' : '') + P.signals.map(sg => (sg.on ? '✓ ' : '✗ ') + esc(sg.label)).join('<br>') + '</td></tr>' +
      '<tr><td>Win turn</td><td class="n">T' + P.win.best + ' / T' + P.win.typical + ' / T' + P.win.contested + '</td><td class="why">best / typical / contested; typical from ' + (P.win.source === 'simulated combo' ? 'the simulated combo turn (middle half of games T' + P.win.range[0] + '–T' + P.win.range[1] + ')' : 'the power level') + (P.win.combo ? '; a win combo is assembled by T6 in ' + pct(P.win.combo.by6) + ' of games, by T8 in ' + pct(P.win.combo.by8) : '') + '; goldfish damage reaches ' + P.win.goldfish.life + ' by ' + (P.win.goldfish.median > P.win.goldfish.horizon ? 'no turn up to T' + P.win.goldfish.horizon : 'T' + P.win.goldfish.median) + ' (median)</td></tr>' +
      (X.sim.table ? '<tr><td>Table win rate</td><td class="n">' + pct(X.sim.table.win) + '</td><td class="why">against three Bracket ' + X.sim.table.bracket + ' opponents (an average deck of that bracket wins 25%): ' + Math.ceil(X.sim.games / 4).toLocaleString() + ' games with their win turns, removal, wipes and counters drawn from EDHREC average decks of the bracket; you spend ' + X.sim.table.answers.toFixed(1) + ' answers a game on an opponent about to win, and they spend ' + X.sim.table.oppAnswers.toFixed(1) + ' on yours</td></tr>' : '') +
      '<tr><td>Recommended minimum bracket</td><td class="n">' + P.minBracket + '</td><td class="why">' + esc(P.minBracketWhy.join('; ')) + '</td></tr>' +
      '<tr><td>Uncertainty from</td><td></td><td class="why">' + esc(P.ciParts.join(', ')) + '</td></tr>' +
      '<tr><td>EDHREC rank of nonland cards</td><td></td><td class="why">' + P.quality.map(q => esc(q.label) + ': ' + q.n).join(' · ') + ' (popularity, not power)</td></tr>' +
      '</tbody></table></div>' +
      '<div class="an-grid">' + vecRows + '</div>' +
      '<div class="an-card wide"><h3>Combos (' + P.combos.length + ' lines, ' + P.families.length + ' families)</h3>' + comboRows + '<p class="note">Family = combos sharing a card; family value = best line + 25% of the rest, capped at 1.5× best. Line value = compactness (2 cards 1.0, 3 cards 0.7, 4 cards 0.45) × outcome (win 1.0, infinite resource 0.75, lock 0.45, value 0.3). Early = all pieces castable by turn 5 using simulated mana from two consecutive turns.</p></div>';
    const goldfish = '<div class="an-card"><h3>Goldfish simulation</h3>' + manaLineSVG(s) + '<p class="note">Average mana available at the start of each turn (line) against one land per turn (dashed). ' + s.games.toLocaleString() + ' seeded games; simulated percentages carry a 95% margin of at most ±' + (196 * Math.sqrt(0.25 / s.games)).toFixed(2) + ' points.</p><table class="t compact"><tbody>' +
      [['Keepable 7 (2–5 lands, a spell of MV ≤ 3)', pct(s.keep7) + ' sim · 2–5 lands ' + pct(X.prob.openingLands.p2to5) + ' exact'], ['Opening 7 with ≥3 lands (exact)', pct(X.prob.openingLands.p3plus)], ['≥1 ramp at MV ≤2 by turn 2 (exact)', pct(X.prob.pRampEarly) + ' (' + X.prob.nRamp2 + ' cards)'], ['Missed natural land drop by T4', pct(s.missLandDropT4)], ['Flooded at T6 (≥3 lands, ≤1 spell in hand)', pct(s.flood6)], ['Stuck on ≤3 lands at T6', pct(s.screw6)], ['Commander cast by its MV turn (MV ' + s.cmdCmc + ')', s.cmdOnCurve == null ? '—' : pct(s.cmdOnCurve)], ['Mana spent / available, T1–6', pct(s.efficiency6)], ['Spells cast by T6 (avg)', s.spellsBy6.toFixed(1)]]
        .map(r => '<tr><td>' + r[0] + '</td><td class="n">' + r[1] + '</td></tr>').join('') + '</tbody></table></div>';
    const mana = '<div class="an-card"><h3>Mana base</h3><table class="t compact"><thead><tr><th>Color</th><th class="n">Pips</th><th class="n">Pip %</th><th class="n">Land src</th><th class="n">All src</th><th>Check</th></tr></thead><tbody>' +
      X.mana.colors.map(c => '<tr><td>' + pipsHTML(c.color) + '</td><td class="n">' + c.pips.toFixed(1).replace(/\.0$/, '') + '</td><td class="n">' + pct(c.pipShare) + '</td><td class="n">' + c.landSources + '</td><td class="n">' + c.allSources + '</td><td>' + (c.warn ? '<span class="chip flag">' + esc(c.warn) + '</span>' : '<span class="chip">ok</span>') + '</td></tr>').join('') +
      '</tbody></table>' + (() => { const low = X.mana.cast.filter(r => r.p < X.mana.castOk); return low.length ? '<p class="note">Below ' + Math.round(X.mana.castOk * 100) + '% castable on curve (' + low.length + '): ' + low.slice(0, 8).map(r => esc(r.n) + ' ' + r.k + r.color + ' T' + r.t + ' ' + pct(r.p)).join(' · ') + (low.length > 8 ? ' …' : '') + '</p>' : ''; })() +
      '<p class="note">Lands: ' + X.nLands + ' · curve estimate ' + X.mana.landEst.lands.toFixed(1) + ' (Karsten).</p><p class="note">Lands entering tapped (' + X.mana.tapped.length + '): ' + cardList(X.mana.tapped) + '</p></div>';
    const cov = X.interaction.coverage;
    const inter = '<div class="an-card"><h3>Interaction coverage</h3><table class="t compact"><tbody>' +
      [['Creatures', cov.creature], ['Artifacts', cov.artifact], ['Enchantments', cov.enchantment], ['Planeswalkers', cov.planeswalker], ['Lands', cov.land], ['Spells (counters)', cov.spell], ['Graveyards', X.interaction.gyHate]]
        .map(([k, v]) => '<tr><td>' + k + '</td><td class="n">' + v.length + '</td><td class="why">' + cardList(v, 6) + '</td></tr>').join('') +
      '</tbody></table><p class="note">Instant speed: ' + X.interaction.instantInteraction.length + ' · MV ≤ 2: ' + X.interaction.cheapInteraction.length + '</p></div>';
    const syn = X.synergy;
    const themes = syn.pairs.filter(p => p.active || p.en.length + p.pay.length >= 4);
    const synergy = '<div class="an-card wide"><h3>Synergy themes</h3>' + (themes.length ? '<div class="scroll"><table class="t compact"><thead><tr><th>Theme</th><th class="n">Enablers</th><th class="n">Payoffs</th><th>Commander</th><th>Status</th></tr></thead><tbody>' +
      themes.map(p => '<tr><td>' + esc(p.label) + '</td><td class="n" title="' + esc(p.en.join(', ')) + '">' + p.en.length + '</td><td class="n" title="' + esc(p.pay.join(', ')) + '">' + p.pay.length + '</td><td>' + (p.cmdEn ? 'enabler ' : '') + (p.cmdPay ? 'payoff' : '') + '</td><td><span class="chip ' + (p.status === 'balanced' ? '' : p.active ? 'gc' : '') + '">' + esc(p.status) + '</span></td></tr>').join('') + '</tbody></table></div>' : '<p class="note">No enabler/payoff theme detected.</p>') +
      (syn.tribal ? '<p class="note">Tribal: ' + esc(syn.tribal.type) + ' × ' + syn.tribal.count + (syn.tribal.cmdMentions ? ' (commander names it)' : '') + '; cards naming the type: ' + syn.tribal.payoffs.length + '.</p>' : '') +
      '<p class="note">' + pct(syn.synShare) + ' of nonland cards link to at least one other card or the commander; median ' + syn.medianLinks + ' links.</p>' +
      '<details><summary class="note" style="cursor:pointer">Per-card synergy links (' + syn.perCard.length + ')</summary><div class="scroll"><table class="t compact"><thead><tr><th>Card</th><th class="n">Links</th><th>Themes</th><th>Roles</th></tr></thead><tbody>' +
      syn.perCard.map(x => '<tr><td>' + esc(x.c.n) + '</td><td class="n">' + x.links + '</td><td class="why">' + esc(x.why.join(', ')) + '</td><td>' + x.roles.map(r => '<span class="chip">' + esc(Engine.SLOT_LABEL[r]) + '</span>').join('') + '</td></tr>').join('') + '</tbody></table></div></details></div>';
    const br = '<div class="an-card"><h3>Bracket estimate: ' + esc(b.estimate) + '</h3><p class="note">Built for games that end turn ' + esc(b.turns) + '.</p><table class="t compact"><tbody>' +
      [['Game Changers', b.counts.gc], ['Tutors', b.counts.tutor], ['Extra turns', b.counts.xturn], ['Mass land denial', b.counts.mld], ['Fast mana', b.counts.fast], ['2-card infinites', b.twoInf == null ? 'not checked (no Spellbook file)' : b.twoInf]].map(r => '<tr><td>' + r[0] + '</td><td class="n">' + r[1] + '</td></tr>').join('') + '</tbody></table>' +
      (b.reasons.length ? '<p class="note">' + esc(b.reasons.join('; ')) + '.</p>' : '') + (b.note ? '<p class="note">' + esc(b.note) + '</p>' : '') +
      (X.combos && X.combos.length ? '<p class="note">Combos: ' + esc(X.combos.slice(0, 6).map(v => v.c.join(' + ')).join('; ')) + '</p>' : '') + '</div>';
    const recs = findingsHTML(X, false);
    const method = '<details class="an-method"><summary class="note" style="cursor:pointer">Method and assumptions</summary><ul class="note">' +
      '<li>Role, flag and theme detection use the oracle-text rules listed under Advanced → Tag and flag rules. Themes are enabler/payoff pairs; a link is one card on the opposite side of the same theme (commander counts 3).</li>' +
      '<li>Targets come from your Category targets and target average MV. "avg" next to a target is the mean per deck across EDHREC decklists (<a href="https://edhrec.com/articles/the-deck-of-many-things-card-frequencies-by-type-and-function-across-edh" target="_blank" rel="noopener">EDHREC, Jul 2022</a>: 35.9 lands, 12.7 ramp, 7.6 draw, 8.5 spot removal, 2.7 wipes, 3.0 tutors); it describes what players build, not an optimum. Other targets are heuristics shown next to each factor.</li>' +
      '<li>Color sources: for every card, the exact chance of having its colored pips from lands by the turn equal to its mana value, given you hit your land drops (Frank Karsten\'s definition; mana rocks and dorks not counted). A color is flagged when any card is below ' + Math.round(Analysis.CAST_OK * 100) + '%. Karsten\'s 99-card figures (19 sources for one pip on turn 1, 30 for two on turn 2; <a href="https://scrollvault.net/guides/mana-bases.html" target="_blank" rel="noopener">summary</a>) give 81% and 87% under this model, because his also count mulligans.</li>' +
      '<li>Land estimate: 31.42 + 3.13 × average MV − 0.28 × cheap ramp and draw (MV ≤ 2) − 1.35 for the free mulligan, attributed to Frank Karsten (<a href="https://scrollvault.net/guides/how-many-lands.html" target="_blank" rel="noopener">summary</a>). This deck: ' + X.mana.landEst.lands.toFixed(1) + ' (avg MV ' + X.mana.landEst.avgMV.toFixed(2) + ', ' + X.mana.landEst.cheap + ' cheap ramp/draw).</li>' +
      '<li>Goldfish: seeded, ' + s.games + ' games, no opponents. One free mulligan when the opening 7 has fewer than 2 or more than 5 lands. Draws from turn 2. Each turn it plays an untapped land if possible, casts ramp first, then the commander, then the largest spells that fit. Mana rocks add mana immediately, creatures next turn, land-search ramp adds lands of any of your colors next turn. Lands and mana sources pay colored pips ({X} pips only; hybrid pips count as generic). London mulligan: the first is free, keep 7 with 2–5 lands and a spell of MV ≤ 3, otherwise keep 6 with one card on the bottom. Draw spells draw their number, draw engines one card a turn, tutors fetch a missing piece of the deck\'s closest win combo. A combo line counts as assembled when every piece has been drawn or tutored (the commander once cast) and this turn\'s plus last turn\'s mana covers its pieces. The damage clock counts creature power (evasive in full, others at half for blocks), tokens, anthems, overruns and drains to 120 (3 opponents × 40); it leaves out most value engines, so it is shown but not used for the win turn. Rituals and interaction are not modeled.</li>' +
      '<li>Exact probabilities use the hypergeometric distribution over the ' + X.deckSize + '-card library.</li>' +
      '<li>Power model follows the structure documented by <a href="https://scrycheck.com/docs" target="_blank" rel="noopener">ScryCheck</a>: five vectors (speed, consistency, interaction, mana base, threats), combo families from Spellbook, archetype-dependent weights, a strategy ceiling from four signals, a 1–10 scale with ± uncertainty, best/typical/contested win turns and a recommended minimum bracket. ScryCheck does not publish its weights, so every weight and curve here is this tool\'s own, shown on each card, and uncalibrated against labeled decks. Typical win turn maps power to WotC turn expectations (PL 5 → T8, 7 → T6, 8 → T5, 9 → T4). Raw power = 1 + 9·(0.7·vector mix + 0.3·card quality)/100. Card power (0–1) is an oracle-text heuristic: fast mana +0.45, Game Changer +0.35, tutor +0.2–0.35, cheap instant removal +0.3, MV≤1 ramp +0.3, free spells +0.25, cheap repeatable draw +0.2, plus 0.25×EDHREC popularity. Vector components weight each card by 0.6 + card power, so a like-for-like upgrade moves the score. ScryCheck\'s Playgroup.gg anchor, edhtop16 metagame test and per-card power ratings need online data and are not reproduced.</li>' +
      '<li>Bracket estimate: lowest bracket whose card limits (Bracket panel defaults) the list satisfies, per the <a href="https://mtg.wiki/page/Commander_Brackets" target="_blank" rel="noopener">Commander Brackets</a> as updated <a href="https://draftsim.com/mtg-october-2025-commander-bracket-changes/" target="_blank" rel="noopener">Oct 21 2025</a> and <a href="https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026" target="_blank" rel="noopener">Feb 9 2026</a>. Tutors are counted but no longer limit any bracket. Expected game length (B1 9+, B2 8+, B3 6+, B4 4+ turns) and intent are not measurable from card data.</li></ul></details>';
    const turns = turnsHTML(X);
    const stats = !own && App.R && App.R.stats;
    const SUBS = [['turns', 'Turn by turn'], ['power', 'Power'], ['fund', 'Fundamentals'], ['mana', 'Mana & interaction'], ['synergy', 'Synergy']].concat(stats ? [['stats', 'Deck stats']] : []).concat([['method', 'Method']]);
    const sub = SUBS.some(x => x[0] === App.anSub) ? App.anSub : 'turns';
    const overview = recs + anCountsHTML(X) + anNextHTML(X);
    const adv = '<div class="an-adv"><button type="button" class="small" data-an="adv" aria-expanded="' + !!App.anAdv + '">' + (App.anAdv ? 'Hide detail' : 'Show detail: turn by turn, power, fundamentals, mana, synergy' + (stats ? ', deck stats' : '') + ', method') + '</button></div>';
    const nav = App.anAdv ? '<div class="subtabs" role="tablist" aria-label="Analysis detail">' + SUBS.map(([k, l]) => '<button type="button" role="tab" data-ansub="' + k + '" aria-selected="' + (k === sub) + '">' + l + '</button>').join('') + '</div>' : '';
    const body = !App.anAdv ? '' : {
      stats: stats ? statsHTML(App.R) : '',
      turns: turns + '<div class="an-grid top">' + goldfish + '</div>',
      power: power,
      fund: '<div class="an-grid top"><div class="an-card"><h3>Profile</h3>' + radarSVG(X.axes) + '</div></div>' + axes,
      mana: '<div class="an-grid">' + mana + inter + br + '</div>',
      synergy: synergy,
      method: method.replace('<details class="an-method">', '<details class="an-method" open>')
    }[sub];
    const jump = '<div class="an-jump" role="group" aria-label="Go to">' + (App.anSource === 'paste' ? '' : '<button type="button" class="small primary" data-go="changes">Improve ›</button>') + [['anProblems', 'Problems'], ['anCounts', 'Counts'], ['anDetail', 'Detail']].map(([id, l]) => '<button type="button" class="small" data-jump="' + id + '">' + l + '</button>').join('') + '</div>';
    $('view').innerHTML = src + jump + head + overview + '<div id="anDetail">' + adv + nav + body + '</div>';
  }

  /* ---------- views ---------- */
  function renderSummary() {
    const R = App.R, el = $('summary');
    if (!R || !R.stats) { el.classList.add('hidden'); return; }
    const s = R.stats, v = R.validation;
    const fails = v.rules.filter(r => r.pass === false).length;
    el.innerHTML = [
      ['Commander', R.commanders.map(c => esc(c.n)).join(' + ') + ' ' + pipsHTML(R.CI)],
      ['Cards', (R.commanders.length + R.deck.reduce((a, e) => a + e.qty, 0)) + fillBtnHTML()],
      ['Avg MV', s.avgMV.toFixed(2)],
      ['Unpriced', s.unknown.length],
      ['Game Changers', s.gcs.length],
      ['Rules', '<button type="button" class="st ' + (fails ? 'fail' : 'pass') + ' stbtn" data-goto="' + (App.tab === 'valid' ? viewOf('cards') : 'valid') + '" title="' + (App.tab === 'valid' ? 'Back to the cards' : 'Show every rule') + '">' + (fails ? fails + ' failed' : 'All pass') + '</button>']
    ].map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('');
  }
  function emptyView() {
    const about = '<p>Builds a legal 100-card Commander deck from every card in the Scryfall file, then optimises it. A first pass fills lands, role slots (ramp, draw, removal, wipes, protection, recursion, win conditions) and your themes. The optimiser then scores every card in the deck against every legal candidate and keeps making the best swap until no swap raises the deck score, staying inside your bracket, budget and filters. Analysis rates the result (power level, speed, consistency, interaction, mana) with 100,000 simulated games, and Compare scores any other list the same way.</p>';
    if (App.bulk) return '<div class="empty"><h2>No deck yet</h2><p>' + App.bulk.all.length.toLocaleString() + ' unique cards loaded from ' + esc(App.bulk.meta.file || 'stored data') + '. Pick a commander, a budget and a plan on Start, then Generate deck.</p><div class="row"><button type="button" class="primary" data-goto="setup">Go to Start</button></div>' + about + '</div>';
    return '<div class="empty"><h2>Card data</h2>' + about + (window.EDH_SITE ? '<p>Card data loads from this site automatically. If it does not appear, load a Scryfall bulk file under Start, Card data.</p>' :
      '<ol><li>Download <b>Oracle Cards</b> from <a href="https://scryfall.com/docs/api/bulk-data" target="_blank" rel="noopener">scryfall.com/docs/api/bulk-data</a> (.json, .jsonl or .gz).</li><li>Load it under Start, Card data. It is read in this browser and kept for the next visit.</li><li>Pick a commander, then Generate deck.</li></ol>') + '</div>';
  }
  function deckRows(entries, groupKey) {
    const R = App.R;
    const groups = new Map();
    for (const e of entries) { const k = groupKey(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    let h = '';
    for (const [k, list] of groups) {
      list.sort((a, b) => a.c.cmc - b.c.cmc || (a.c.n < b.c.n ? -1 : 1));
      h += '<tr class="grp"><td colspan="4">' + esc(k) + ' (' + list.reduce((s, e) => s + e.qty, 0) + ')</td></tr>';
      for (const e of list) {
        const idx = R.deck.indexOf(e), a = Engine.analyze(e.c);
        const roles = Object.keys(a.roles).map(r => '<span class="chip" title="' + esc((a.rules[r] || []).join(', ')) + '">' + esc(Engine.SLOT_LABEL[r]) + '</span>').join('') +
          (e.c.gc ? '<span class="chip gc">Game Changer</span>' : '') +
          ['tutor', 'fast', 'stax', 'xturn', 'mld'].filter(f => a.flags[f]).map(f => '<span class="chip flag" title="' + esc(Engine.FLAGS[f].desc) + '">' + esc(Engine.FLAGS[f].label) + '</span>').join('');
        const p = e.c.p[R.settings.budget.cur];
        h += '<tr class="' + (e.locked ? 'locked' : '') + '">' +
          '<td class="nm">' + (e.locked ? '<span class="lockmk" title="Locked: kept on rebuild" aria-label="Locked">■</span> ' : '') + (e.qty > 1 ? '<span class="mono">' + e.qty + '×</span> ' : '') + cardLink(e.c) + '</td>' +
          '<td class="cost">' + manaHTML(e.c.mc) + '</td><td class="n">' + (p == null ? '—' : fmtP(p * e.qty)) + '</td>' +
          '<td>' + roles + '</td></tr>';
        if (App.openSwap === e) {
          const alts = R.alternatives(e, 5);
          h += '<tr class="alt"><td colspan="4"><b>Swap ' + esc(e.c.n) + '</b> <span class="note">five best alternatives inside your bracket and budget</span> <button type="button" class="link" data-act="swap" data-i="' + idx + '">close</button></td></tr>' +
            (alts.length ? alts.map((x, j) => '<tr class="alt"><td class="nm">' + cardLink(x.c) + '<div class="note">' + esc(x.why) + '</div></td><td class="cost">' + manaHTML(x.c.mc) + '</td><td class="n">' + fmtP(x.c.p[R.settings.budget.cur]) + '</td><td><button type="button" class="small" data-act="use" data-i="' + idx + '" data-j="' + j + '">Use</button> <span class="note">score ' + x.s.toFixed(2) + '</span></td></tr>').join('')
            : '<tr class="alt"><td colspan="4">No eligible alternative within current constraints.</td></tr>');
        }
      }
    }
    return h;
  }
  function renderDeckTable(byRole) {
    const R = App.R;
    const head = '<tr><th>Name</th><th>Cost</th><th class="n">Price</th><th>Roles / flags</th></tr>';
    const cmdRows = R.commanders.map(c => '<tr><td class="nm">' + cardLink(c) + (R.pairKind ? ' <span class="note">' + esc(R.pairKind) + '</span>' : '') + '</td><td class="cost">' + manaHTML(c.mc) + '</td><td class="n">' + fmtP(c.p[R.settings.budget.cur]) + '</td><td>' + (c.gc ? '<span class="chip gc">Game Changer</span>' : '') + '</td></tr>').join('');
    const order = byRole ? ['include', 'locked', 'land', 'basic', 'ramp', 'draw', 'removal', 'wipes', 'protection', 'recursion', 'wincon', 'combo', 'synergy', 'flex'] : ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];
    const key = byRole ? (e => Engine.SLOT_LABEL[e.slot] || e.slot) : (e => Engine.typeGroup(e.c));
    const sorted = R.deck.slice().sort((a, b) => { const ka = byRole ? order.indexOf(a.slot) : order.indexOf(Engine.typeGroup(a.c)); const kb = byRole ? order.indexOf(b.slot) : order.indexOf(Engine.typeGroup(b.c)); return ka - kb; });
    return '<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="note">' + sourceLine(R) + '</span>' + ownSumHTML() + '</div>' +
      '<div class="scroll"><table class="t deck"><thead>' + head + '</thead><tbody><tr class="grp"><td colspan="4">Commander (' + R.commanders.length + ')</td></tr>' + cmdRows + deckRows(sorted, key) + '</tbody></table></div>';
  }
  function curveSVG(curve) {
    const W = 360, H = 150, pl = 26, pb = 22, pt = 10, max = Math.max(4, ...curve), step = max > 20 ? 10 : max > 10 ? 5 : 2;
    const bw = (W - pl - 4) / curve.length, sy = v => H - pb - (v / (Math.ceil(max / step) * step)) * (H - pb - pt);
    let g = '';
    for (let t = 0; t <= Math.ceil(max / step) * step; t += step) g += '<line class="gl" x1="' + pl + '" x2="' + (W - 4) + '" y1="' + sy(t) + '" y2="' + sy(t) + '"/><text x="' + (pl - 4) + '" y="' + (sy(t) + 3) + '" text-anchor="end">' + t + '</text>';
    curve.forEach((v, i) => { const x = pl + i * bw + 3, y = sy(v); g += '<rect class="b" x="' + x + '" y="' + y + '" width="' + (bw - 6) + '" height="' + Math.max(0, H - pb - y) + '" rx="2"/>' + (v ? '<text class="lbl" x="' + (x + (bw - 6) / 2) + '" y="' + (y - 3) + '" text-anchor="middle">' + v + '</text>' : '') + '<text x="' + (x + (bw - 6) / 2) + '" y="' + (H - 7) + '" text-anchor="middle">' + (i === 7 ? '7+' : i) + '</text>'; });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px" role="img" aria-label="Mana curve of nonland cards">' + g + '</svg>';
  }
  function statsHTML(R) {
    const s = R.stats;
    const cols = (R.CI || 'C').split('');
    const pipRow = '<table class="t"><thead><tr><th>Color</th><th class="n">Pips</th><th class="n">Sources</th></tr></thead><tbody>' + cols.map(x => '<tr><td>' + pipsHTML(x === 'C' ? '' : x) + '</td><td class="n">' + (s.pips[x] || 0).toFixed(1).replace(/\.0$/, '') + '</td><td class="n">' + (s.sources[x] || 0) + '</td></tr>').join('') + '</tbody></table><div class="note">Sources: lands plus ramp cards whose Scryfall produced_mana (or fetch targets / any-color text) includes the color.</div>';
    const meters = [['lands', 'Lands']].concat(Engine.ROLES.map(r => [r, Engine.SLOT_LABEL[r]])).map(([k, label]) => {
      const m = s.roles[k], f = m.target ? Math.min(1, m.have / m.target) : 1;
      return '<div class="meter"><span>' + esc(label) + '</span><span class="track"><span class="fill' + (m.have < m.target ? ' short' : '') + '" style="width:' + (f * 100).toFixed(0) + '%"></span></span><span class="num">' + m.have + ' / ' + m.target + '</span></div>';
    }).join('');
    const combos = R.combos && R.combos.length ? '<ul>' + R.combos.map(v => '<li>' + esc(v.c.join(' + ')) + ' → ' + esc(v.p.join(', ')) + (v.bt ? ' <span class="chip">' + esc(v.bt) + '</span>' : '') + '</li>').join('') + '</ul>' : '<p class="note">' + (R.comboStatus === 'unavailable' ? 'No Commander Spellbook file loaded, so combos were not checked.' : 'No complete combos detected.') + '</p>';
    return '<div class="statsgrid an-stats">' +
      '<div><h3>Mana curve (nonland, excl. commander)</h3>' + curveSVG(s.curve) + '<p class="note">Average MV ' + s.avgMV.toFixed(2) + ' (target ' + (R.curveTarget != null ? +R.curveTarget : +R.settings.mana.avgMV).toFixed(1) + (R.plan && !R.settings.mana.fixedMV ? ', from the commander plan' : '') + '). Creatures: ' + s.creatures + '.</p></div>' +
      '<div><h3>Color pips and sources</h3>' + pipRow + '</div>' + colourCheckHTML(R) +
      '<div><h3>Category counts vs targets</h3><div style="display:flex;flex-direction:column;gap:6px">' + meters + '</div><p class="note">A card counts toward every role its tags match.</p></div>' +
      '<div><h3>Price</h3><p class="num">Total ' + fmtP(s.total) + (R.settings.budget.total != null ? ' / cap ' + fmtP(+R.settings.budget.total) : '') + '</p>' + (s.unknown.length ? '<p class="note">No price: ' + esc(s.unknown.join(', ')) + '</p>' : '') + '<h3 style="margin-top:8px">Game Changers (' + s.gcs.length + ')</h3><p>' + (s.gcs.length ? esc(s.gcs.join(', ')) : '<span class="note">None</span>') + '</p>' +
      '<h3 style="margin-top:8px">Detected combos</h3>' + combos + '</div>' +
      '<div><h3>Synergy tags used</h3>' + (R.tags.length ? '<table class="t"><tbody>' + R.tags.map(t => '<tr><td>' + esc(t.label) + '</td><td class="note">' + esc(t.src) + ', weight ' + t.w + '</td></tr>').join('') + '</tbody></table>' : '<p class="note">None derived from commander text; scores rely on roles, popularity and curve.</p>') + '</div>' +
      planHTML(R) + '</div>';
  }
  // mechanics-only builds: what the commander's plan profile asked for and how much of it the deck holds
  function planHTML(R) {
    const P = R.plan; if (!P) return '';
    const have = R.deck.filter(e => !Engine.analyze(e.c).isLand && P.isPlan(e.c)).length;
    return '<div><h3>Commander plan</h3><p>' + esc(P.summary) + '</p><p class="note">Mechanics only: EDHREC popularity is not used. ' + have + ' plan cards in the deck (quota ' + P.quota + ', ' + P.supply.toLocaleString('en-US') + ' in the pool).</p>' +
      (P.partSupply && P.partSupply.length ? '<table class="t"><tbody>' + P.partSupply.map(x => '<tr><td>' + esc(x.label) + '</td><td class="num">' + x.n.toLocaleString('en-US') + ' in pool</td></tr>').join('') + '</tbody></table>' : '') + '</div>';
  }
  // Deck › Counts: cards per role (same tagging as the generator) against the middle half of real decks of a bracket
  function countsHTML(R, bDef) {
    const RR = Analysis.ROLE_RANGES, b = App.countsB != null ? App.countsB : bDef != null ? bDef : (+R.settings.bracket || 0), ref = RR[b] || RR[0];
    const rc = Analysis.roleCounts(R.deck), blue = (R.CI || '').includes('U');
    const BN = { 0: 'All', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' };
    const seg = '<span class="row" style="gap:8px;align-items:center"><span class="note">Compare with</span><div class="seg" role="group" aria-label="Compare with bracket" id="cntB">' + Object.keys(BN).map(k => '<button type="button" data-cb="' + k + '" aria-pressed="' + (+k === b) + '" title="' + (k === '0' ? 'All brackets' : 'Bracket ' + k) + '">' + (k === '0' ? 'All' : 'B' + k) + '</button>').join('') + '</div></span>';
    let low = 0, high = 0;
    const rows = Analysis.COUNT_CATS.map(([k, label]) => {
      const x = rc[k], [p25, med, p75] = ref[k], na = k === 'counters' && !blue;
      const st = na ? ['na', 'No blue'] : x.n < p25 ? ['fail', 'Low'] : x.n > p75 ? ['warn', 'High'] : ['pass', 'Typical'];
      if (st[1] === 'Low') low++; if (st[1] === 'High') high++;
      const max = Math.max(x.n, p75 * 1.5, 4), pc = v => (Math.min(v, max) / max * 100).toFixed(1) + '%';
      const bar = na ? '' : '<span class="cband" aria-hidden="true"><i style="left:' + pc(p25) + ';width:calc(' + pc(p75) + ' - ' + pc(p25) + ')"></i><b style="left:' + pc(x.n) + '"></b></span>';
      const list = x.cards.length ? '<details class="ccards"><summary>' + x.cards.length + ' card' + (x.cards.length === 1 ? '' : 's') + '</summary>' + x.cards.slice().sort((a, c) => a.cmc - c.cmc || (a.n < c.n ? -1 : 1)).map(c => cardLink(c)).join(', ') + '</details>' : '<span class="note">none</span>';
      return '<tr><td class="m-2"><b>' + esc(label) + '</b></td><td class="n m-3 num"><b>' + x.n + '</b></td><td class="n num" data-l="Typical">' + (na ? '—' : fmtR(p25) + '–' + fmtR(p75)) + '</td><td class="n num" data-l="Median">' + (na ? '—' : fmtR(med)) + '</td><td class="m-full">' + bar + '</td><td class="m-1"><span class="st ' + st[0] + '">' + st[1] + '</span></td><td class="m-full2">' + list + '</td></tr>';
    }).join('');
    const sum = low || high ? (low ? low + ' below' : '') + (low && high ? ', ' : '') + (high ? high + ' above' : '') + ' the typical range' : 'Every category is inside the typical range';
    return { seg, html: '<p><b>' + esc(sum) + '</b> <span class="note">for ' + (b ? 'Bracket ' + b : 'all brackets') + ' (' + ref.n + ' reference decks).</span></p>' +
      '<div class="scroll"><table class="t mrows counts"><thead><tr><th>Category</th><th class="n">Deck</th><th class="n">Typical</th><th class="n">Median</th><th>Range</th><th>Status</th><th>Cards</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="note">Typical is the middle half (25th to 75th percentile) of ' + ref.n + ' Archidekt decklists' + (b ? ' tagged Bracket ' + b : '') + ' in data/reference, counted with the same rules as the generator; counterspells use only the ' + ref.nU + ' blue decks. The shaded band on each bar is that range and the mark is this deck. A card counts in every category it matches, and the commander is not counted. It describes what players build, not an optimum.</p>' };
  }
  function renderCounts() {
    const R = App.R, C = countsHTML(R);
    $('view').innerHTML = '<div class="row" style="justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px"><span class="note">' + sourceLine(R) + '</span>' + C.seg + '</div>' + C.html;
  }
  const fmtR = v => String(v).replace(/\.5$/, '½');

  function renderValidation() {
    const R = App.R;
    $('view').innerHTML = '<p class="note">' + sourceLine(R) + ' Checked ' + new Date(R.validation.at).toLocaleString() + '.</p><div class="scroll"><table class="t"><thead><tr><th>Rule</th><th>Result</th><th>Detail</th></tr></thead><tbody>' +
      R.validation.rules.map(r => '<tr><td>' + esc(r.label) + '</td><td><span class="st ' + (r.pass === true ? 'pass' : r.pass === false ? 'fail' : 'na') + '">' + (r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'N/A') + '</span></td><td>' + esc(r.detail) + (r.id === 'bracket' && !r.comboVerified ? ' <span class="note">(combo limit not verified)</span>' : '') + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function renderLog() {
    const R = App.R, O = R.optimize;
    $('view').innerHTML = '<div class="summary panel">' + [['Seed', '<span class="mono">' + esc(R.seedUsed) + '</span>'], ['Candidates', R.poolSize.toLocaleString()]].concat(O ? [['Deck score (optimiser objective)', O.baseline.toFixed(1) + ' → ' + O.final.toFixed(1)], ['Swaps', O.swaps.length + (O.timedOut ? ' (time cap reached)' : ' (no better single swap left)')], ['Card pairs scored', O.pairs.toLocaleString()]] : []).map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>' +
      '<ol class="mono" style="padding-left:22px;margin:14px 0 0;display:flex;flex-direction:column;gap:3px">' + R.log.map(l => '<li>' + esc(l) + '</li>').join('') + '</ol>';
  }
  function renderExport() {
    $('view').innerHTML = '<div class="row"><label class="f" style="min-width:220px">Format<select id="exFmt"><option value="plain">Plain text (1 Card Name)</option><option value="arena">Moxfield / Archidekt (Commander + Deck sections)</option><option value="archidekt">Archidekt ([Commander{top}] tag)</option><option value="mtgo">MTGO .txt (commander in sideboard)</option><option value="csv">CSV</option><option value="added">Added cards only (buy list, 1 Card Name)</option></select></label><button type="button" id="exCopy">Copy to clipboard</button><button type="button" id="exSave">Save file</button><span class="note" id="exNote"></span></div><textarea id="exText" rows="18" style="margin-top:8px" spellcheck="false" readonly></textarea>';
    const upd = () => {
      const f = $('exFmt').value, add = addedCards(), cur = App.R.settings.budget.cur;
      $('exText').value = f === 'added' ? buyList(add) : Engine.exportDeck(App.R, f);
      $('exNote').textContent = f === 'added' ? (add.length ? add.reduce((s, x) => s + x.qty, 0) + ' card(s) added since the deck was ' + (App.R.asIs ? 'imported' : 'generated') + ', ' + fmtP(add.reduce((s, x) => s + (x.c.p[cur] || 0) * x.qty, 0)) + '. Paste into a store\'s mass entry (TCGplayer, Card Kingdom).' : 'No cards added since the deck was ' + (App.R.asIs ? 'imported' : 'generated') + '.') : '';
    };
    $('exFmt').value = App.exFmt || 'plain'; upd();
    $('exFmt').addEventListener('change', () => { App.exFmt = $('exFmt').value; upd(); });
    $('exCopy').addEventListener('click', () => copyText($('exText').value, $('exText'), $('exNote')));
    $('exSave').addEventListener('click', () => { const f = $('exFmt').value; const base = (App.R.commanders[0].fn || 'deck').replace(/[^\w-]+/g, '_'); saveFile(base + (f === 'csv' ? '.csv' : f === 'mtgo' ? '_mtgo.txt' : '_' + f + '.txt'), $('exText').value, $('exNote')); });
  }
  function renderTests() {
    const T = App.tests;
    if (!T) { $('view').innerHTML = '<p>Runs the acceptance tests against the currently loaded data: 1-color, 5-color and Partner commanders chosen by EDHREC rank from the data, budget cap, infeasible budget, determinism, and Bracket 2 Game Changer count.</p><p class="note">Press Run acceptance tests.</p>'; return; }
    $('view').innerHTML = '<p class="note">' + esc(T.source) + ' · ' + esc(T.at) + '</p><div class="scroll"><table class="t"><thead><tr><th>Test</th><th>Result</th><th>Detail</th></tr></thead><tbody>' + T.rows.map(r => '<tr><td>' + esc(r.name) + '</td><td><span class="st ' + (r.pass === true ? 'pass' : r.pass === false ? 'fail' : 'na') + '">' + (r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'N/A') + '</span></td><td>' + esc(r.detail) + '</td></tr>').join('') + '</tbody></table></div>';
  }
  /* ---------- pages: five in the rail (plus More), each holding one or more views; App.tab is the current view ---------- */
  const PAGES = {
    start: ['Start', [['setup', 'Build a deck'], ['import', 'Import my deck'], ['find', 'Find a commander']]],
    collection: ['Collection', []],
    deck: ['Deck', [['cards', 'Cards'], ['counts', 'Counts'], ['hand', 'Sample hand'], ['export', 'Export']]],
    analysis: ['Analysis', []],
    improve: ['Improve', [['changes', 'Suggested swaps'], ['cats', 'By category'], ['percard', 'By card'], ['upgrade', 'Budget upgrades'], ['combos', 'Combos']]],
    primer: ['Primer', []],
    more: ['More', []]
  };
  const PAGE_OF = { setup: 'start', import: 'start', collection: 'collection', commanders: 'start', inspire: 'start', surprise: 'start', deck: 'deck', role: 'deck', counts: 'deck', hand: 'deck', export: 'deck', valid: 'deck', analysis: 'analysis', changes: 'improve', cats: 'improve', percard: 'improve', upgrade: 'improve', combos: 'improve', primer: 'primer', history: 'more', log: 'more', tests: 'more' };
  const FIND = [['commanders', 'Browse'], ['inspire', 'Quiz'], ['surprise', 'Random']];
  const subOf = v => v === 'role' || v === 'deck' || v === 'valid' ? 'cards' : FIND.some(f => f[0] === v) ? 'find' : v;
  const viewOf = sub => sub === 'cards' ? (App.groupBy === 'role' ? 'role' : 'deck') : sub === 'find' ? (App.findMode || 'commanders') : sub;
  const lastView = {};
  // opens a view (or a page's last view), as a click in the rail would
  function go(v) {
    if (PAGES[v] && PAGES[v][1].length) v = lastView[v] || viewOf(PAGES[v][1][0][0]);
    if (!PAGE_OF[v]) return;
    hidePop(); if (!App.busy) $('status').textContent = ''; App.tab = v; renderView(); if (window.scrollY > 200) window.scrollTo({ top: 0 });
    if (v === 'analysis' && App.anSource !== 'paste' && App.R && App.R.stats) runAnalysis();
  }
  const VIEW_NOTE = {
    setup: 'Add your collection if you like, then build a deck or import yours. Analysis checks it; Improve finds measured upgrades.',
    collection: 'Paste or load the cards you own. Every card you own gets a green dot, and you choose whether new decks and suggestions use only your cards.',
    import: 'Paste your current list. It is kept exactly as pasted and opens on Analysis; Improve then measures swaps, from all cards or only your collection.',
    commanders: 'Every legal commander in the card data, by colour, theme and popularity.', inspire: 'Answer a few questions; every legal commander is ranked against your answers, with the reasons it fits.', surprise: 'Random commanders from the card data. Filter the draw, reroll any one, and Build the one you like.',
    deck: 'Tap a card for its text and its actions: lock, swap or remove.', role: 'Grouped by the role slot each card fills. Tap a card for its actions.', valid: 'Every deck-building rule and whether this list passes it.',
    counts: 'How many cards the deck has for each job (lands, ramp, draw, removal, wipes and more) next to what real decks of the same bracket run.',
    hand: 'Draw opening hands from this list, mulligan and draw on.', export: 'Copy or download the list for Moxfield, Archidekt, MTGO or plain text.',
    analysis: 'How good the deck is: power, speed and mana from simulated games, its main problems, and its role counts against real decks.',
    changes: 'Cuts and adds for the deck, each measured with simulated games. Accept the ones you want.', cats: 'Pick a category (Ramp, Card draw, Removal…). Cards to add for it, each paired with a cut that keeps every other category in its typical range, the set measured together.', percard: 'Each card in the list with up to three better cards at different prices, each measured as a swap. You choose.', upgrade: 'Set an amount to spend. The best set of swaps that fits it, each add Commander-legal and in your colours, measured with simulated games.', combos: 'Commander Spellbook combos in this deck, one card away, and a search across every combo in the data.',
    primer: 'How to play this list, from its own simulation and card roles.',
    history: 'The last 25 decks and revisions in this browser. Tick two to compare them.', log: 'Each step the generator and optimiser took.', tests: 'Checks the generator against the loaded card data.'
  };
  function pageHeadHTML(page) {
    const v = App.tab, sub = subOf(v), views = PAGES[page][1];
    const title = page === 'more' ? { history: 'History', log: 'Build log', tests: 'Acceptance tests' }[v] : PAGES[page][0];
    const pill = (k, l, cur) => '<button type="button" role="tab" data-view="' + k + '" aria-selected="' + (k === cur) + '">' + l + '</button>';
    const opt = (k, l, cur) => '<button type="button" data-view="' + k + '" aria-pressed="' + (k === cur) + '">' + l + '</button>';
    let nav = views.length ? '<div class="subtabs" role="tablist" aria-label="' + esc(title) + ' views">' + views.map(([k, l]) => pill(k, l, sub)).join('') + '</div>' : '';
    if (sub === 'find') nav += '<div class="seg pgseg" role="group" aria-label="Find a commander">' + FIND.map(([k, l]) => opt(k, l, v)).join('') + '</div>';
    if (sub === 'cards' && v !== 'valid') nav += '<div class="seg pgseg" role="group" aria-label="Group cards by">' + [['deck', 'By type'], ['role', 'By role']].map(([k, l]) => opt(k, l, v)).join('') + '</div>';
    return '<h2>' + esc(title) + '</h2><p class="note">' + (VIEW_NOTE[v] || '') + '</p>' + (page === 'start' ? stepsHTML() : '') + (nav ? '<div class="pgnav">' + nav + '</div>' : '') + (page === 'improve' && App.bulk ? ownBarHTML() : '');
  }
  // Start: the four steps as tiles, each with where it stands and a link to its page
  function stepsHTML() {
    const o = ownedCards(), n = o ? o.set.size : 0, R = App.R && App.R.stats ? App.R : null, q = R ? quickStats() : null;
    const X = App.AN && App.AN.sim && !App.AN.error && !App.AN.compare ? App.AN : null, worthN = X && X.impactDone ? X.impact.filter(worth).length : null;
    const ML = { off: 'marked', prefer: 'preferred in builds', only: 'only these used' };
    const S = [
      ['collection', 'Collection', n ? n.toLocaleString() + ' cards · ' + ML[App.S.owned.mode || 'off'] : 'Optional. Mark the cards you own, or build only from them.', n ? 'Edit ›' : 'Add ›', n ? 'done' : ''],
      [R ? 'deck' : 'setup', 'Deck', R ? R.commanders.map(c => esc(c.n)).join(' + ') + ' · ' + Engine.fmt(R.stats.total, R.settings.budget.cur) : 'Build one below, or import your list.', R ? 'View ›' : '', R ? 'done' : 'next'],
      ['analysis', 'Analysis', q ? 'Power ' + q.pl.toFixed(1) + ' · plays like B' + q.minB + ' · wins T' + q.win : 'How good the deck is, after you have one.', R ? 'Open ›' : '', !R ? 'off' : X ? 'done' : 'next'],
      ['changes', 'Improve', worthN != null ? worthN + ' measured swap' + (worthN === 1 ? '' : 's') + ' worth making' : 'Measured swaps, budget upgrades and combos' + (ownOnly() && n ? ', from your cards' : '') + '.', R ? 'Open ›' : '', !R ? 'off' : X ? 'next' : '']
    ];
    return '<nav class="steps" aria-label="Steps">' + S.map(([g, l, sub, act, cls], i) => '<button type="button" class="step ' + cls + '" data-go="' + g + '"' + (!R && i > 1 ? ' disabled' : '') + '><span class="sh"><span class="sn">' + (cls === 'done' ? '✓' : i + 1) + '</span>' + l + '</span><span class="ss">' + sub + '</span>' + (act ? '<span class="sg">' + act + '</span>' : '') + '</button>').join('') + '</nav>';
  }
  function renderView() {
    const page = PAGE_OF[App.tab] || 'start';
    if (App.tab === 'deck' || App.tab === 'role') App.groupBy = App.tab === 'role' ? 'role' : 'type';
    if (FIND.some(f => f[0] === App.tab)) App.findMode = App.tab;
    if (App.tab !== 'valid') lastView[page] = App.tab;
    document.body.dataset.page = page; document.body.dataset.view = App.tab;
    document.querySelectorAll('.tabs button[data-page]').forEach(b => b.setAttribute('aria-selected', b.dataset.page === page));
    document.querySelectorAll('.tabs button[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === App.tab));
    $('moreBtn').classList.toggle('on', page === 'more');
    const setup = App.tab === 'setup';
    $('setupView').classList.toggle('hidden', !setup); $('view').classList.toggle('hidden', setup);
    $('summary').classList.toggle('hidden', !(App.tab === 'deck' || App.tab === 'role' || App.tab === 'valid') || !App.R || !App.R.stats);
    $('testBtn').classList.toggle('hidden', App.tab !== 'tests'); syncActions(); syncMini();
    $('pageHead').classList.remove('hidden'); $('pageHead').innerHTML = pageHeadHTML(page);
    if (setup) { $('view').innerHTML = ''; renderOwnTile(); return; } // a dynamic form left in #view must not hold data-k fields read by readForm()
    if (App.tab === 'collection') return renderCollection();
    if (App.tab === 'tests') return renderTests();
    if (App.tab === 'analysis') return renderAnalysis();
    if (App.tab === 'changes') return renderChanges();
    if (App.tab === 'percard') return renderPerCard();
    if (App.tab === 'history') return void renderHistory();
    if (App.tab === 'primer') return void renderPrimer();
    if (App.tab === 'combos') return void renderCombos();
    if (App.tab === 'upgrade') return renderUpgrade();
    if (App.tab === 'cats') return renderCats();
    if (App.tab === 'commanders') return renderCommanders();
    if (App.tab === 'inspire') return renderInspire();
    if (App.tab === 'surprise') return renderSurprise();
    if (App.tab === 'import') return renderImport();
    if (App.tab === 'hand') return renderHand();
    if (!App.R || !App.R.stats) { $('view').innerHTML = emptyView(); return; }
    switch (App.tab) {
      case 'deck': $('view').innerHTML = renderDeckTable(false); break;
      case 'role': $('view').innerHTML = renderDeckTable(true); break;
      case 'valid': renderValidation(); break;
      case 'counts': renderCounts(); break;
      case 'log': renderLog(); break;
      case 'export': renderExport(); break;
    }
  }
  /* ---------- history: last 25 decks and revisions (IndexedDB). An entry stores settings, locks/bans and the edit
     operations since generation; opening it regenerates (deterministic) and replays the edits, then checks the card list. ---------- */
  const HIST_MAX = 25;
  async function histLoad() { if (!App.history) App.history = (await IDB.get('history')) || []; return App.history; }
  async function histPush(kind, label) {
    const R = App.R; if (!R || !R.stats || App.restoring || !App.chain) return;
    const q = quickStats();
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), kind, label,
      settings: JSON.parse(JSON.stringify(App.chain.settings)), env: JSON.parse(JSON.stringify(App.chain.env)), ops: App.chain.ops.slice(),
      cmds: R.commanders.map(c => c.n), names: R.deck.map(x => x.qty + ' ' + x.c.n).sort(), file: ((R.dbMeta && R.dbMeta.file) || '') + (App.bulkCombos ? ' + Spellbook ' + (App.bulkCombos.meta.timestamp || '').slice(0, 10) : ''),
      m: { price: R.stats.total, cur: R.settings.budget.cur, cap: R.settings.budget.total, bracket: R.settings.bracket, pl: q && q.pl, fund: q && q.fund, score: q && q.score } };
    const h = await histLoad();
    // an unchanged rebuild (same settings, same cards) refreshes the newest entry instead of adding a duplicate
    if (h[0] && h[0].kind === e.kind && h[0].names.join('|') === e.names.join('|') && JSON.stringify(h[0].settings) === JSON.stringify(e.settings) && JSON.stringify(h[0].env) === JSON.stringify(e.env)) h[0].at = e.at;
    else { h.unshift(e); h.length = Math.min(h.length, HIST_MAX); }
    await IDB.put('history', h);
  }
  function histOp(op) { if (App.chain && !App.restoring) App.chain.ops.push(op); }
  async function histOpen(id) {
    const e = (await histLoad()).find(x => x.id === id); if (!e || App.busy) return;
    if (!(await replayChain({ settings: e.settings, env: e.env }, e.ops))) return;
    const R = App.R, now = R.deck.map(x => x.qty + ' ' + x.c.n).sort(), same = now.join('|') === e.names.join('|');
    App.AN = null; App.QS = null; App.tab = viewOf('cards'); renderAll();
    setStatus(same ? 'Restored "' + e.label + '" from ' + new Date(e.at).toLocaleString() + ' (identical card list).' : 'Restored "' + e.label + '", but ' + now.filter(n => !e.names.includes(n)).length + ' card(s) differ: the card or combo data changed since it was saved (' + (e.file || 'unknown file') + ' → ' + ((R.dbMeta && R.dbMeta.file) || 'current') + (App.bulkCombos ? ' + Spellbook ' + (App.bulkCombos.meta.timestamp || '').slice(0, 10) : '') + ').');
  }
  async function renderHistory() {
    const h = await histLoad(); if (App.tab !== 'history') return;
    if (!h.length) { $('view').innerHTML = '<p class="note">No saved decks yet. Each generated deck and each accepted change is saved here (last ' + HIST_MAX + ', in this browser).</p>'; return; }
    const sel = (App.hsel = (App.hsel || []).filter(id => h.some(x => x.id === id)));
    $('view').innerHTML = '<div class="scroll"><table class="t compact mrows"><thead><tr><th><span class="sr">Select</span></th><th>When</th><th>Deck</th><th>Change</th><th class="n">Bracket</th><th class="n">Price</th><th class="n">Power</th><th></th></tr></thead><tbody>' +
      h.map(e => '<tr><td class="m-1"><input type="checkbox" data-hsel="' + e.id + '" aria-label="Select for compare"' + (sel.includes(e.id) ? ' checked' : '') + '></td><td class="nw m-2">' + esc(new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</td><td class="m-full"><b class="mb">' + esc(e.cmds.join(' + ')) + '</b></td><td class="why m-full2">' + esc(e.label) + '</td><td class="n">B' + e.m.bracket + '</td><td class="n nw">' + Engine.fmt(e.m.price, e.m.cur || 'usd') + (e.m.cap != null && e.m.cap !== '' ? '<span class="note"> / ' + Engine.fmt(+e.m.cap, e.m.cur || 'usd') + '</span>' : '') + '</td><td class="n" data-l="Power">' + (e.m.pl != null ? e.m.pl.toFixed(1) : '—') + '</td><td class="nw m-3"><button type="button" class="small" data-hist="open" data-id="' + e.id + '">Open</button> <button type="button" class="small" data-hist="del" data-id="' + e.id + '" aria-label="Delete">✕</button></td></tr>').join('') +
      '</tbody></table></div><div class="row" style="margin-top:8px"><button type="button" class="small primary" data-hist="diff"' + (sel.length === 2 ? '' : ' disabled') + '>Compare selected (' + sel.length + '/2)</button><span class="note">Opening an entry rebuilds it from its settings and replays its edits; it flags any difference if the card data has changed since.</span><button type="button" class="small" data-hist="clear">Clear history</button></div>' +
      (sel.length === 2 && App.hdiff ? '<div id="hdiff" style="margin-top:14px">' + histDiffHTML(h.find(x => x.id === sel[0]), h.find(x => x.id === sel[1])) + '</div>' : '');
  }

  /* ---------- primer: a play guide derived from the deck's analysis (simulation, exact odds, card roles) ---------- */
  function primerData() {
    const R = App.R; if (!R || !R.stats || !App.bulk) return null;
    const key = deckKey(R);
    if (App.PR && App.PR.key === key) return App.PR.X;
    const full = App.AN && !App.AN.error && !App.AN.compare && App.AN.inp && App.AN.label !== 'Pasted list' && deckKey({ commanders: App.AN.cmds, deck: App.AN.inp.deck }) === key ? App.AN : null;
    const X = full || Analysis.run(App.bulk, R.deck, R.commanders, { settings: R.settings, combos: R.combos && R.combos.length ? R.combos : null, games: 10000 });
    App.PR = { key, X }; return X;
  }
  function renderPrimer() {
    const R = App.R;
    if (!R || !R.stats) { $('view').innerHTML = emptyView(); return; }
    const X = primerData(); if (!X) return;
    const A = c => Engine.analyze(c), pct = p => Math.round(p * 100) + '%', f1 = v => v.toFixed(1);
    const cards = R.deck.filter(e => !A(e.c).isLand).map(e => e.c);
    const list = (arr, max) => { arr = [...new Set(arr)]; max = max || 8; return arr.length ? arr.slice(0, max).map(esc).join(', ') + (arr.length > max ? ' and ' + (arr.length - max) + ' more' : '') : 'none'; };
    const byMV = pred => cards.filter(pred).sort((a, b) => a.cmc - b.cmc || (a.n < b.n ? -1 : 1)).map(c => c.n + ' (' + c.cmc + ')');
    const sim = X.sim, P = X.power, pt = sim.perTurn, row = t => pt[Math.min(pt.length, t) - 1];
    const cmdT = sim.cmdMedianTurn, cmds = R.commanders;
    const firstTurn = (k, p) => { const r = pt.find(r => r.pRole[k] >= p); return r ? 'by T' + r.t : 'only after T' + pt.length; };
    const pCmdBy = t => row(t).pCmd;
    const rampEarly = byMV(c => A(c).roles.ramp && c.cmc <= 2), rampMid = byMV(c => A(c).roles.ramp && c.cmc >= 3 && c.cmc <= 4);
    const oneSided = c => /(?:creatures?|permanents?|artifacts?|enchantments?) (?:your opponents control|you don't control|an opponent controls)|each opponent sacrifices/.test(c.low);
    const wipes = cards.filter(c => A(c).roles.wipes), wOne = wipes.filter(oneSided).map(c => c.n), wSym = wipes.filter(c => !oneSided(c)).map(c => c.n);
    const pw = p => 2 * Math.sqrt(p.en.length * p.pay.length), active = X.synergy.pairs.filter(p => p.active && pw(p) > 0).sort((a, b) => pw(b) - pw(a));
    const arch = P.archetypes.filter(a => a.score > 0), tied = arch.filter(a => a.score === arch[0].score);
    const vec = P.vectors.slice().sort((a, b) => a.score - b.score);
    const sec = (h, body) => '<div class="an-card wide primer"><h3>' + h + '</h3>' + body + '</div>';
    const li = arr => '<ul>' + arr.filter(Boolean).map(x => '<li>' + x + '</li>').join('') + '</ul>';
    const combos = (P.combos || []).filter(c => c.outcome !== 'value').slice(0, 5);

    const plan = li([
      'Archetype: <b>' + tied.map(a => esc(a.name)).join(' / ') + '</b>' + (tied.length > 1 ? ' (tied at ' + tied[0].score.toFixed(2) + ')' : '') + (arch.length > tied.length ? '; next: ' + arch.slice(tied.length, tied.length + 2).map(a => esc(a.name) + ' ' + a.score.toFixed(2)).join(', ') : '') + '. Power level ' + P.pl.toFixed(1) + ' (' + esc(P.label) + ').',
      cmds.length ? 'Commander' + (cmds.length > 1 ? 's' : '') + ': ' + cmds.map(c => '<b>' + esc(c.n) + '</b> (MV ' + c.cmc + ')').join(' and ') + '. Median cast turn in simulation: ' + (cmdT != null && cmdT <= pt.length ? 'T' + cmdT : 'after T' + pt.length) + '; cast by T4 in ' + pct(pCmdBy(4)) + ' of games, by T6 in ' + pct(pCmdBy(6)) + '.' : '',
      active.length ? 'Strongest synergy themes (enabler × payoff balance' + (active.length > 4 ? ', top 4 of ' + active.length : '') + '): ' + active.slice(0, 4).map(p => esc(p.label) + ' (' + p.en.length + ' enablers, ' + p.pay.length + ' payoffs' + (p.cmdEn || p.cmdPay ? ', commander is ' + (p.cmdEn && p.cmdPay ? 'both' : p.cmdEn ? 'an enabler' : 'a payoff') : '') + ')').join('; ') + '.' : 'No enabler/payoff theme reaches the active threshold; the deck wins on card quality rather than a synergy engine.',
      'Expected win turn without opposition: best T' + P.win.best + ', typical T' + P.win.typical + ', contested T' + P.win.contested + (P.win.combo ? '; a win combo is assembled by T6 in ' + pct(P.win.combo.by6) + ' of simulated games' : '') + '.',
      'Win conditions (' + X.threat.wincons.length + '): ' + list(X.threat.wincons, 10) + '.' + (X.threat.evasive.length ? ' Evasive creatures: ' + X.threat.evasive.length + '.' : '')
    ]);
    if (cmds.length) {
      const cmdText = cmds.map(c => '<p class="note"><b>' + esc(c.n) + '</b> ' + esc(c.mc || '') + ' · ' + esc(c.tl || '') + '<br>' + esc(c.ot || '').replace(/\n/g, '<br>') + '</p>').join('');
      var cmdSec = sec('Commander text', cmdText);
    }
    const mull = li([
      'Lands: ' + X.nLands + ' of ' + X.deckSize + '. Opening 7 has 2–5 lands in ' + pct(X.prob.openingLands.p2to5) + ' of hands and 3+ lands in ' + pct(X.prob.openingLands.p3plus) + '.',
      'Simulated keep rule: keep 7 with 2–5 lands and a spell of MV 3 or less, otherwise take the free mulligan; a second mulligan keeps 6. Kept on 7: ' + pct(sim.keep7) + ', mulliganed to 6: ' + pct(sim.mulligan2 || 0) + '.',
      'At least one ramp spell of MV ≤ 2 by your turn-2 draw: ' + pct(X.prob.pRampEarly) + ' (' + X.prob.nRamp2 + ' in the deck). A 2-land hand is a keep when it holds one of these.',
      'Missed land drop by T4: ' + pct(sim.missLandDropT4) + '. Flooded at T6: ' + pct(sim.flood6) + '. Screwed at T6 (3 or fewer lands): ' + pct(sim.screw6) + '.'
    ]);
    const tt = (a, b) => { const r1 = row(a), r2 = row(b); return 'lands ' + f1(r1.lands) + '–' + f1(r2.lands) + ', mana ' + f1(r1.mana) + '–' + f1(r2.mana) + ', ' + f1(r2.hand) + ' cards in hand by T' + b; };
    const turns = li([
      '<b>T1–T3</b> (' + tt(1, 3) + '). Play a land every turn (T3 drop made in ' + pct(row(3).pDrop) + ' of games). Spend mana on ramp first: ' + list(rampEarly, 10) + '.' + (rampMid.length ? ' 3–4 MV ramp: ' + list(rampMid, 6) + '.' : ''),
      '<b>T4–T6</b> (' + tt(4, 6) + '). ' + (cmds.length ? 'Commander out by T6 in ' + pct(pCmdBy(6)) + ' of games. ' : '') + 'Deploy draw engines while the table is developing: ' + list(X.cards.engines, 8) + '. A draw source is seen ' + firstTurn('draw', 0.8) + ' in 80% of games (' + (sim.roleN.draw || 0) + ' in the deck).',
      '<b>T7+</b> (' + tt(7, Math.min(10, pt.length)) + '). Close with: ' + list(X.threat.wincons, 8) + '. A win condition is seen ' + firstTurn('wincon', 0.8) + ' in 80% of games' + (X.cards.tutors.length ? '; tutors to find it: ' + list(X.cards.tutors, 6) : '') + '.',
      combos.length ? '<b>Combos</b> (Spellbook): ' + combos.map(c => esc(c.cards.join(' + ')) + ' (' + c.outcome + (c.turn != null ? ', ≈T' + c.turn : '') + ')').join('; ') + '.' : ''
    ]);
    const inter = li([
      'Targeted removal ' + X.interaction.removal + ', instant-speed ' + X.interaction.instantInteraction.length + ', MV ≤ 2 ' + X.interaction.cheapInteraction.length + '. Hold instant-speed answers for threats you cannot otherwise beat: ' + list(X.interaction.instantInteraction, 8) + '.',
      wipes.length ? 'Board wipes (' + wipes.length + '): ' + (wOne.length ? 'one-sided, use freely: ' + list(wOne) + '. ' : '') + (wSym.length ? 'Symmetric, which also hit your ' + X.threat.creatures + ' creatures: ' + list(wSym) + '. These cost you least when opponents have more on board than you.' : '') : 'No board wipes: recover from opposing boards with spot removal only.',
      'Protection (' + X.resilience.protection.length + '): ' + list(X.resilience.protection, 8) + '.' + (X.resilience.cmdProtect.length ? ' Keeps the commander alive: ' + list(X.resilience.cmdProtect, 6) + '. Leave mana up for these when the commander is your engine.' : ''),
      X.resilience.recursion.length ? 'Recursion (' + X.resilience.recursion.length + '): ' + list(X.resilience.recursion, 8) + '.' : ''
    ]);
    const key = X.synergy.perCard.filter(x => x.links >= 3).slice(0, 10);
    const keySec = key.length ? sec('Key synergy pieces', '<p>Cards linked to the most other cards in the list (commander and theme links). Protect these and prioritise them in tutor targets.</p>' + li(key.map(x => '<b>' + esc(x.c.n) + '</b>: ' + x.links + ' links (' + esc(x.why.slice(0, 3).join(', ')) + ')'))) : '';
    const weak = li(vec.slice(0, 2).map(v => esc(v.label) + ' ' + v.score + '/100 is the weakest power axis.').concat([X.overall < 70 ? 'Fundamentals ' + X.overall + '/100: see Analysis → Overview for swaps.' : '']));
    const feel = tableFeel(R), has = feel.filter(r => r[3].length), none = feel.filter(r => !r[3].length && r[2]), q = quickStats();
    const orList = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1];
    const talk = '<p><b>Say before the game:</b> Bracket ' + R.settings.bracket + ' (' + esc(Engine.BRACKETS[R.settings.bracket].name) + ')' + (q && q.minB > R.settings.bracket ? ', though the cards play like Bracket ' + q.minB : '') + (q ? '; typical goldfish win T' + q.win : '') + '. ' +
      (has.length ? 'Runs ' + has.map(r => r[3].length + ' ' + (r[3].length === 1 ? r[0] : r[1])).join(', ') + '.' : '') + (none.length ? ' No ' + orList(none.map(r => r[2])) + '.' : '') + '</p>' +
      (has.length ? li(has.map(r => esc(r[1].charAt(0).toUpperCase() + r[1].slice(1)) + ': ' + r[3].slice(0, 12).map(n => n.includes(' + ') ? esc(n) : nameLink(n)).join(', ') + (r[3].length > 12 ? ' and ' + (r[3].length - 12) + ' more' : ''))) : '');
    const T = tokensNeeded(R.commanders.concat(R.deck.map(e => e.c))), tl = arr => li(arr.map(t => '<b>' + esc(t.label) + '</b> <span class="note">from ' + t.from.slice(0, 4).map(nameLink).join(', ') + (t.from.length > 4 ? ' +' + (t.from.length - 4) : '') + '</span>'));
    const tokSec = T.tokens.length || T.markers.length ? sec('Tokens, emblems and counters to bring', (T.tokens.length ? '<h4>Tokens</h4>' + tl(T.tokens) : '') + (T.markers.length ? '<h4>Markers and counters</h4>' + tl(T.markers) : '') + '<p class="note">Read from rules text with reminder text removed; check unusual wording on the card.</p>') : '';
    $('view').innerHTML = '<div class="row noprint" style="justify-content:flex-end;gap:8px;margin-bottom:10px"><button type="button" class="small" data-print="primer">Print primer and list</button><button type="button" class="small" data-print="proxies">Print proxies</button></div>' +
      '<div class="primer-wrap">' + sec('Table talk', talk) + sec('Game plan', plan) + (cmdSec || '') + sec('Mulligan', mull) + sec('Turn by turn', turns) + sec('Interaction and protection', inter) + keySec + tokSec + sec('Weak spots', weak) + '</div>' +
      '<p class="note">Every number is from this deck: ' + sim.games.toLocaleString() + ' seeded goldfish games on the play (no opponents), exact hypergeometric odds, and the rules-text role tags shown on the Deck tab. Win turns are goldfish estimates and run later against interaction.</p>';
  }

  /* ---------- combos page: Commander Spellbook data loaded from the site (no API) ---------- */
  const BT = { R: 'Ruthless', S: 'Spicy', P: 'Powerful', O: 'Oddball', C: 'Core', E: 'Exhibition', B: 'Banned' };
  const sbLink = v => 'https://commanderspellbook.com/combo/' + encodeURIComponent(v.id) + '/';
  function comboRows(list, opts) {
    opts = opts || {}; const R = App.R, inDeck = R ? new Set(R.commanders.map(c => c.n).concat(R.deck.map(e => e.c.n))) : new Set();
    const CI = R && R.stats ? R.CI : null;
    const canAdd = (n, c) => CI != null && !inDeck.has(n) && c && c.leg === 'legal' && [...c.ci].every(x => CI.includes(x));
    // a 2-card infinite the bracket does not allow (limit already reached) can't be added without breaking validation
    const lim2 = R && R.lim ? R.lim.combo2 : 999, two = R ? (R.combos || []).filter(x => x.inf && x.c.length <= 2).length : 0;
    const barred = v => v.inf && v.c.length <= 2 && two >= lim2;
    const cardHTML = v => v.c.map(n => { const miss = opts.missing && opts.missing.includes(n), c = App.bulk && Engine.lookup(App.bulk, n);
      return '<span class="cbcard"><span class="' + (miss ? 'pup' : inDeck.has(n) ? '' : 'note') + '">' + (c ? cardLink(c, n) : esc(n)) + '</span>' + (v.cmd.includes(n) ? ' <span class="chip">commander</span>' : '') + (!inDeck.has(n) && c ? ' <span class="note">' + fmtP(c.p[(R ? R.settings : App.S).budget.cur]) + '</span>' : '') +
        (canAdd(n, c) && !v.cmd.includes(n) && barred(v) ? ' <span class="chip" title="Bracket ' + R.settings.bracket + ' allows ' + lim2 + ' two-card infinite combo' + (lim2 === 1 ? '' : 's') + '. Raise the bracket under Start to add it.">not allowed at B' + R.settings.bracket + '</span>' : '') +
        (canAdd(n, c) && !v.cmd.includes(n) && !barred(v) && v.c.filter(x => !inDeck.has(x)).length === 1 ? ' <button type="button" class="small addbtn" data-cbadd="' + esc(n) + '" data-vid="' + esc(v.id) + '" title="Add ' + esc(n) + ' to the deck">+ Add</button>' : '') + '</span>'; }).join(' <span class="note">+</span> ');
    const lacking = v => v.c.filter(n => !inDeck.has(n));
    const addAll = v => { const m = lacking(v); return m.length >= 2 && !barred(v) && !m.some(n => v.cmd.includes(n)) && m.every(n => canAdd(n, App.bulk && Engine.lookup(App.bulk, n))) ? '<div><button type="button" class="small addbtn" data-cbaddall="' + esc(v.id) + '" title="Add the ' + m.length + ' missing cards, each in place of a card the planner picks">+ Add ' + m.length + ' cards</button></div>' : ''; };
    return '<div class="scroll"><table class="t compact mrows"><thead><tr><th>Cards</th><th>Produces</th><th>Bracket tag</th><th class="n">MV</th><th class="n">Popularity</th><th></th></tr></thead><tbody>' +
      list.map(x => { const v = x.v || x; return '<tr data-vrow="' + esc(v.id) + '"><td class="m-full">' + cardHTML(v) + (v.t.length ? '<div class="note">Also needs: ' + esc(v.t.join(', ')) + '</div>' : '') + addAll(v) + '</td><td class="why m-full2">' + esc(v.p.join(', ')) + '</td><td>' + (v.bt ? '<span class="chip">' + esc(BT[v.bt] || v.bt) + '</span>' : '') + '</td><td class="n"' + (v.mv != null ? ' data-l="MV"' : '') + '>' + (v.mv != null ? v.mv : '') + '</td><td class="n"' + (v.pop != null ? ' data-l="Popularity"' : '') + '>' + (v.pop != null ? v.pop.toLocaleString() : '') + '</td><td class="nw"><a href="' + sbLink(v) + '" target="_blank" rel="noopener">Steps ↗</a></td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  // analysis of the current deck for the swap planner: imported cards may be cut, cards the user locked may not
  function plannerX() {
    const R = App.R; if (!R || !R.stats || !App.bulk) return null;
    const key = deckKey(R) + '|' + JSON.stringify(R.settings.targets) + R.settings.bracket + '|' + [...(App.denied || [])].join(',') + '|' + ownKey();
    if (App.PX && App.PX.key === key) return App.PX.X;
    const deck = R.deck.map(e => e.imp ? Object.assign({}, e, { locked: false }) : e);
    const X = Analysis.run(App.bulk, deck, R.commanders, { settings: R.settings, combos: R.combos, games: 1500, deny: [...(App.denied || [])], owned: ownOpt() });
    App.PX = { key, X, deck }; return X;
  }
  // Add a combo's missing card(s): each goes in place of the card the planner picks (Analysis.pairCuts: lowest value,
  // keeps every role at target, never a piece of this or another combo in the deck, never a card you locked). Each cut
  // can be changed. The whole change is checked first (budget, bracket, Game Changers, 2-card infinites) and applied locked.
  function comboAddPanel(btn) {
    const R = App.R, cb = App.bulkCombos; if (!R || !cb) return;
    document.querySelectorAll('tr.cbpanel').forEach(x => x.remove());
    const v = cb.variants.find(x => x.id === btn.dataset.vid || x.id === btn.dataset.cbaddall); if (!v && !btn.dataset.cbadd) return;
    const inDeck = new Set(R.commanders.map(c => c.n).concat(R.deck.map(e => e.c.n)));
    const names = btn.dataset.cbadd ? [btn.dataset.cbadd] : v.c.filter(n => !inDeck.has(n));
    const cards = names.map(n => Engine.lookup(App.bulk, n)); if (cards.some(c => !c)) return;
    const keep = new Set((v ? v.c : []).concat(...(R.combos || []).map(x => x.c), R.commanders.map(c => c.n), R.deck.filter(e => e.inc).map(e => e.c.n)));
    const X = plannerX(), plan = X ? Analysis.pairCuts(X.planner, cards, keep) : cards.map(add => ({ add, cut: null, alts: [] }));
    const cur = R.settings.budget.cur, pr = c => c.p[cur] || 0, cap = R.settings.budget.total, hasCap = cap != null && cap !== '';
    const roles = c => Object.keys(Engine.analyze(c).roles).map(r => Engine.SLOT_LABEL[r]).join(', ');
    const opt = (c, sel) => '<option value="' + esc(c.n) + '"' + (sel ? ' selected' : '') + '>' + esc(c.n) + ' · ' + fmtP(pr(c)) + (roles(c) ? ' · ' + esc(roles(c)) : '') + '</option>';
    const tr = document.createElement('tr'); tr.className = 'cbpanel alt';
    tr.innerHTML = '<td colspan="6">' + plan.map((p, i) => '<label class="f" style="margin-bottom:6px"><span>Add <b>' + esc(p.add.n) + '</b> (' + fmtP(pr(p.add)) + ') in place of</span><select data-cbcut="' + i + '">' + (p.alts.length ? p.alts.map(c => opt(c, c === p.cut)).join('') : '<option value="">nothing to cut</option>') + '</select></label>').join('') +
      '<div class="row" style="gap:10px"><button type="button" class="primary small" data-cbgo="1">' + (plan.length > 1 ? 'Add ' + plan.length + ' and lock' : 'Add and lock') + '</button><button type="button" class="small" data-cbx="1">Cancel</button></div><div class="note" id="cbChk" style="margin-top:6px"></div>' +
      '<p class="note">Suggested cut: the lowest-value card that keeps every role at its target (value = synergy links + 2×roles + Game Changer/fast/tutor bonus + EDHREC popularity); pieces of combos already in the deck are never suggested.</p></td>';
    (btn.closest('tr') || btn).after(tr);
    const go = tr.querySelector('button[data-cbgo]');
    const pairs = () => plan.map((p, i) => ({ entry: R.deck.find(e => e.c.n === tr.querySelector('[data-cbcut="' + i + '"]').value), card: p.add }));
    App.cbPending = { pairs, tr };
    const check = () => {
      const ps = pairs();
      if (ps.some(p => !p.entry) || new Set(ps.map(p => p.entry)).size < ps.length) { go.disabled = true; $('cbChk').innerHTML = '<b class="pup">Pick a different card to cut for each card added.</b>'; return; }
      const after = R.stats.total + ps.reduce((s, p) => s + pr(p.card) - pr(p.entry.c), 0);
      const msgs = ['Adds ' + fmtP(ps.reduce((s, p) => s + pr(p.card), 0)) + '; deck price after: ' + fmtP(after) + (hasCap ? ' of ' + fmtP(+cap) + (after > +cap + 1e-9 ? ' <b class="pup">(over budget)</b>' : '') : '') + '.'];
      const lost = [...new Set([].concat(...ps.map(p => Object.keys(Engine.analyze(p.entry.c).roles).filter(r => !ps.some(q => Engine.analyze(q.card).roles[r])))))];
      if (lost.length) msgs.push('Removes a ' + lost.map(r => Engine.SLOT_LABEL[r].toLowerCase()).join(', ') + ' card.');
      $('cbChk').innerHTML = msgs.join(' '); go.disabled = true;
      R.replaceMany(ps, true).then(fails => {
        if (!tr.isConnected) return;
        go.disabled = !!(fails && fails.length);
        if (fails && fails.length) $('cbChk').innerHTML = '<b class="pup">Can\'t add: this breaks ' + fails.map(r => esc(r.label) + ' (' + esc(r.detail) + ')').join('; ') + '.</b> ' + (fails.some(r => r.id === 'bracket') ? 'Raise the bracket on Start, or pick a different combo. ' : fails.some(r => r.id === 'budget') ? 'Raise the budget, or cut a pricier card. ' : '') + msgs.join(' ');
      });
    };
    if (plan.some(p => !p.alts.length)) { $('cbChk').textContent = 'Every nonland card is part of a combo, locked or an include, so there is nothing to cut.'; go.disabled = true; return; }
    tr.querySelectorAll('[data-cbcut]').forEach(s => s.addEventListener('change', check)); check();
  }
  async function comboAddGo() {
    const R = App.R, P = App.cbPending; if (!R || !P) return;
    const ps = P.pairs(); if (ps.some(p => !p.entry)) return;
    const fails = await R.replaceMany(ps, true);
    if (fails && fails.length) { setStatus('Not added: this would break ' + fails.map(r => r.label).join(', ') + '.'); return; }
    const done = ps.map(p => ({ cut: p.entry.c.n, add: p.card.n }));
    await R.replaceMany(ps);
    for (const d of done) histOp({ op: 'replace', cut: d.cut, add: d.add, locked: true });
    App.QS = null; App.PR = null; App.cbPending = null; if (App.anSource !== 'paste') App.AN = null;
    renderAll(); histPush('edit', done.map(d => d.cut + ' → ' + d.add).join(', ') + ' (combo)');
    setStatus('Added ' + done.map(d => d.add + ' in place of ' + d.cut).join('; ') + ' (locked).' + (R.ok ? '' : ' Validation now reports a failed rule.'));
  }
  /* ---------- budget upgrades: Analysis.upgradePlan on the current deck ---------- */
  const UP_PRESETS = [20, 50, 200];
  function renderUpgrade() {
    const R = App.R;
    if (!R || !R.stats) { $('view').innerHTML = emptyView(); return; }
    const U = App.UP && App.UP.key === deckKey(R) ? App.UP : null, amt = App.upAmt || 50;
    const form = '<div class="row" style="gap:8px;align-items:flex-end"><div class="seg" role="group" aria-label="Amount">' + UP_PRESETS.map(v => '<button type="button" data-up="amt" data-v="' + v + '" aria-pressed="' + (amt === v) + '">' + esc(fmtP(v).replace(/\.00$/, '')) + '</button>').join('') + '</div>' +
      '<label class="f inline">Other <input type="number" id="upAmt" min="1" step="1" style="width:90px" value="' + (UP_PRESETS.includes(amt) ? '' : amt) + '"></label><button type="button" class="primary small" data-up="run"' + (App.upBusy ? ' disabled' : '') + '>Find upgrades</button><span class="note" id="upNote">' + esc(App.upNote || '') + '</span></div>';
    let body = '';
    if (U && U.res) {
      const r = U.res, w = r.whole, sign = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d || 0);
      const live = r.swaps.filter(x => !x.done);
      body = !r.swaps.length ? '<p class="note">No swap within ' + esc(fmtP(r.budget)) + ' measured better than the current list (' + r.measured + ' simulations of ' + r.candidates + ' candidate cards).</p>' :
        '<div class="an-top"><h3>' + r.swaps.length + ' swap' + (r.swaps.length === 1 ? '' : 's') + ', ' + esc(fmtP(r.spent)) + ' of ' + esc(fmtP(r.budget)) + '</h3>' + (live.length ? '<button type="button" class="small primary" data-up="apply-all">Apply all (' + live.length + ')</button>' : '') + '<button type="button" class="small" data-up="copy">Copy buy list</button><span class="note" id="upCopyNote"></span></div>' +
        (w ? '<p class="note">All together, measured: power ' + sign(w.pl, 1) + ', fundamentals ' + sign(w.fund) + ', keepable 7 ' + sign(w.keep * 100, 1) + ' pts' + (w.typical ? ', typical win turn ' + sign(w.typical) : '') + (w.minB ? ', <span class="warn-t">min. bracket ' + sign(w.minB) + '</span>' : '') + '.</p>' : '') +
        '<div class="scroll"><table class="t compact swaps"><thead><tr><th>Change</th><th class="n">Price</th><th class="n">Gain</th><th></th></tr></thead><tbody>' +
        r.swaps.map((x, i) => '<tr><td><div class="sw"><span class="out">− ' + nameLink(x.cut.n) + '</span><span class="in">+ ' + nameLink(x.add.n) + '</span></div></td><td class="n nw">' + esc(fmtP(x.price)) + '</td><td class="n">' + x.g.toFixed(1) + '</td><td class="nw">' + (x.done ? '<span class="note">applied</span>' : '<button type="button" class="small" data-up="apply" data-i="' + i + '">Apply</button>') + '</td></tr>').join('') + '</tbody></table></div>';
    }
    $('view').innerHTML = form + '<div style="margin-top:12px">' + body + '</div>' +
      '<details class="an-more"><summary class="note">How upgrades are chosen</summary><p class="note">Candidates: for each role, the cards that fit the deck best (theme fit and EDHREC rank, as on Suggested swaps), cards for the two weakest power vectors, the most played cards overall and, in decks of two or more colours, the 12 most played lands that make two of your colours. All are Commander-legal, inside your colour identity and bracket limits, and cost no more than the amount. Cuts: the 12 lowest-value nonland cards whose removal keeps every role at target (never a card you locked, a combo piece or the commander); lands replace a basic of your most over-supplied colour. Each candidate is measured with ' + (3000).toLocaleString() + ' simulated games on the same shuffles as the current list. Gain = 10 × power level change + fundamentals change. The chosen set is the one with the highest total gain whose adds fit the amount; a swap must gain at least 0.5 to be included, and each dollar costs 0.002, so equal gains go to the cheaper card. Prices are Scryfall\'s lowest ' + esc(R.settings.budget.cur.toUpperCase()) + ' print price.</p></details>';
  }
  async function upgradeRun() {
    const R = App.R; if (!R || !R.stats || App.upBusy) return;
    const inp = $('upAmt') && +$('upAmt').value; if (inp > 0) App.upAmt = inp;
    const amt = App.upAmt || 50, key = deckKey(R);
    const X = plannerX(); if (!X) return;
    const say = t => { App.upNote = t; if ($('upNote')) $('upNote').textContent = t; };
    App.upBusy = true; App.UP = null; renderUpgrade(); say('Measuring…');
    try {
      const keep = new Set([].concat(...(R.combos || []).map(x => x.c), R.commanders.map(c => c.n), R.deck.filter(e => e.inc).map(e => e.c.n)));
      const prep = Analysis.impactPrep(App.bulk, App.PX.deck, R.commanders, { settings: R.settings, combos: R.combos, impactGames: 3000 });
      const res = await Analysis.upgradePlan(prep, X.planner, amt, { keep, tick: (d, t) => { say('Measuring ' + d + '/' + t + '…'); return new Promise(r => setTimeout(r, 0)); } });
      if (deckKey(App.R) !== key) { say('The deck changed; run it again.'); return; }
      App.UP = { key, res }; say('');
    } finally { App.upBusy = false; if (App.tab === 'upgrade') renderUpgrade(); }
  }
  async function upgradeApply(list) {
    const R = App.R; if (!R || !App.UP) return;
    const pairs = list.map(x => ({ x, entry: R.deck.find(e => e.c === x.cut), card: x.add })).filter(p => p.entry && !R.deck.some(e => e.c === p.card));
    if (!pairs.length) return;
    const fails = await R.replaceMany(pairs, true);
    if (fails.length) { setStatus('Not applied: this would break ' + fails.map(r => r.label + ' (' + r.detail + ')').join('; ') + '.'); return; }
    await R.replaceMany(pairs);
    for (const p of pairs) { histOp({ op: 'swap', cut: p.x.cut.n, add: p.x.add.n }); p.x.done = true; }
    App.UP.key = deckKey(R); App.QS = null; App.PR = null; if (App.anSource !== 'paste') App.AN = null;
    renderAll(); histPush('edit', 'Budget upgrades: ' + pairs.length + ' swap' + (pairs.length === 1 ? '' : 's'));
    setStatus('Applied ' + pairs.length + ' upgrade' + (pairs.length === 1 ? '' : 's') + ' (locked). Deck, Export lists the added cards.');
  }
  /* ---------- by category: Analysis.catPlan for one count category, adds and cuts chosen together ---------- */
  // App.CT: { key, cat, res, sel: Set of add names, cutOv: { add name → cut name }, whole }
  const ctKeep = R => new Set([].concat(...(R.combos || []).map(x => x.c), R.commanders.map(c => c.n), R.deck.filter(e => e.inc).map(e => e.c.n)));
  // the package: each selected add (in gain order) with the cut catCuts picks on the running counts, or the user's choice
  function ctPairs(X, T) {
    const R = App.R, adds = T.res.adds.filter(a => T.sel.has(a.c.n));
    const auto = Analysis.catCuts(X.planner, adds.map(a => a.c), T.cat, T.res.rng, ctKeep(R)), used = new Set();
    return adds.map((a, i) => {
      const s = auto[i], ov = T.cutOv[a.c.n] && R.deck.find(e => e.c.n === T.cutOv[a.c.n]);
      const opts = [s.cut].concat(s.alts).filter(Boolean); if (ov && !opts.includes(ov.c)) opts.unshift(ov.c);
      const cut = ov ? ov.c : s.cut, dup = cut && used.has(cut); if (cut) used.add(cut);
      return { a, add: a.c, cut, safe: s.safe, opts, dup };
    });
  }
  function ctAfter(T, pairs) {
    const n = Object.assign({}, T.res.counts);
    for (const p of pairs) { for (const k of Analysis.catsOf(p.add)) n[k]++; if (p.cut) for (const k of Analysis.catsOf(p.cut)) n[k]--; }
    return n;
  }
  function renderCats() {
    const R = App.R;
    if (!R || !R.stats) { $('view').innerHTML = emptyView(); return; }
    const X = plannerX(); if (!X) { $('view').innerHTML = emptyView(); return; }
    const key = deckKey(R), T = App.CT && App.CT.key === key ? App.CT : null;
    const rng = Analysis.catRange(R.settings.bracket, R.CI), cnt = Analysis.catCounts(X.planner.deck);
    const st = k => !rng[k] ? '' : cnt[k] < rng[k][0] ? 'fail' : cnt[k] > rng[k][2] ? 'warn' : 'pass';
    const tiles = '<div class="ct-tiles" role="group" aria-label="Category">' + Analysis.COUNT_CATS.filter(([k]) => rng[k]).map(([k, l]) => '<button type="button" class="ct-tile ' + st(k) + '" data-ct="pick" data-k="' + k + '" aria-pressed="' + !!(T && T.cat === k) + '"' + (App.ctBusy ? ' disabled' : '') + '><b>' + esc(l) + '</b><span><b>' + cnt[k] + '</b> · typical ' + fmtR(rng[k][0]) + '–' + fmtR(rng[k][2]) + '</span></button>').join('') + '</div>';
    let body = '<p class="note" id="ctNote">' + esc(App.ctNote || (T ? '' : 'Pick a category. Red is below the typical range for Bracket ' + (+R.settings.bracket || 'all') + ', amber above it.')) + '</p>';
    if (T && T.res) {
      const lab = Object.fromEntries(Analysis.COUNT_CATS.map(x => [x[0], x[1]])), r = T.res;
      if (!r.adds.length) body += '<p class="note">No card in ' + esc(lab[T.cat]) + ' to add' + (ownOnly() ? ' from your collection' : '') + ' within your colours, bracket and per-card price cap, or nothing left to cut without dropping another category below its range.</p>';
      else {
        const pairs = ctPairs(X, T), after = ctAfter(T, pairs);
        const addRows = r.adds.map(a => '<tr><td><label class="ct-chk"><input type="checkbox" data-ctadd="' + esc(a.c.n) + '"' + (T.sel.has(a.c.n) ? ' checked' : '') + '> ' + cardLink(a.c) + '</label>' + (a.cats.length > 1 ? '<div class="note">also ' + a.cats.filter(k => k !== T.cat).map(k => esc(lab[k])).join(', ') + '</div>' : '') + '<div class="note">measured against − ' + esc(a.cut.n) + '</div></td><td class="n nw">' + (a.price != null ? esc(fmtP(a.price)) : '<span class="note">n/a</span>') + '</td><td class="n ' + (a.g > 0 ? 'up' : a.g < 0 ? 'down' : '') + '">' + (a.g > 0 ? '+' : '') + a.g.toFixed(1) + '</td></tr>').join('');
        const pairRows = pairs.map((p, i) => '<tr><td><div class="sw"><span class="in">+ ' + cardLink(p.add) + '</span></div></td><td><label class="f inline"><span class="sr">Cut</span><select data-ctcut="' + esc(p.add.n) + '">' + p.opts.map(c => '<option value="' + esc(c.n) + '"' + (c === p.cut ? ' selected' : '') + '>− ' + esc(c.n) + (Analysis.catsOf(c).length ? ' (' + Analysis.catsOf(c).map(k => lab[k]).join(', ') + ')' : '') + '</option>').join('') + '</select></label>' + (p.dup ? ' <b class="pup">cut twice</b>' : !p.safe ? ' <span class="warn-t">drops a category below range</span>' : '') + '</td></tr>').join('');
        const cRows = Analysis.COUNT_CATS.filter(([k]) => rng[k]).map(([k, l]) => { const a = cnt[k], b = after[k], low = b < rng[k][0], hi = b > rng[k][2]; return a === b && k !== T.cat ? '' : '<tr><td>' + esc(l) + '</td><td class="n num">' + a + ' → <b>' + b + '</b></td><td class="n num">' + fmtR(rng[k][0]) + '–' + fmtR(rng[k][2]) + '</td><td><span class="st ' + (low ? 'fail' : hi ? 'warn' : 'pass') + '">' + (low ? 'Low' : hi ? 'High' : 'Typical') + '</span></td></tr>'; }).join('');
        const sign = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d || 0), w = T.whole;
        const bad = pairs.some(p => !p.cut || p.dup);
        body += '<h3 class="an-sub">Cards to add for ' + esc(lab[T.cat]) + ' (' + r.adds.length + ' measured)</h3><p class="note">Gain = the swap alone, against the cut shown (10 × power level change + fundamentals change, 3,000 simulated games on the same shuffles). Tick the ones you want; the cuts below are re-chosen for the whole set.</p>' +
          '<div class="scroll"><table class="t compact"><thead><tr><th>Add</th><th class="n">Price</th><th class="n">Gain</th></tr></thead><tbody>' + addRows + '</tbody></table></div>' +
          (pairs.length ? '<h3 class="an-sub">Package (' + pairs.length + ' swap' + (pairs.length === 1 ? '' : 's') + ')</h3><div class="scroll"><table class="t compact swaps ct-pkg"><tbody>' + pairRows + '</tbody></table></div>' +
            '<h4 class="an-sub">Counts after</h4><div class="scroll"><table class="t compact"><thead><tr><th>Category</th><th class="n">Now → after</th><th class="n">Typical</th><th></th></tr></thead><tbody>' + cRows + '</tbody></table></div>' +
            (w ? '<p class="note">All ' + w.n + ' together, measured: power ' + sign(w.pl, 1) + ', fundamentals ' + sign(w.fund) + ', keepable 7 ' + sign(w.keep * 100, 1) + ' pts' + (w.typical ? ', typical win turn ' + sign(w.typical) : '') + (w.minB ? ', <span class="warn-t">min. bracket ' + sign(w.minB) + '</span>' : '') + '.</p>' : '') +
            '<div class="row" style="gap:8px"><button type="button" class="small" data-ct="measure"' + (bad || App.ctBusy ? ' disabled' : '') + '>Measure together</button><button type="button" class="small primary" data-ct="apply"' + (bad || App.ctBusy ? ' disabled' : '') + '>Apply ' + pairs.length + '</button></div>' : '<p class="note">Tick a card above to build a package.</p>');
      }
    }
    $('view').innerHTML = tiles + body + '<details class="an-more"><summary class="note">How category swaps are chosen</summary><p class="note">Counts and typical ranges are the ones on Deck › Counts (middle half of reference decks of your bracket). Adds: the cards in the category that fit the deck best (theme fit and EDHREC rank), Commander-legal, in your colours, inside bracket limits and the per-card price cap' + (ownOnly() ? ', from your collection' : '') + '. Cuts are chosen one after another on the running counts, after counting every add: a card is cut only if each category it is in stays at or above the low end of its range; cards from over-supplied categories go first, then the lowest-value card (synergy links + 2×roles + Game Changer/fast/tutor bonus + EDHREC popularity). A card in the category being filled, a locked card, a combo piece and the commander are never cut; a basic land only while lands are above their range.</p></details>';
  }
  async function catsRun(cat) {
    const R = App.R; if (!R || !R.stats || App.ctBusy) return;
    const X = plannerX(); if (!X) return; const key = deckKey(R);
    const say = t => { App.ctNote = t; if ($('ctNote')) $('ctNote').textContent = t; };
    App.ctBusy = true; App.CT = { key, cat, res: null, sel: new Set(), cutOv: {} }; renderCats(); say('Measuring…');
    try {
      const prep = Analysis.impactPrep(App.bulk, App.PX.deck, R.commanders, { settings: R.settings, combos: R.combos, impactGames: 3000 });
      const res = await Analysis.catPlan(prep, X.planner, cat, { bracket: R.settings.bracket, keep: ctKeep(R), tick: (d, t) => { say('Measuring ' + d + '/' + t + '…'); return new Promise(r => setTimeout(r, 0)); } });
      if (deckKey(App.R) !== key) { say('The deck changed; pick the category again.'); return; }
      // preselected: the best gains, as many as it takes to reach the median (1 to 5)
      const m = res.rng[cat] ? res.rng[cat][1] : res.counts[cat] + 1, need = Math.max(1, Math.min(5, Math.ceil(m - res.counts[cat])));
      App.CT = { key, cat, res, sel: new Set(res.adds.filter(a => a.g > 0).slice(0, need).map(a => a.c.n)), cutOv: {}, prep }; say('');
    } finally { App.ctBusy = false; if (App.tab === 'cats') renderCats(); }
  }
  function catsMeasure() {
    const T = App.CT, X = plannerX(); if (!T || !T.res || !X) return;
    const pairs = ctPairs(X, T).filter(p => p.cut); if (!pairs.length) return;
    const w = Analysis.impactMany(T.prep, pairs.map(p => ({ cut: p.cut, add: p.add })));
    T.whole = Object.assign(w, { n: pairs.length }); renderCats();
  }
  async function catsApply() {
    const R = App.R, T = App.CT, X = plannerX(); if (!R || !T || !T.res || !X) return;
    const ps = ctPairs(X, T); if (ps.some(p => !p.cut || p.dup)) return;
    const pairs = ps.map(p => ({ entry: R.deck.find(e => e.c === p.cut), card: p.add })).filter(p => p.entry && !R.deck.some(e => e.c === p.card));
    if (!pairs.length) return;
    const fails = await R.replaceMany(pairs, true);
    if (fails.length) { setStatus('Not applied: this would break ' + fails.map(r => r.label + ' (' + r.detail + ')').join('; ') + '.'); return; }
    await R.replaceMany(pairs);
    for (const p of pairs) histOp({ op: 'swap', cut: p.entry.c.n, add: p.card.n });
    const lab = (Analysis.COUNT_CATS.find(x => x[0] === T.cat) || [])[1];
    App.CT = null; App.QS = null; App.PR = null; if (App.anSource !== 'paste') App.AN = null;
    renderAll(); histPush('edit', lab + ': ' + pairs.length + ' swap' + (pairs.length === 1 ? '' : 's'));
    setStatus('Applied ' + pairs.length + ' ' + lab + ' swap' + (pairs.length === 1 ? '' : 's') + ': ' + pairs.map(p => p.card.n + ' for ' + p.entry.c.n).join('; ') + '.');
  }
  // cards in the deck now that weren't in it when it was generated or imported (App.base), as "1 Card Name" lines
  function addedCards() {
    const R = App.R; if (!R || !App.base) return [];
    const was = new Map(App.base), out = [];
    for (const e of R.deck) { const d = e.qty - (was.get(e.c.n) || 0); if (d > 0) out.push({ c: e.c, qty: d }); }
    return out.sort((a, b) => a.c.n < b.c.n ? -1 : 1);
  }
  const buyList = list => list.map(x => (x.qty || 1) + ' ' + (x.c || x.add).n).join('\n');

  async function renderCombos() {
    const cb = App.bulkCombos, R = App.R;
    if (!cb) { $('view').innerHTML = '<div class="empty"><h2>' + (App.combosLoading ? 'Loading combos…' : 'No combo data') + '</h2><p>Combos come from Commander Spellbook files in the site\'s <code>data/spellbook/</code> folder, refreshed weekly by the repository\'s Data files workflow. The single-file version has no data folder, so combos are only available on the site.</p></div>'; return; }
    const ciOf = () => R ? R.CI : (App.S.commanders || []).map(n => n && App.bulk && Engine.lookup(App.bulk, n)).filter(Boolean).map(c => c.ci).join('');
    let h = '<p class="note">' + cb.count.toLocaleString() + ' combos from Commander Spellbook (' + esc((cb.meta.timestamp || '').slice(0, 10)) + '), read from this site. "Steps" opens the combo on commanderspellbook.com.</p>';
    if (R && R.stats) {
      const names = R.commanders.map(c => c.n).concat(R.deck.map(e => e.c.n)), cmds = R.commanders.map(c => c.n);
      const found = (await cb.find(names, cmds)).sort((a, b) => (b.pop || 0) - (a.pop || 0));
      const CI = R.CI, inCI = c => [...c.ci].every(x => CI.includes(x)), have = new Set(names);
      const own = ownOpt(), pool = n => { if (have.has(n)) return false; const c = Engine.lookup(App.bulk, n); return !!c && c.leg === 'legal' && inCI(c) && (!own || own.has(c.n) || Engine.isBasic(c)); };
      // combos the bracket allows come first; 2-card infinites over the bracket limit go last
      const lim2 = R.lim ? R.lim.combo2 : 999, two = (R.combos || []).filter(x => x.inf && x.c.length <= 2).length, barredNow = v => v.inf && v.c.length <= 2 && two >= lim2 ? 1 : 0;
      const near = (await cb.almost(names, pool, 2)).filter(x => !x.v.cmd.length || x.v.cmd.every(n => cmds.includes(n))).sort((a, b) => barredNow(a.v) - barredNow(b.v) || a.missing.length - b.missing.length || (b.v.pop || 0) - (a.v.pop || 0)).slice(0, 40);
      h += '<h3 class="an-sec">In this deck (' + found.length + ')</h3>' + (found.length ? comboRows(found) : '<p class="note">No complete Spellbook combo in this list.' + (R.settings.bracket <= 2 ? ' Brackets 1–2 exclude 2-card infinite combos.' : '') + '</p>');
      h += '<h3 class="an-sec">One or two cards away' + (own ? ' with your collection' : '') + ' (' + near.length + (near.length === 40 ? '+' : '') + ')</h3>' + (near.length ? '<p class="note">Missing cards are in red with their price. + Add puts them in the deck, each in place of a suggested cut you can change, and locks them.</p>' + comboRows(near.map(x => ({ v: x.v })), { missing: [].concat(...near.map(x => x.missing)) }) : '<p class="note">None.</p>');
    }
    const ci = ciOf();
    h += '<h3 class="an-sec">Search all combos</h3><div class="row" style="gap:10px;align-items:flex-end"><label class="f" style="flex:1 1 260px">Cards or results (all words must match)<input type="search" id="cbQ" placeholder="e.g. Thassa\'s Oracle, infinite mana" value="' + esc(App.cbQ || '') + '"></label>' +
      '<label class="f" style="width:130px">Cards in combo<select id="cbN"><option value="">Any</option><option value="2">2</option><option value="3">3</option><option value="4">4+</option></select></label>' +
      '<label class="c"><input type="checkbox" id="cbCI"' + (ci ? ' checked' : ' disabled') + '> Commander colours' + (ci ? ' (' + pipsHTML(ci) + ')' : '') + '</label><label class="c"><input type="checkbox" id="cbInf"> Infinite only</label></div><div id="cbRes" style="margin-top:10px"></div>';
    $('view').innerHTML = h;
    if (App.cbN) $('cbN').value = App.cbN;
    const run = () => {
      const q = ($('cbQ').value || '').toLowerCase().split(/[,\s]+/).filter(Boolean), n = $('cbN').value, useCI = $('cbCI').checked && ci, inf = $('cbInf').checked;
      App.cbQ = $('cbQ').value; App.cbN = n;
      if (!cb.hay) cb.hay = cb.variants.map(v => (v.c.join(' | ') + ' || ' + v.p.join(' | ') + ' || ' + v.t.join(' | ')).toLowerCase());
      const out = []; let total = 0;
      for (let i = 0; i < cb.variants.length; i++) {
        const v = cb.variants[i];
        if (n && (n === '4' ? v.c.length < 4 : v.c.length !== +n)) continue;
        if (inf && !v.inf) continue;
        if (useCI && ![...(v.ci === 'C' ? '' : v.ci)].every(x => ci.includes(x))) continue;
        if (q.length && !q.every(w => cb.hay[i].includes(w))) continue;
        total++; out.push(v);
      }
      out.sort((a, b) => (b.pop || 0) - (a.pop || 0));
      $('cbRes').innerHTML = '<p class="note">' + total.toLocaleString() + ' match' + (total === 1 ? '' : 'es') + (total > 100 ? '; showing the 100 most popular' : '') + '.</p>' + (total ? comboRows(out.slice(0, 100)) : '');
    };
    let tm; $('cbQ').addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(run, 150); });
    for (const id of ['cbN', 'cbCI', 'cbInf']) $(id).addEventListener('change', run);
    run();
  }

  /* ---------- score bar: always-visible headline numbers for the current deck ---------- */
  const deckKey = R => R.commanders.map(c => c.n).join('+') + '|' + R.deck.map(e => e.qty + e.c.n).sort().join(',');
  function quickStats() {
    const R = App.R; if (!R || !R.stats || !App.bulk) return null;
    const key = deckKey(R);
    if (App.QS && App.QS.key === key) return App.QS;
    const full = App.AN && !App.AN.error && !App.AN.compare && App.AN.inp && App.AN.label !== 'Pasted list' && deckKey({ commanders: App.AN.cmds, deck: App.AN.inp.deck }) === key ? App.AN : null;
    const X = full || Analysis.run(App.bulk, R.deck, R.commanders, { settings: R.settings, games: 4000 });
    App.QS = { key, pl: X.power.pl, plLabel: X.power.label, fund: X.overall, minB: X.power.minBracket, win: X.power.win.typical, winBest: X.power.win.best, winCont: X.power.win.contested, winSrc: X.power.win.source, winRange: X.power.win.range, arch: X.power.primary, score: R.deckScore ? R.deckScore() : null, games: X.sim.games, axes: X.axes.map(a => ({ label: a.label, score: a.score })) };
    return App.QS;
  }
  const KI = {
    power: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', fund: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', price: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v2M12 16v2"/>',
    bracket: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>', win: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', score: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    bal: '<path d="M12 3 20 9l-3 10H7L4 9z"/>'
  };
  function renderScorebar() {
    const el = $('kpis'), mini = $('scorebar'); const R = App.R;
    const off = () => { el.classList.add('hidden'); mini.classList.add('hidden'); };
    if (!R || !R.stats) return off();
    const q = quickStats(); if (!q) return off();
    const cap = R.settings.budget.total, cur = R.settings.budget.cur, total = R.stats.total;
    const hasCap = cap != null && cap !== '', over = hasCap && total > +cap + 1e-9, hi = q.minB > R.settings.bracket;
    const used = hasCap && +cap > 0 ? Math.min(1, total / +cap) : null;
    const K = [
      ['power', 'Power level', 'var(--i-violet)', q.pl.toFixed(1) + '<small> /10</small>', esc(q.plLabel || '')],
      ['price', 'Total price', 'var(--i-orange)', Engine.fmt(total, cur), hasCap ? (over ? 'over the ' : 'of ') + Engine.fmt(+cap, cur) + ' cap' + (used != null ? ' · ' + Math.round(total / +cap * 100) + '%' : '') : 'no budget cap', over ? 'bad' : '', used],
      ['bracket', 'Bracket', 'var(--i-blue)', 'B' + R.settings.bracket + '<small> ' + esc(Engine.BRACKETS[R.settings.bracket].name) + '</small>', hi ? 'cards play like B' + q.minB : 'cards fit B' + R.settings.bracket, hi ? 'warn' : ''],
      ['win', 'Win turn', 'var(--i-pink)', 'T' + q.win + (q.winRange ? '<small> T' + q.winRange[0] + '–' + q.winRange[1] + '</small>' : ''), q.winSrc === 'simulated combo' ? 'simulated combo' + (q.winRange ? ', middle half of games' : '') : 'from power level · best T' + q.winBest]
    ];
    const KO = ['power', 'bracket', 'win', 'price']; K.sort((a, b) => KO.indexOf(a[0]) - KO.indexOf(b[0]));
    el.innerHTML = K.map(([k, l, c, v, sub, cls, bar]) => '<div class="kpi' + (cls ? ' ' + cls : '') + '"><div class="kh"><span class="ki" style="background:' + c + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + KI[k] + '</svg></span><span class="kl">' + l + '</span></div><div class="kv2">' + v + '</div>' +
      (bar != null ? '<div class="kbar"><i style="width:' + (bar * 100).toFixed(1) + '%"></i></div>' : '') + '<div class="ks">' + sub + '</div></div>').join('');
    el.title = 'Power, bracket and win turn from ' + q.games.toLocaleString() + ' simulated games of the current list. Fundamentals and balance are on Analysis.';
    mini.innerHTML = [['Power', q.pl.toFixed(1)], ['Bracket', 'B' + R.settings.bracket + (hi ? ' (plays B' + q.minB + ')' : ''), hi ? 'warn' : ''], ['Win', 'T' + q.win], ['Price', Engine.fmt(total, cur) + (hasCap ? ' / ' + Engine.fmt(+cap, cur) : ''), over ? 'bad' : '']]
      .map(([k, v, c]) => '<div' + (c ? ' class="' + c + '"' : '') + '><span>' + k + '</span><b>' + v + '</b></div>').join('');
    el.classList.remove('hidden'); syncMini();
  }
  // compact copy of the KPI cards that pins to the top once the cards scroll out of view
  let kpiVisible = true;
  function syncMini() { $('scorebar').classList.toggle('hidden', $('kpis').classList.contains('hidden') || (document.body.dataset.page === 'analysis' && kpiVisible)); }
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { kpiVisible = es[0].isIntersecting; syncMini(); }, { rootMargin: '-60px 0px 0px 0px' }).observe($('kpis'));
  function renderAll() { renderSummary(); renderScorebar(); renderView(); $('regenBtn').disabled = !App.R || !App.R.stats || App.busy; syncActions(); }

  /* ---------- clipboard / files ---------- */
  async function copyText(text, ta, note) {
    try { await navigator.clipboard.writeText(text); if (note) note.textContent = 'Copied.'; }
    catch (e) { if (ta) { ta.focus(); ta.select(); } if (note) note.textContent = 'Clipboard blocked; text selected, press Ctrl/Cmd+C.'; }
  }
  async function saveFile(name, text, note) {
    try {
      const d = window.claude && typeof window.claude.use === 'function' ? await window.claude.use('downloads') : null;
      if (d) { await d.save({ filename: name, data: text }); if (note) note.textContent = 'Saved.'; return; }
    } catch (e) { if (note) note.textContent = e && e.code === 'declined' ? 'Save declined.' : 'Save unavailable here (' + (e && e.code || e) + '); use Copy.'; return; }
    try {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      if (note) note.textContent = 'Download started.';
    } catch (e) { if (note) note.textContent = 'Download blocked; use Copy.'; }
  }

  /* ---------- generation ---------- */
  async function getDB() {
    if (App.bulk) return App.bulk;
    throw new Error('No card data loaded. Load a Scryfall bulk JSON file under Start, Card data.');
  }
  async function runGenerate(opts) {
    if (App.busy) return;
    opts = opts || {};
    readForm();
    const S = JSON.parse(JSON.stringify(App.S)), prev = App.R && App.R.stats ? App.R : null; let built = false;
    App.busy = true; renderSources(); $('regenBtn').disabled = true; setProg(0.1); showMsgs([], []);
    const t0 = performance.now();
    try {
      setStatus('Scoring candidates…');
      const db = await getDB();
      setProg(0.6); setStatus('Scoring and filling slots…');
      await new Promise(r => setTimeout(r, 0));
      if (opts.imported) { S.include = ''; S.exclude = ''; } // the imported list is the deck, so include/exclude lists don't apply
      if (opts.fill) S.budget.total = null; // the kept cards may already be over the cap
      const env = { combos: comboProvider(), locks: opts.locks || [], bans: opts.bans || [], imported: !!opts.imported, asIs: !!opts.asIs };
      const R = await Engine.generate(db, S, env);
      R.dbMeta = db.meta;
      if (db.meta.warnings && db.meta.warnings.length) R.warnings = db.meta.warnings.concat(R.warnings);
      if (R.errors.length && prev && opts.locks) { showMsgs(R.errors, R.warnings); setStatus('Not rebuilt: the locked cards can\'t fit these settings (see above). The current deck is unchanged.'); }
      else if (R.errors.length) { App.R = null; showMsgs(R.errors, R.warnings); setStatus('Not generated.'); }
      else {
        App.R = R; built = true; App.openSwap = null; App.QS = null; App.base = R.deck.map(e => [e.c.n, e.qty]); App.UP = null; if (App.anSource !== 'paste') App.AN = null;
        if (App.tab === 'setup' && !App.restoring) { App.tab = 'analysis'; window.scrollTo({ top: 0 }); } // the next step after building is checking the deck
        if (!App.restoring) App.chain = { settings: S, env: { locks: env.locks, bans: env.bans, imported: env.imported, asIs: env.asIs }, ops: [] };
        showMsgs([], R.warnings, shortfallHTML(R));
        const O = R.optimize;
        setStatus('Generated in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s from ' + R.poolSize.toLocaleString() + ' candidates' + (O ? '; the optimiser made ' + O.swaps.length + ' swap' + (O.swaps.length === 1 ? '' : 's') + (O.timedOut ? ' before its time cap' : '') + '. Details: More, Build log.' : '.'));
      }
    } catch (e) { App.R = null; showMsgs([e.message || String(e)], []); setStatus('Error.'); console.error(e); }
    App.busy = false; setProg(null); renderSources(); renderAll();
    if (built && opts.onBuilt) opts.onBuilt(App.R);
    if (built && !App.restoring) histPush('generate', opts.asIs ? 'Imported deck' : opts.locks && opts.locks.length ? 'Rebuilt around ' + opts.locks.length + ' locked card(s)' : 'Generated');
    if ((App.tab === 'analysis' || App.tab === 'changes' || App.tab === 'percard') && App.anSource !== 'paste' && App.R && !opts.asIs) runAnalysis(); // an import runs its own
  }

  /* ---------- fill a short deck to 100: rebuild with every current card kept (locked), so the generator adds the
     missing cards from your settings (bracket, plan, themes, collection mode). The total budget cap is left out, since
     the kept cards alone may already be over it; the per-card cap still applies to the added cards. ---------- */
  const deckCount = R => R.commanders.length + R.deck.reduce((a, e) => a + e.qty, 0);
  const fillBtnHTML = () => App.R && App.R.stats && deckCount(App.R) < 100 ? ' <button type="button" class="small primary" data-fill="1" title="Keep every card and add the missing ones from your settings"' + (App.busy ? ' disabled' : '') + '>Fill to 100</button>' : '';
  async function fillDeck() {
    const R = App.R; if (!R || !R.stats || App.busy) return;
    const before = deckCount(R); if (before >= 100) return;
    const locks = R.deck.map(e => ({ name: e.c.n, slot: e.slot, qty: e.qty }));
    let built = null;
    await runGenerate({ locks, bans: R.bans || [], imported: !!(App.chain && App.chain.env && App.chain.env.imported), fill: true, onBuilt: x => { built = x; } });
    if (built) { const n = deckCount(built) - before; App.accepted = []; setStatus('Filled the deck: added ' + n + ' card' + (n === 1 ? '' : 's') + ' (' + deckCount(built) + ' total). Every card you had is kept and locked.'); }
  }

  /* ---------- import: a pasted list becomes the working deck exactly as pasted, every card locked ---------- */
  function renderImport() {
    $('view').innerHTML = '<label class="f">Decklist (Moxfield, Archidekt, MTGO or plain "1 Name"; the commander goes under a "Commander" or "// COMMANDER" header, or tagged [Commander])<textarea id="impText" rows="16" spellcheck="false" placeholder="// COMMANDER&#10;1 Galadriel, Light of Valinor (LTC) 498&#10;&#10;1 Arcane Signet (LTC) 273&#10;26 Forest (SOS) 280&#10;...">' + esc(App.impText || '') + '</textarea></label>' +
      '<div class="row" style="margin-top:8px"><button type="button" class="primary" id="impBtn">Import and analyze</button><span class="note" id="impNote">' + esc(App.impNote || '') + '</span></div>' +
      '<p class="note">The deck is kept exactly as pasted: nothing is added, removed or swapped, and budget, bracket and include/exclude settings are not applied. Analysis opens with its problems, role counts and a Measure swaps button; swaps can come from all cards or only your collection. Rule problems (card count, colour identity, budget) show under Rules on Deck.</p>';
  }
  async function importDeck() {
    const say = t => { App.impNote = t; if ($('impNote')) $('impNote').textContent = t; };
    if (!App.bulk) { say('Load the card data first (Start, Card data).'); return; }
    const P = Analysis.parseDecklist(App.impText || '');
    const K = Analysis.pickCommanders(P, App.bulk), unknown = K.missing.slice(), cmds = K.cmds;
    if (!cmds.length && App.impPick) { const c = Engine.lookup(App.bulk, App.impPick); if (c) { cmds.push(c); K.how = 'pick'; } }
    if (!cmds.length) {
      const cand = (K.candidates || []).slice(0, 12);
      App.impNote = ''; say('No commander found. Put it under a "Commander" header or tag it [Commander]' + (cand.length ? ', or pick one from the list:' : '.') + (unknown.length ? ' Not in the card data: ' + unknown.join('; ') + '.' : ''));
      if (cand.length && $('impNote')) $('impNote').insertAdjacentHTML('beforeend', ' ' + cand.map(c => '<button type="button" class="small" data-impcmd="' + esc(c.n) + '">' + esc(c.n) + '</button>').join(' '));
      return;
    }
    if (cmds.length > 2) { say('More than two commanders found: ' + cmds.map(c => c.n).join('; ') + '.'); return; }
    const locks = [];
    for (const it of K.main) {
      const c = Engine.lookup(App.bulk, it.name); if (!c) { unknown.push(it.name); continue; }
      if (cmds.includes(c)) continue;
      const ex = locks.find(l => l.name === c.n); if (ex) ex.qty += it.qty; else locks.push({ name: c.n, qty: it.qty });
    }
    if (!locks.length) { say('No cards found in the list.'); return; }
    readForm(); App.S.commanders = [cmds[0].n, cmds[1] ? cmds[1].n : '']; App.S.reroll = 0;
    writeForm(App.S); persistSettings();
    const n = locks.reduce((s, l) => s + l.qty, 0);
    say('Importing ' + n + ' cards…');
    let built = null;
    await runGenerate({ locks, bans: [], imported: true, asIs: true, onBuilt: R => { built = R; } });
    if (!built) { say('Not imported; see the messages above.'); return; }
    const kept = built.deck.reduce((s, e) => s + e.qty, 0), total = kept + built.commanders.length;
    const msg = 'Imported ' + kept + ' of ' + n + ' card' + (n === 1 ? '' : 's') + ' with ' + cmds.map(c => c.n).join(' + ') + (K.how !== 'section' && K.how !== 'pick' ? ' (read as the commander from the ' + K.how + ')' : '') + ' (' + total + ' total).' +
      (unknown.length ? ' Not in the card data (' + unknown.length + '): ' + unknown.slice(0, 8).join('; ') + (unknown.length > 8 ? ' …' : '') + '.' : '') +
      (kept < n ? ' ' + (n - kept) + ' rejected (see Notes).' : '') + (total < 100 ? ' ' + (100 - total) + ' short of 100: Fill to 100 on Analysis adds them.' : total !== 100 ? ' Not 100 cards; Rules on Deck lists it.' : '');
    say(msg); setStatus(msg);
    App.recsShown = false; App.accepted = []; App.acceptNote = ''; App.anSource = 'deck'; App.AN = null; App.tab = 'analysis'; renderView(); window.scrollTo({ top: 0 });
    runAnalysis();
  }

  /* ---------- acceptance tests (run against loaded data) ---------- */
  async function runTests() {
    if (App.busy) return;
    App.busy = true; renderSources(); App.tab = 'tests';
    const rows = [], add = (name, pass, detail) => { rows.push({ name, pass, detail }); App.tests = { rows, source: srcName, at: new Date().toLocaleString() }; renderView(); };
    let srcName = App.bulk ? 'Bulk file ' + (App.bulk.meta.file || 'stored') + (App.bulkCombos ? ' + Spellbook file' : '') : 'none';
    App.tests = { rows, source: srcName, at: new Date().toLocaleString() }; renderView();
    try {
      const idx = commanderIndex();
      const pick = choose(idx, idx.filter(c => Engine.cmdTraits(c).partner));
      const baseS = Object.assign(uiDefaults(), { seed: 'acceptance', variance: 0.15, bracket: 4, bl: Engine.bracketDefaults(4) });
      const gen = async (over, label) => {
        setStatus('Test: ' + label + '…');
        const S = deepAssign(JSON.parse(JSON.stringify(baseS)), over);
        const db = await getDB();
        const R = await Engine.generate(db, S, { combos: comboProvider() });
        return R;
      };
      const legal = R => {
        if (R.errors.length) return [false, R.errors.join(' ')];
        const n = R.commanders.length + R.deck.reduce((s, e) => s + e.qty, 0);
        const get = id => R.validation.rules.find(r => r.id === id);
        const bad = ['count', 'singleton', 'identity', 'legality'].filter(id => !get(id).pass);
        const outside = R.deck.filter(e => [...e.c.ci].some(x => !R.CI.includes(x))).length;
        const illegal = R.deck.filter(e => e.c.leg !== 'legal').length;
        return [n === 100 && !bad.length && !outside && !illegal, n + ' cards; identity ' + (R.CI || 'C') + '; outside identity ' + outside + '; banned/illegal ' + illegal + '; ' + (bad.length ? 'failed: ' + bad.join(', ') : 'count/singleton/identity/legality pass') + '; all rules: ' + (R.ok ? 'pass' : R.validation.rules.filter(r => r.pass === false).map(r => r.label).join(', ') + ' fail')];
      };
      for (const [label, cmds] of [['1-color commander', pick.mono], ['5-color commander', pick.five], ['Partner pair', pick.pair]]) {
        if (!cmds) { add(label + ' → 100 legal cards', null, 'No suitable commander found in data.'); continue; }
        const R = await gen({ commanders: cmds.map(c => c.n).concat(cmds.length === 1 ? [''] : []) }, label);
        const [ok, d] = legal(R); add(label + ' (' + cmds.map(c => c.n).join(' + ') + ') → 100 legal cards', ok, d);
      }
      if (pick.mono) {
        const cap = 75;
        const R = await gen({ commanders: [pick.mono[0].n, ''], budget: { total: cap, perCard: 5, cur: 'usd', inclBasics: true, unknown: 'exclude' } }, 'budget');
        if (R.errors.length) add('Budget cap $' + cap + ' (per-card $5) never exceeded', false, R.errors.join(' '));
        else add('Budget cap $' + cap + ' (per-card $5) never exceeded', R.totalPrice <= cap && R.deck.every(e => Engine.isBasic(e.c) || (e.c.p.usd != null && e.c.p.usd <= 5)), 'Total ' + Engine.fmt(R.totalPrice, 'usd') + '; max non-basic card ' + Engine.fmt(Math.max(0, ...R.deck.filter(e => !Engine.isBasic(e.c)).map(e => e.c.p.usd || 0)), 'usd') + '; ' + legal(R)[1]);
        const R2 = await gen({ commanders: [pick.mono[0].n, ''], budget: { total: 0.01, cur: 'usd', inclBasics: true } }, 'infeasible budget');
        add('Infeasible budget ($0.01) returns clear message', R2.errors.length > 0 && /Budget infeasible/.test(R2.errors[0]), R2.errors[0] || 'No error returned');
        const a = await gen({ commanders: [pick.mono[0].n, ''], variance: 0.5, seed: 'det-check' }, 'determinism A');
        const b = await gen({ commanders: [pick.mono[0].n, ''], variance: 0.5, seed: 'det-check' }, 'determinism B');
        const same = !a.errors.length && Engine.exportDeck(a, 'plain') === Engine.exportDeck(b, 'plain');
        add('Same seed + settings = identical deck', same, same ? 'Identical 100-card lists (variance 0.5, seed "det-check").' : 'Lists differ.');
      }
      const brCmd = pick.five || pick.mono;
      if (brCmd) {
        const R = await gen({ commanders: brCmd.map(c => c.n).concat(['']).slice(0, 2), bracket: 2, bl: Engine.bracketDefaults(2) }, 'bracket 2');
        add('Bracket 2 deck (' + brCmd.map(c => c.n).join(' + ') + ') has 0 Game Changers', !R.errors.length && R.stats.gcs.length === 0, R.errors.length ? R.errors.join(' ') : 'Game Changers: ' + (R.stats.gcs.join(', ') || 'none') + '; ' + legal(R)[1]);
      }
    } catch (e) { add('Test run', false, e.message || String(e)); }
    setStatus('Tests finished.'); App.busy = false; renderSources(); renderView();
    function choose(cards, partners) {
      const by = n => cards.filter(c => c.ci.length === n && !Engine.cmdTraits(c).isBg).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
      const ps = partners.filter(c => Engine.commanderEligibility(c).ok).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
      let pair = null;
      for (let i = 0; i < ps.length && !pair; i++) for (let j = i + 1; j < ps.length && !pair; j++) if (ps[i].ci !== ps[j].ci && Engine.pairCheck(ps[i], ps[j]).ok) pair = [ps[i], ps[j]];
      return { mono: by(1)[0] ? [by(1)[0]] : null, five: by(5)[0] ? [by(5)[0]] : null, pair };
    }
  }

  /* ---------- event wiring ---------- */
  /* ---------- card popover: rules text, price, roles and why a card is in the deck. Any element with data-card opens it
     (hover with a mouse, tap or click anywhere). Pictures come from cards.scryfall.io only when the user turns them on. ---------- */
  const IMG_BASE = 'https://cards.scryfall.io/normal/';
  const imgOn = () => App.img === 'on';
  const imgTag = (c, cls) => imgOn() && c && c.img ? '<img class="' + (cls || 'cimg') + '" src="' + IMG_BASE + esc(c.img) + '" alt="' + esc(c.n) + '" loading="lazy" referrerpolicy="no-referrer">' : '';
  const cardLink = (c, label) => { const own = c && ownSet() && ownSet().has(c.n); return '<a class="cl' + (own ? ' own' : '') + '" href="' + esc((c && c.uri) || '#') + '" target="_blank" rel="noopener" data-card="' + esc(c ? c.n : label) + '"' + (own ? ' title="In your collection"' : '') + '>' + esc(label || (c && c.n) || '') + '</a>'; };
  const nameLink = n => { const c = App.bulk && Engine.lookup(App.bulk, n); return c ? cardLink(c, n) : esc(n); };
  function popHTML(c) {
    const R = App.R, a = Engine.analyze(c), e = R && R.deck ? R.deck.find(x => x.c.n === c.n) : null, p = c.p[(R ? R.settings : App.S).budget.cur];
    const isCmd = R && R.commanders && R.commanders.some(x => x.n === c.n);
    const chips = Object.keys(a.roles).map(r => '<span class="chip">' + esc(Engine.SLOT_LABEL[r]) + '</span>').join('') + (c.gc ? '<span class="chip gc">Game Changer</span>' : '') +
      ['tutor', 'fast', 'stax', 'xturn', 'mld'].filter(f => a.flags[f]).map(f => '<span class="chip flag">' + esc(Engine.FLAGS[f].label) + '</span>').join('');
    return imgTag(c) + '<div class="cp-h"><b>' + esc(c.n) + '</b><span class="cost">' + manaHTML(c.mc) + '</span><button type="button" class="iconx" data-popx="1" aria-label="Close">✕</button></div>' +
      '<div class="note">' + esc(c.tl) + (c.pt ? ' · ' + esc(c.pt) : '') + '</div>' +
      (c.ot ? '<div class="cp-ot">' + manaHTML(c.ot).replace(/\n/g, '<br>') + '</div>' : '') +
      (ownSet() && !Engine.isBasic(c) ? '<div class="cp-m">' + (ownSet().has(c.n) ? '<span class="ownmk"></span> In your collection' : 'Not in your collection') + '</div>' : '') +
      '<div class="cp-m">' + (p != null ? fmtP(p) : 'no price') + (c.rank ? ' · EDHREC #' + c.rank.toLocaleString() : '') + (c.leg !== 'legal' ? ' · <span class="pup">' + esc(c.leg.replace('_', ' ')) + ' in Commander</span>' : '') + '</div>' +
      (chips ? '<div>' + chips + '</div>' : '') +
      (isCmd ? '<div class="cp-why"><b>Commander</b></div>' : e ? '<div class="cp-why"><b>Why it is in the deck:</b> ' + esc(e.why || Engine.SLOT_LABEL[e.slot] || e.slot || '') + (e.locked ? ' (locked)' : '') + '</div>' : '') +
      (e && !isCmd ? (i => '<div class="row cp-acts"><button type="button" class="small" data-act="lock" data-i="' + i + '" aria-pressed="' + !!e.locked + '">' + (e.locked ? 'Unlock' : 'Lock') + '</button>' + (Engine.isBasic(c) ? '' : '<button type="button" class="small" data-act="swap" data-i="' + i + '">Swap</button><button type="button" class="small" data-act="remove" data-i="' + i + '">Remove</button>') + '</div>')(R.deck.indexOf(e)) : '') +
      '<div class="row"><a href="card.html#' + encodeURIComponent(c.n) + '" target="_blank" rel="noopener">Similar cards and combos ↗</a>' + (c.uri ? '<a href="' + esc(c.uri) + '" target="_blank" rel="noopener">Scryfall ↗</a>' : '') + '</div>';
  }
  let popT = 0, popFor = null, popPinned = false;
  // beside the card name when there is room (so it covers neither the name nor the rows around it), else below or
  // above it; placed again once the picture loads. Phones get a bottom sheet from CSS.
  function showPop(el, pinned) {
    const c = App.bulk && Engine.lookup(App.bulk, el.dataset.card); if (!c) return;
    const pop = $('cardPop'); pop.innerHTML = popHTML(c); pop.classList.remove('hidden'); popFor = el; popPinned = !!pinned; pop.scrollTop = 0; pop.classList.toggle('wimg', !!pop.querySelector('img'));
    const place = () => {
      if (popFor !== el) return;
      if (matchMedia('(max-width:640px)').matches) { pop.style.left = pop.style.top = ''; return; }
      const r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, m = 8, vw = innerWidth, vh = innerHeight;
      const midY = Math.min(Math.max(m, r.top + r.height / 2 - h / 2), vh - h - m);
      let x, y;
      if (r.right + 14 + w <= vw - m) { x = r.right + 14; y = midY; }
      else if (r.bottom + 6 + h <= vh - m) { x = r.left; y = r.bottom + 6; }
      else if (r.top - 6 - h >= m) { x = r.left; y = r.top - 6 - h; }
      else if (r.left - 14 - w >= m) { x = r.left - 14 - w; y = midY; }
      else { x = r.left; y = midY; }
      pop.style.left = Math.min(Math.max(m, x), vw - w - m) + 'px'; pop.style.top = Math.max(m, y) + 'px';
    };
    place();
    const img = pop.querySelector('img'); if (img && !img.complete) img.addEventListener('load', place, { once: true });
  }
  function hidePop() { const p = $('cardPop'); if (p) p.classList.add('hidden'); popFor = null; popPinned = false; }

  /* ---------- sample hand: draw 7, London mulligan (first one free in multiplayer), draw more. Uses the browser's random
     generator, not the deck seed, so every hand is new. ---------- */
  function shuffle(a) { const r = new Uint32Array(a.length); crypto.getRandomValues(r); for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function shDeal(mull) {
    const lib = []; for (const e of App.R.deck) for (let i = 0; i < e.qty; i++) lib.push(e.c);
    shuffle(lib); App.SH = { lib, hand: lib.splice(0, 7), bottom: [], mull, need: Math.max(0, mull - 1), drawn: 0, key: deckKey(App.R) };
  }
  function renderHand() {
    const R = App.R; if (!R || !R.stats) { $('view').innerHTML = emptyView(); return; }
    if (!App.SH || App.SH.key !== deckKey(R)) shDeal(0);
    const S = App.SH, isLand = c => Engine.analyze(c).isLand, lands = S.hand.filter(isLand).length, spells = S.hand.filter(c => !isLand(c));
    const avg = spells.length ? spells.reduce((s, c) => s + c.cmc, 0) / spells.length : 0, pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    const tile = (c, i) => '<button type="button" class="hcard' + (isLand(c) ? ' land' : '') + (imgOn() && c.img ? ' pic' : '') + '" data-hc="' + i + '" data-card="' + esc(c.n) + '">' +
      (imgOn() && c.img ? imgTag(c, 'himg') : '<span class="hn">' + esc(c.n) + '</span><span class="cost">' + manaHTML(c.mc) + '</span><span class="note">' + esc(c.ft.split(' — ')[0]) + '</span>') + '</button>';
    $('view').innerHTML = '<div class="row" style="gap:8px;align-items:center">' +
      '<button type="button" class="primary small" data-sh="new">New hand</button><button type="button" class="small" data-sh="mull"' + (S.mull >= 6 ? ' disabled' : '') + '>Mulligan</button><button type="button" class="small" data-sh="draw"' + (S.need || !S.lib.length ? ' disabled' : '') + '>Draw a card</button>' +
      '<span class="note">' + (S.drawn ? pl(S.drawn, 'card') + ' drawn after the opening hand' : 'Opening hand') + (S.mull ? ' · mulligan ' + S.mull + (S.mull === 1 ? ' (free)' : '') : '') + ' · ' + S.lib.length + ' in library</span></div>' +
      (S.need ? '<div class="msg warn" style="margin-top:10px">Choose ' + pl(S.need, 'card') + ' to put on the bottom. London mulligan: draw 7, then bottom one card per mulligan after the free first one.</div>' : '') +
      '<div class="hand">' + S.hand.map(tile).join('') + '</div>' +
      '<p>' + S.hand.length + ' cards: ' + pl(lands, 'land') + ', ' + pl(spells.length, 'spell') + (spells.length ? ', average MV ' + avg.toFixed(1) : '') + '. Command zone: ' + R.commanders.map(c => cardLink(c)).join(', ') + '.' + (S.bottom.length ? ' On the bottom: ' + S.bottom.map(c => esc(c.n)).join(', ') + '.' : '') + '</p>' +
      '<p class="note">' + (S.need ? 'Tap a card to put it on the bottom.' : 'Hover or tap a card to read it.') + ' Shuffled with the browser\'s random generator, so each hand is new. The Primer and Analysis use 10,000+ simulated games for the odds.</p>';
  }

  /* ---------- commander browser: every legal commander in the card data, filtered by colour, theme and text ---------- */
  function cmdThemes(c) { return Object.keys(Engine.TAGS).filter(k => { const t = Engine.TAGS[k]; return (t.re && t.re.test(c.low)) || (t.type && t.type.test(c.tl)); }); }
  function renderCommanders() {
    if (!App.bulk) { $('view').innerHTML = emptyView(); return; }
    const F = App.cbr || (App.cbr = { q: '', cols: '', mode: 'within', theme: '', sort: 'rank', n: 50 });
    const opt = (v, t, cur) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + esc(t) + '</option>';
    $('view').innerHTML = '<div class="row" style="gap:10px;align-items:flex-end">' +
      '<label class="f" style="flex:1 1 220px">Name, type or rules text<input type="search" id="cbrQ" value="' + esc(F.q) + '" placeholder="e.g. dragon, landfall, Atraxa" autocomplete="off"></label>' +
      '<div class="f"><span>Colours</span><div class="seg" id="cbrCols">' + 'WUBRG'.split('').map(x => '<button type="button" data-col="' + x + '" aria-pressed="' + F.cols.includes(x) + '" aria-label="' + x + '">' + pipsHTML(x) + '</button>').join('') + '</div></div>' +
      '<label class="f">Match<select id="cbrMode">' + opt('within', 'Within these colours', F.mode) + opt('exact', 'Exactly these', F.mode) + opt('incl', 'Including these', F.mode) + '</select></label>' +
      '<label class="f">Theme<select id="cbrTheme">' + opt('', 'Any', F.theme) + Object.keys(Engine.TAGS).map(k => opt(k, Engine.TAGS[k].label, F.theme)).join('') + '</select></label>' +
      '<label class="f">Sort<select id="cbrSort">' + opt('rank', 'EDHREC popularity', F.sort) + opt('price', 'Price, low first', F.sort) + opt('mv', 'Mana value', F.sort) + opt('name', 'Name', F.sort) + '</select></label>' +
      '</div><div id="cbrRes" style="margin-top:12px"></div>';
    renderCmdResults();
  }
  function renderCmdResults() {
    const F = App.cbr, el = $('cbrRes'); if (!el || !F) return;
    const q = F.q.trim().toLowerCase(), want = F.cols, cur = App.S.budget.cur;
    const colOK = c => !want && F.mode !== 'exact' ? true : F.mode === 'exact' ? c.ci === 'WUBRG'.split('').filter(x => want.includes(x)).join('') : F.mode === 'incl' ? [...want].every(x => c.ci.includes(x)) : [...c.ci].every(x => want.includes(x));
    const t = F.theme && Engine.TAGS[F.theme];
    let list = commanderIndex().filter(c => colOK(c) && (!q || c.n.toLowerCase().includes(q) || c.tl.toLowerCase().includes(q) || c.low.includes(q)) && (!t || (t.re && t.re.test(c.low)) || (t.type && t.type.test(c.tl))));
    const price = c => c.p[cur] == null ? 1e9 : c.p[cur];
    if (F.sort === 'price') list = list.slice().sort((a, b) => price(a) - price(b) || (a.rank || 1e9) - (b.rank || 1e9));
    else if (F.sort === 'mv') list = list.slice().sort((a, b) => a.cmc - b.cmc || (a.rank || 1e9) - (b.rank || 1e9));
    else if (F.sort === 'name') list = list.slice().sort((a, b) => a.n < b.n ? -1 : 1);
    const pair = c => /\bpartner\b/i.test(c.ot) ? 'Partner' : /friends forever/i.test(c.ot) ? 'Friends forever' : /choose a background/i.test(c.ot) ? 'Background' : /doctor's companion/i.test(c.ot) ? 'Companion' : '';
    const shown = list.slice(0, F.n);
    el.innerHTML = '<p class="note">' + list.length.toLocaleString() + ' of ' + commanderIndex().length.toLocaleString() + ' commanders match.' + (list.length > shown.length ? ' Showing ' + shown.length + '.' : '') + '</p>' +
      (shown.length ? '<div class="scroll"><table class="t compact cmdtable mrows"><thead><tr><th>Commander</th><th>Cost</th><th>Colours</th><th>Themes</th><th class="n">EDHREC</th><th class="n">Price</th><th></th></tr></thead><tbody>' +
        shown.map(c => '<tr><td class="m-2">' + cardLink(c) + (pair(c) ? ' <span class="chip">' + pair(c) + '</span>' : '') + '<div class="note">' + esc(c.tl) + '</div></td><td class="cost">' + manaHTML(c.mc) + '</td><td class="nw">' + pipsHTML(c.ci) + '</td><td class="why m-full">' + esc(cmdThemes(c).slice(0, 3).map(k => Engine.TAGS[k].label).join(', ')) + '</td><td class="n" data-l="EDHREC">' + (c.rank ? '#' + c.rank.toLocaleString() : '—') + '</td><td class="n">' + (c.p[cur] != null ? fmtP(c.p[cur]) : '—') + '</td><td class="m-3"><button type="button" class="small" data-cuse="' + esc(c.n) + '">Build</button></td></tr>').join('') +
        '</tbody></table></div>' : '') +
      (list.length > shown.length ? '<div class="row" style="margin-top:8px"><button type="button" class="small" data-cmore="1">Show 50 more</button></div>' : '') +
      '<p class="note">Themes are the generator\'s own synergy tags matched against each commander\'s rules text. Build sets the commander on Start; add a partner or background there.</p>';
  }

  /* ---------- Inspire me: a short quiz that ranks every legal commander with Engine.inspire and says why each fits.
     Surprise me: random commanders from the same pool. Both send a pick to New deck with Build. ---------- */
  const comboCounts = new WeakMap();
  function comboCount(n) {
    const cb = App.bulkCombos; if (!cb) return null;
    let M = comboCounts.get(cb); if (!M) comboCounts.set(cb, M = new Map());
    if (M.has(n)) return M.get(n);
    let k = 0, inf = 0; for (const v of cb.byCard.get(n) || []) if (v.r === 0) { k++; if (v.inf) inf++; }
    const r = k ? { n: k, inf } : null; M.set(n, r); return r;
  }
  const INSP_DEF = { cols: '', mode: 'within', style: '', tribe: '', themes: [], power: '', pop: '', price: '' };
  const QUICK_TRIBES = ['Elf', 'Dragon', 'Zombie', 'Goblin', 'Angel', 'Vampire', 'Human', 'Wizard', 'Merfolk', 'Dinosaur', 'Cat', 'Sliver'];
  function inspState() {
    if (!App.insp) { let s = {}; try { s = JSON.parse(LS.get('edhgen.inspire') || '{}'); } catch (e) { } App.insp = Object.assign({}, INSP_DEF, s, { n: 12, shown: !!s.shown }); }
    return App.insp;
  }
  const saveInsp = () => { const Q = App.insp; LS.set('edhgen.inspire', JSON.stringify({ cols: Q.cols, mode: Q.mode, style: Q.style, tribe: Q.tribe, themes: Q.themes, power: Q.power, pop: Q.pop, price: Q.price, shown: Q.shown })); };
  const pairChip = c => /\bpartner\b/i.test(c.ot) ? 'Partner' : /friends forever/i.test(c.ot) ? 'Friends forever' : /choose a background/i.test(c.ot) ? 'Background' : /doctor's companion/i.test(c.ot) ? 'Companion' : /\bBackground\b/.test(c.ft) ? 'Is a Background' : '';
  const segHTML = (key, opts, cur) => '<div class="seg" data-iq="' + key + '">' + opts.map(([v, t]) => '<button type="button" data-v="' + esc(v) + '" aria-pressed="' + (String(cur) === v) + '">' + t + '</button>').join('') + '</div>';
  const colSeg = (id, cols) => '<div class="seg" id="' + id + '">' + 'WUBRG'.split('').map(x => '<button type="button" data-icol="' + x + '" aria-pressed="' + cols.includes(x) + '" aria-label="' + x + '">' + pipsHTML(x) + '</button>').join('') + '</div>';
  function renderInspire() {
    if (!App.bulk) { $('view').innerHTML = emptyView(); return; }
    const Q = inspState(), cur = App.S.budget.cur, sym = Engine.fmt(1, cur).replace(/[\d.,\s]/g, '') || '$';
    const q = (n, h, note, body) => '<div class="qq"><div class="qn">' + n + '</div><div class="qb"><h3>' + h + '</h3>' + (note ? '<p class="note">' + note + '</p>' : '') + body + '</div></div>';
    const types = [...Engine.creatureTypes(App.bulk)].sort();
    $('view').innerHTML = '<div class="quiz">' +
      q(1, 'Which colours do you want to play?', 'Leave them all off for any colours.', '<div class="row">' + colSeg('iqCols', Q.cols) + segHTML('mode', [['within', 'Within these'], ['exact', 'Exactly these'], ['incl', 'Including these']], Q.mode) + '</div>') +
      q(2, 'How do you like to win?', '', '<div class="stylepick" data-iq="style">' + [['', 'No preference', 'Any play style']].concat(Object.keys(Engine.STYLES).map(k => [k, Engine.STYLES[k].label, Engine.STYLES[k].desc])).map(([v, l, d]) => '<button type="button" data-v="' + v + '" aria-pressed="' + (Q.style === v) + '"><b>' + esc(l) + '</b><span>' + esc(d) + '</span></button>').join('') + '</div>') +
      q(3, 'Favourite creature type?', 'Optional. Any of the ' + types.length.toLocaleString() + ' creature types in the card data.', '<div class="row"><input type="search" id="iqTribe" list="iqTribeL" value="' + esc(Q.tribe) + '" placeholder="e.g. Elf, Dragon, Zombie" autocomplete="off" style="max-width:240px"><datalist id="iqTribeL">' + types.map(t => '<option value="' + esc(t) + '">').join('') + '</datalist></div><div class="chips" data-iq="tribe">' + QUICK_TRIBES.filter(t => types.includes(t)).map(t => '<button type="button" data-v="' + t + '" aria-pressed="' + (Q.tribe === t) + '">' + t + '</button>').join('') + '</div>') +
      q(4, 'Themes you enjoy?', 'Pick any number; a commander scores for each one its rules text supports.', '<div class="chips" data-iq="themes">' + Object.keys(Engine.TAGS).map(k => '<button type="button" data-v="' + k + '" aria-pressed="' + Q.themes.includes(k) + '">' + esc(Engine.TAGS[k].label) + '</button>').join('') + '</div>') +
      q(5, 'How strong should the table be?', '', segHTML('power', [['', 'Any'], ['casual', 'Casual (brackets 1–2)'], ['mid', 'Upgraded (3)'], ['high', 'High power (4–5)']], Q.power)) +
      q(6, 'Popular or off the beaten path?', '', segHTML('pop', [['', 'No preference'], ['popular', 'Popular'], ['hidden', 'Hidden gems']], Q.pop)) +
      q(7, 'Price limit for the commander card?', 'The deck budget is set later on Start.', segHTML('price', [['', 'Any'], ['1', sym + '1'], ['5', sym + '5'], ['20', sym + '20']], Q.price)) +
      '<div class="row qgo"><button type="button" class="primary" data-insp="go">Show my commanders</button><button type="button" data-insp="reset">Reset answers</button></div>' +
      '</div><div id="inspRes"></div>';
    if (Q.shown) renderInspireResults();
  }
  function renderInspireResults() {
    const Q = App.insp, el = $('inspRes'); if (!el || !Q) return;
    const cur = App.S.budget.cur;
    const X = Engine.inspire(App.bulk, Object.assign({}, Q, { cur, price: Q.price === '' ? null : +Q.price }), { pool: commanderIndex(), combos: App.bulkCombos ? comboCount : null });
    const answered = Object.keys(X.used).filter(k => X.used[k]).length + (Q.cols ? 1 : 0);
    const shown = X.list.slice(0, Q.n);
    el.innerHTML = '<h3 class="an-sec">Your commanders</h3><p class="note">' + X.list.length.toLocaleString() + ' of ' + X.pool.toLocaleString() + ' commanders pass your colour and price answers' + (answered ? ', ranked by how well they match the rest.' : '. Answer a question above to rank them; for now they are in EDHREC order.') +
      (Q.style === 'combo' && !App.bulkCombos ? ' Combo data is not loaded, so Combo uses rules text only.' : '') + '</p>' +
      (shown.length ? '<div class="ins-grid">' + shown.map((r, i) => inspCard(r, i + 1, cur)).join('') + '</div>' : '<p class="msg warn">No commander passes these colour and price answers.</p>') +
      (X.list.length > shown.length ? '<div class="row" style="margin-top:10px"><button type="button" class="small" data-insp="more">Show 12 more</button></div>' : '') +
      '<p class="note">Match is the weighted share of your answers each commander meets: play style 3, creature type 3, themes 2, power 1, popularity 1 (0.75 when you have no preference, so among equal fits the more played commander comes first). Play style reads the commander\'s own rules text and, for Combo, its Commander Spellbook combos. Creature type counts the type in its type line, its rules text, and how many creatures of that type share its colours.</p>';
  }
  function inspCard(r, i, cur) {
    const c = r.c, pc = Math.round(r.pct * 100), pair = pairChip(c);
    return '<div class="ins-card">' + (imgOn() && c.img ? '<div class="ins-top">' + imgTag(c, 'ins-img') + '<div>' : '<div>') +
      '<div class="ins-h"><span class="note">#' + i + '</span><span class="ins-pct">' + pc + '% match</span></div>' +
      '<div class="ins-bar" aria-hidden="true"><i style="width:' + pc + '%"></i></div>' +
      '<div class="ins-n">' + cardLink(c) + ' <span class="cost">' + manaHTML(c.mc) + '</span></div>' +
      '<div class="note">' + esc(c.tl) + (c.pt ? ' · ' + esc(c.pt) : '') + '</div>' +
      '<div>' + pipsHTML(c.ci) + (pair ? ' <span class="chip">' + pair + '</span>' : '') + (c.gc ? ' <span class="chip gc">Game Changer</span>' : '') + '</div>' +
      (imgOn() && c.img ? '</div></div>' : '</div>') +
      (r.why.length ? '<ul class="ins-why">' + r.why.map(w => '<li' + (w.neg ? ' class="neg"' : '') + '>' + esc(w.t) + '</li>').join('') + '</ul>' : '') +
      '<div class="note">' + (c.rank ? 'EDHREC #' + c.rank.toLocaleString() : 'No EDHREC rank') + ' · ' + (r.price != null ? fmtP(r.price) : 'no price') + '</div>' +
      '<div class="row"><button type="button" class="small primary" data-cuse="' + esc(c.n) + '">Build</button><a class="small" href="card.html#' + encodeURIComponent(c.n) + '" target="_blank" rel="noopener">Card explorer ↗</a></div></div>';
  }

  const SUR_DEF = { cols: '', pop: '', price: '' };
  function surState() {
    if (!App.sur) { let s = {}; try { s = JSON.parse(LS.get('edhgen.surprise') || '{}'); } catch (e) { } App.sur = Object.assign({}, SUR_DEF, s, { picks: [] }); }
    return App.sur;
  }
  function surPool() {
    const F = surState(), cur = App.S.budget.cur, idx = commanderIndex(), ranked = idx.filter(c => c.rank).length;
    return idx.filter((c, i) => (!F.cols || [...c.ci].every(x => F.cols.includes(x))) &&
      (F.pop !== 'top' || (c.rank && i < 500)) && (F.pop !== 'deep' || !c.rank || i >= Math.min(1000, ranked)) &&
      (F.price === '' || (c.p[cur] != null && c.p[cur] <= +F.price)));
  }
  function surDraw(n, keep) {
    const pool = surPool(), have = new Set((keep || []).map(c => c.n)), out = (keep || []).slice(), r = new Uint32Array(1);
    let tries = 0;
    while (out.length < n && have.size < pool.length && tries++ < 1000) { crypto.getRandomValues(r); const c = pool[r[0] % pool.length]; if (!have.has(c.n)) { have.add(c.n); out.push(c); } }
    return out;
  }
  function renderSurprise() {
    if (!App.bulk) { $('view').innerHTML = emptyView(); return; }
    const F = surState(), cur = App.S.budget.cur, sym = Engine.fmt(1, cur).replace(/[\d.,\s]/g, '') || '$', pool = surPool();
    if (!F.picks.length && pool.length) F.picks = surDraw(3);
    $('view').innerHTML = '<div class="row" style="gap:10px 14px;align-items:flex-end">' +
      '<div class="f"><span>Within colours</span>' + colSeg('surCols', F.cols) + '</div>' +
      '<div class="f"><span>Popularity</span>' + segHTML('spop', [['', 'Any'], ['top', 'Top 500'], ['deep', 'Deep cuts']], F.pop) + '</div>' +
      '<div class="f"><span>Commander price</span>' + segHTML('sprice', [['', 'Any'], ['1', sym + '1'], ['5', sym + '5'], ['20', sym + '20']], F.price) + '</div>' +
      '<button type="button" class="primary" data-sur="all">Surprise me</button></div>' +
      '<p class="note">' + pool.length.toLocaleString() + ' commanders in the draw. Top 500 and Deep cuts (outside the 1,000 most played) use EDHREC rank among commanders.</p>' +
      (F.picks.length ? '<div class="ins-grid sur">' + F.picks.map((c, i) => surCard(c, i, cur)).join('') + '</div>' : '<p class="msg warn">No commander matches these filters.</p>');
  }
  function surCard(c, i, cur) {
    const lean = Engine.styleProfile(c, App.bulkCombos ? comboCount : null).slice(0, 2), th = cmdThemes(c).slice(0, 4), pair = pairChip(c), k = App.bulkCombos ? comboCount(c.n) : null;
    return '<div class="ins-card">' + (imgOn() && c.img ? imgTag(c, 'sur-img') : '') +
      '<div class="ins-n">' + cardLink(c) + ' <span class="cost">' + manaHTML(c.mc) + '</span></div>' +
      '<div class="note">' + esc(c.tl) + (c.pt ? ' · ' + esc(c.pt) : '') + '</div>' +
      '<div>' + pipsHTML(c.ci) + (pair ? ' <span class="chip">' + pair + '</span>' : '') + (c.gc ? ' <span class="chip gc">Game Changer</span>' : '') + '</div>' +
      (imgOn() && c.img ? '' : c.ot ? '<div class="cp-ot">' + manaHTML(c.ot).replace(/\n/g, '<br>') + '</div>' : '') +
      '<ul class="ins-why">' + (lean.length ? lean.map(s => '<li><b>' + esc(s.label) + ':</b> ' + esc(s.hit.join(', ')) + '</li>').join('') : '<li>No strong lean toward one play style in its rules text.</li>') +
      (th.length ? '<li><b>Themes:</b> ' + esc(th.map(t => Engine.TAGS[t].label).join(', ')) + '</li>' : '') +
      (k && !lean.some(s => s.key === 'combo') ? '<li>' + k.n.toLocaleString() + ' Commander Spellbook combo' + (k.n === 1 ? '' : 's') + '</li>' : '') + '</ul>' +
      '<div class="note">' + (c.rank ? 'EDHREC #' + c.rank.toLocaleString() : 'No EDHREC rank') + ' · ' + (c.p[cur] != null ? fmtP(c.p[cur]) : 'no price') + '</div>' +
      '<div class="row"><button type="button" class="small primary" data-cuse="' + esc(c.n) + '">Build</button><button type="button" class="small" data-sur="' + i + '">Reroll</button><a class="small" href="card.html#' + encodeURIComponent(c.n) + '" target="_blank" rel="noopener">Card explorer ↗</a></div></div>';
  }
  function wireDiscover() {
    let tT = 0;
    const rerank = () => { const Q = App.insp; saveInsp(); if (Q.shown) { Q.n = 12; renderInspireResults(); } };
    $('view').addEventListener('input', e => { if (e.target.id === 'iqTribe' && App.insp) { App.insp.tribe = e.target.value.trim(); document.querySelectorAll('[data-iq="tribe"] button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === App.insp.tribe)); clearTimeout(tT); tT = setTimeout(rerank, 250); } });
    $('view').addEventListener('click', e => {
      if (App.tab === 'inspire') {
        const Q = inspState(), col = e.target.closest('#iqCols button[data-icol]'), opt = e.target.closest('[data-iq] button[data-v]'), act = e.target.closest('button[data-insp]');
        if (col) { const x = col.dataset.icol; Q.cols = Q.cols.includes(x) ? Q.cols.replace(x, '') : Q.cols + x; col.setAttribute('aria-pressed', Q.cols.includes(x)); rerank(); }
        else if (opt) {
          const key = opt.closest('[data-iq]').dataset.iq, v = opt.dataset.v;
          if (key === 'themes') { const i = Q.themes.indexOf(v); if (i >= 0) Q.themes.splice(i, 1); else Q.themes.push(v); opt.setAttribute('aria-pressed', i < 0); }
          else { Q[key] = key === 'tribe' && Q.tribe === v ? '' : v; opt.parentNode.querySelectorAll('button[data-v]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === Q[key])); if (key === 'tribe') $('iqTribe').value = Q.tribe; }
          rerank();
        }
        else if (act && act.dataset.insp === 'go') { Q.shown = true; Q.n = 12; saveInsp(); renderInspireResults(); $('inspRes').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        else if (act && act.dataset.insp === 'reset') { App.insp = Object.assign({}, INSP_DEF, { themes: [], n: 12, shown: false }); saveInsp(); renderInspire(); }
        else if (act && act.dataset.insp === 'more') { Q.n += 12; renderInspireResults(); }
      } else if (App.tab === 'surprise') {
        const F = surState(), col = e.target.closest('#surCols button[data-icol]'), opt = e.target.closest('[data-iq] button[data-v]'), act = e.target.closest('button[data-sur]');
        const save = () => LS.set('edhgen.surprise', JSON.stringify({ cols: F.cols, pop: F.pop, price: F.price }));
        if (col) { const x = col.dataset.icol; F.cols = F.cols.includes(x) ? F.cols.replace(x, '') : F.cols + x; save(); F.picks = []; renderSurprise(); }
        else if (opt) { F[{ spop: 'pop', sprice: 'price' }[opt.closest('[data-iq]').dataset.iq]] = opt.dataset.v; save(); F.picks = []; renderSurprise(); }
        else if (act && act.dataset.sur === 'all') { F.picks = surDraw(3); renderSurprise(); }
        else if (act) { const i = +act.dataset.sur, keep = F.picks.filter((_, j) => j !== i), nw = surDraw(keep.length + 1, F.picks).slice(F.picks.length); if (nw.length) { F.picks[i] = nw[0]; renderSurprise(); } }
      }
    });
  }

  /* ---------- table talk: what a playgroup asks about before a game, from the same flags the bracket rules use ---------- */
  function tableFeel(R) {
    const all = R.commanders.concat(R.deck.map(e => e.c)), by = f => all.filter(c => Engine.analyze(c).flags[f]).map(c => c.n);
    const cmb = R.combos || [], two = cmb.filter(v => v.inf && v.c.length <= 2);
    // [singular, plural, what "none" reads as, cards]
    return [['Game Changer', 'Game Changers', 'Game Changers', all.filter(c => c.gc).map(c => c.n)], ['tutor', 'tutors', 'tutors', by('tutor')], ['fast mana card', 'fast mana cards', 'fast mana', by('fast')],
      ['extra-turn card', 'extra-turn cards', 'extra turns', by('xturn')], ['mass land denial card', 'mass land denial cards', 'land denial', by('mld')], ['stax or tax piece', 'stax or tax pieces', 'stax', by('stax')],
      ['2-card infinite combo', '2-card infinite combos', '2-card infinites', two.map(v => v.c.join(' + '))], ['other Spellbook combo', 'other Spellbook combos', '', cmb.filter(v => two.indexOf(v) < 0).map(v => v.c.join(' + '))]];
  }
  /* tokens, emblems and markers the deck makes, read from rules text (reminder text removed) */
  const TOKEN_ART = /\b(treasure|food|clue|blood|map|powerstone|gold|incubator|junk|shard|walker|lander|mutagen|role|vehicle)\b/;
  const MARKERS = [[/\binvestigate/, 'Clue'], [/\bincubate/, 'Incubator'], [/\bamass\b/, 'Army (creature, grows with counters)'], [/\bfabricate\b/, 'Servo (1/1 artifact creature)'], [/\b(?:embalm|eternalize|encore|myriad)\b/, 'Token copies'],
    [/\bbecomes? the monarch|\bthe monarch\b/, 'Monarch card'], [/\binitiative\b/, 'Initiative (Undercity dungeon)'], [/venture into the dungeon/, 'Dungeon cards'], [/the ring tempts you/, 'The Ring emblem'],
    [/\{e\}/, 'Energy counters'], [/\bdaybound\b|\bit becomes (?:day|night)\b/, 'Day/Night marker'], [/\bpoison counters?\b|\btoxic\b|\binfect\b/, 'Poison counters'], [/\bexperience counters?\b/, 'Experience counters'],
    [/\+1\/\+1 counters?/, '+1/+1 counters (dice)'], [/-1\/-1 counters?/, '-1/-1 counters'], [/\byou get an emblem\b/, 'Emblem'], [/city's blessing|\bascend\b/, 'City\'s blessing'], [/\bstart your engines\b/, 'Speed tracker']];
  function tokensNeeded(cards) {
    const tok = new Map(), mk = new Map(), add = (m, k, n) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(n); };
    for (const c of cards) {
      const ot = (c.ot || '').replace(/\([^)]*\)/g, ''), low = ot.toLowerCase(), re = /\bcreates? ([^.;:]*?)\btokens?\b/gi; let m;
      while ((m = re.exec(ot))) {
        let s = m[1].trim(); const l = s.toLowerCase();
        if (/\bcop(?:y|ies)\b/.test(l)) { add(tok, 'Token copies', c.n); continue; }
        s = s.replace(/^(?:a number of|that many|twice that many|one or more|a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+)\s+/i, '').replace(/^(?:tapped|untapped)(?: and attacking)?\s+/i, '').replace(/^(?:and|or)\s+/i, '').trim();
        if (!s || /^(?:a|an|one or more|that|those|\d+|x)$/i.test(s) || /\b(?:for each|under|instead)\b/i.test(s)) continue;
        const art = TOKEN_ART.exec(s.toLowerCase());
        let label = art && !/creature/i.test(s) ? art[1] : s.replace(/\s+/g, ' ');
        label = label.charAt(0).toUpperCase() + label.slice(1); if (label.length > 60) label = label.slice(0, 57) + '…';
        add(tok, label, c.n);
      }
      for (const [rx, label] of MARKERS) if (rx.test(low)) add(label === 'Clue' || label === 'Incubator' || /^(?:Army|Servo|Token copies)/.test(label) ? tok : mk, label, c.n);
    }
    const out = m => [...m].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1)).map(([k, s]) => ({ label: k, from: [...s] }));
    return { tokens: out(tok), markers: out(mk) };
  }

  /* ---------- print: primer + list on paper, and a text proxy sheet (63 × 88 mm, nine per page) ---------- */
  function printWith(html) {
    let el = $('printArea'); if (!el) { el = document.createElement('div'); el.id = 'printArea'; document.body.appendChild(el); }
    el.innerHTML = html; document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); el.innerHTML = ''; removeEventListener('afterprint', done); };
    addEventListener('afterprint', done); setTimeout(() => window.print(), 60);
  }
  function printPrimer() {
    const R = App.R, prim = document.querySelector('.primer-wrap'); if (!R || !prim) return;
    const groups = new Map(); for (const e of R.deck) { const k = Engine.typeGroup(e.c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    const q = quickStats();
    const list = [...groups].map(([k, es]) => '<div class="pg"><b>' + esc(k) + ' (' + es.reduce((s, e) => s + e.qty, 0) + ')</b>' + es.sort((a, b) => a.c.cmc - b.c.cmc || (a.c.n < b.c.n ? -1 : 1)).map(e => '<div>' + e.qty + ' ' + esc(e.c.n) + ' <span class="pmc">' + esc(e.c.mc || '') + '</span></div>').join('') + '</div>').join('');
    printWith('<h1>' + esc(R.commanders.map(c => c.n).join(' + ')) + '</h1><p>Bracket ' + R.settings.bracket + (q ? ' · power ' + q.pl.toFixed(1) + ' · typical win T' + q.win : '') + ' · ' + fmtP(R.stats.total) + ' · printed ' + esc(new Date().toLocaleDateString()) + '</p>' +
      '<h2>Decklist</h2><div class="pcols">' + list + '</div><h2>Primer</h2>' + prim.outerHTML);
  }
  function printProxies() {
    const R = App.R; if (!R) return;
    const cards = R.commanders.slice(); for (const e of R.deck) if (!Engine.isBasic(e.c)) for (let i = 0; i < e.qty; i++) cards.push(e.c);
    printWith('<div class="pxgrid">' + cards.map(c => '<div class="px"><div class="px-h"><b>' + esc(c.n) + '</b><span>' + esc(c.mc || '') + '</span></div><div class="px-t">' + esc(c.tl) + '</div><div class="px-o">' + esc(c.ot || '').replace(/\n/g, '<br>') + '</div>' + (c.pt ? '<div class="px-pt">' + esc(c.pt) + '</div>' : '') + '</div>').join('') + '</div>');
  }

  /* ---------- history diff: cards in and out and the change in price, power and score between two saved decks ---------- */
  function histDiffHTML(a, b) {
    if (new Date(a.at) > new Date(b.at)) { const t = a; a = b; b = t; }
    const cnt = arr => { const m = new Map(); for (const s of arr) { const i = s.indexOf(' '), n = s.slice(i + 1); m.set(n, (m.get(n) || 0) + (+s.slice(0, i) || 1)); } return m; };
    const A = cnt(a.names), B = cnt(b.names), diff = (X, Y) => { const r = []; for (const [n, q] of X) { const d = q - (Y.get(n) || 0); if (d > 0) r.push((d > 1 ? d + ' ' : '') + nameLink(n)); } return r; };
    const out = diff(A, B), inn = diff(B, A);
    const when = e => esc(new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    const row = (l, x, y, f, better, fd) => { fd = fd || f; const d = x != null && y != null ? y - x : null; return '<tr><td>' + l + '</td><td class="n">' + (x != null ? f(x) : '—') + '</td><td class="n">' + (y != null ? f(y) : '—') + '</td><td class="n' + (d ? (d > 0) === better ? ' good' : ' badc' : '') + '">' + (d == null ? '—' : (d > 0 ? '+' : d < 0 ? '−' : '±') + fd(Math.abs(d))) + '</td></tr>'; };
    const money = v => Engine.fmt(v, b.m.cur || 'usd');
    return '<h3 class="an-sec">' + when(a) + ' → ' + when(b) + '</h3>' +
      (a.cmds.join('|') !== b.cmds.join('|') ? '<p class="msg warn">Different commanders: ' + esc(a.cmds.join(' + ')) + ' → ' + esc(b.cmds.join(' + ')) + '.</p>' : '') +
      '<table class="t compact" style="max-width:520px"><thead><tr><th></th><th class="n">Older</th><th class="n">Newer</th><th class="n">Change</th></tr></thead><tbody>' +
      row('Price', a.m.price, b.m.price, money, false) + row('Power', a.m.pl, b.m.pl, v => v.toFixed(1), true) + row('Fundamentals', a.m.fund, b.m.fund, v => String(Math.round(v)), true) + row('Bracket', a.m.bracket, b.m.bracket, v => 'B' + v, false, String) +
      '</tbody></table><div class="grid2" style="margin-top:10px"><div><h3>Out (' + out.length + ')</h3>' + (out.length ? '<ul class="dl">' + out.map(x => '<li>' + x + '</li>').join('') + '</ul>' : '<p class="note">None</p>') + '</div><div><h3>In (' + inn.length + ')</h3>' + (inn.length ? '<ul class="dl">' + inn.map(x => '<li>' + x + '</li>').join('') + '</ul>' : '<p class="note">None</p>') + '</div></div>';
  }

  /* ---------- undo: rebuild the deck from its settings and replay every edit but the last (generation is deterministic) ---------- */
  const opLabel = op => op.op === 'remove' ? 'removing ' + op.cut : op.cut + ' → ' + op.add;
  async function replayChain(chain, ops) {
    App.restoring = true;
    try {
      App.S = deepAssign(uiDefaults(), JSON.parse(JSON.stringify(chain.settings))); writeForm(App.S); persistSettings();
      await runGenerate(chain.env);
      const R = App.R; if (!R) return false;
      for (const op of ops) {
        const cut = op.cut && R.deck.find(x => x.c.n === op.cut), add = op.add && Engine.lookup(App.bulk, op.add);
        if (op.op === 'swap' && cut && add) await R.swapOne(cut, add);
        else if (op.op === 'replace' && cut && add) await R.replace(cut, add, op.locked);
        else if (op.op === 'remove' && cut) await R.remove(cut);
      }
      App.chain = { settings: chain.settings, env: chain.env, ops: ops.slice() };
      return true;
    } finally { App.restoring = false; }
  }
  async function undoLast() {
    const ch = App.chain; if (!ch || !ch.ops.length || App.busy || !App.R) return;
    const last = ch.ops[ch.ops.length - 1], locked = new Set(App.R.deck.filter(e => e.locked).map(e => e.c.n)), tab = App.tab;
    if (!(await replayChain(ch, ch.ops.slice(0, -1)))) return;
    for (const e of App.R.deck) if (locked.has(e.c.n)) e.locked = true;
    App.AN = null; App.QS = null; App.PR = null; App.SH = null; App.tab = tab === 'setup' ? viewOf('cards') : tab; renderAll();
    histPush('edit', 'Undid ' + opLabel(last)); setStatus('Undid ' + opLabel(last) + '.');
  }

  /* ---------- colour check: chance of each colour for its hardest card on curve, given the land drops (Karsten's definition) ---------- */
  function colourCheckHTML(R) {
    const cols = (R.CI || '').split('').filter(x => 'WUBRG'.includes(x)); if (!cols.length) return '';
    const K = Analysis.colourCheck(R.deck, R.commanders, R.CI), ok = Analysis.CAST_OK;
    const rows = cols.map(X => ({ X, K: K.landSrc[X], worst: K.cast.find(r => r.color === X), low: K.cast.filter(r => r.color === X && r.p < ok).length })).filter(r => r.worst);
    if (!rows.length) return '';
    const byName = new Map(R.commanders.concat(R.deck.map(e => e.c)).map(c => [c.n, c]));
    return '<div class="wide"><h3>Colour check</h3><div class="scroll"><table class="t"><thead><tr><th>Colour</th><th class="n">Land sources</th><th>Hardest on curve</th><th class="n">Needs</th><th class="n">P</th><th class="n">Cards below ' + Math.round(ok * 100) + '%</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + pipsHTML(r.X) + '</td><td class="n">' + r.K + '</td><td>' + cardLink(byName.get(r.worst.n)) + (r.worst.cmd ? ' <span class="chip">commander</span>' : '') + '</td><td class="n nw">' + r.worst.k + ' by T' + r.worst.t + '</td><td class="n' + (r.worst.p < ok ? ' badc' : '') + '">' + Math.round(r.worst.p * 100) + '%</td><td class="n">' + r.low + '</td></tr>').join('') +
      '</tbody></table></div><p class="note">P is the exact chance of having at least that many lands of the colour by that turn on the play (7 + turn − 1 cards from ' + K.N + '), given you have hit your land drops (' + K.L + ' lands). This is Frank Karsten\'s definition. His published 99-card figures (19 sources for one pip on turn 1, 30 for two on turn 2) come out at 81% and 87% here, because he also counts mulligans; red is below ' + Math.round(ok * 100) + '%. Mana rocks and dorks are not counted.</p></div>';
  }

  /* ---------- keyboard shortcuts ---------- */
  const KEYS_HELP = 'Keys: 1–6 open Start, Collection, Deck, Analysis, Improve and Primer · G generate · / search · U or Ctrl+Z undo the last edit · Esc closes popups · ? shows this.';

  function wire() {
    document.querySelector('.settings').addEventListener('input', onFormChange);
    document.querySelector('.settings').addEventListener('change', onFormChange);
    $('bulkFile').addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      if (!/\.gz$/i.test(f.name)) { loadBulk(f); return; }
      if (typeof DecompressionStream === 'undefined') { setStatus('This browser cannot unzip .gz files; unzip it first.'); return; }
      const z = () => f.stream().pipeThrough(new DecompressionStream('gzip'));
      loadBulk({ name: f.name, size: f.size * 8, lastModified: f.lastModified, stream: z, text: () => new Response(z()).text() });
    });
    $('forgetBtn').addEventListener('click', async () => { await IDB.del('bulk'); await IDB.del('combos'); $('idbNote').textContent = 'Stored data removed.'; });
    $('seedBtn').addEventListener('click', () => { const s = Math.random().toString(36).slice(2, 10); $('seed').value = s; App.S.seed = s; App.S.reroll = 0; persistSettings(); });
    $('genBtn').addEventListener('click', () => { App.S.reroll = 0; runGenerate(); });
    $('regenBtn').addEventListener('click', () => {
      if (!App.R) return;
      App.S.reroll = 0; // same settings + same locks = same deck
      const locks = App.R.deck.filter(e => e.locked && !e.inc).map(e => ({ name: e.c.n, slot: e.slot, qty: e.qty }));
      runGenerate({ locks, bans: App.R.bans || [], imported: !!(App.chain && App.chain.env && App.chain.env.imported) });
    });
    $('testBtn').addEventListener('click', runTests);
    const moreList = $('moreList'), setMore = open => { moreList.classList.toggle('hidden', !open); $('moreBtn').setAttribute('aria-expanded', open); };
    $('moreBtn').addEventListener('click', e => { e.stopPropagation(); setMore(moreList.classList.contains('hidden')); });
    document.addEventListener('click', e => { if (!moreList.classList.contains('hidden') && !e.target.closest('.morewrap')) setMore(false); });
    document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-page],button[data-tab]'); if (!b) return; setMore(false); go(b.dataset.page || b.dataset.tab); });
    $('pageHead').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) go(viewOf(b.dataset.view)); });
    $('view').addEventListener('input', e => { if (e.target.id === 'anText') App.anText = e.target.value; if (e.target.id === 'impText') { App.impText = e.target.value; App.impPick = null; } });
    $('view').addEventListener('click', e => { if (e.target.closest('#impBtn')) importDeck();
      const ic = e.target.closest('[data-impcmd]'); if (ic) { App.impPick = ic.dataset.impcmd; importDeck(); } const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go); });
    $('view').addEventListener('click', async e => {
      const pc = e.target.closest('button[data-pc]');
      if (pc) {
        if (pc.dataset.pc === 'run') perCardRun(); else if (pc.dataset.pc === 'cancel') { if (App.PC && App.PC.cancel) App.PC.cancel(); }
        else if (pc.dataset.pc === 'swap') { const r = (App.pcRows || [])[+pc.dataset.i], o = r && r.opts[+pc.dataset.j]; if (!o) return; pc.disabled = true; await applyChange(r.cut, o.add); (App.accepted = App.accepted || []).push({ cut: r.cut, add: o.add, src: App.anSource }); App.AN = null; if (App.anSource !== 'paste') renderAll(); renderView(); runAnalysis(); }
        return;
      }
      const dp = e.target.closest('button[data-deep]');
      if (dp) { if (dp.dataset.deep === 'run' || dp.dataset.deep === 'wide') deepRun(dp.dataset.deep === 'wide'); else if (App.DEEP && App.DEEP.cancel) App.DEEP.cancel(); return; }
      const b = e.target.closest('button[data-sw]'); if (!b || !App.AN) return;
      const X = App.AN, a = b.dataset.sw;
      if (a === 'deny') { const p = X.impact[+b.dataset.i]; if (!p) return; App.denied.add(p.add.n); X.impact.splice(+b.dataset.i, 1); X.plans = X.plans.filter(q => q.add !== p.add); renderSwaps(); return; }
      if (a === 'clear-deny') { App.denied.clear(); anStale(); renderAnView(); runAnalysis(); return; }
      if (a === 'weak') { App.showWeak = !App.showWeak; renderSwaps(); return; }
      if (a === 'accept-all' || a === 'accept-group') { const G = ['Package', 'Deep search', 'Fix gaps', 'Upgrades', 'Budget'], sh = X.shownNow || X.impact.filter(worth); const list = compatible(a === 'accept-all' ? G.flatMap(g => sh.filter(p => p.group === g)) : sh.filter(p => p.group === b.dataset.g)); if (!list.length) return; document.querySelectorAll('#anSwaps button').forEach(x => { x.disabled = true; }); await acceptMany(list); anStale(); if (App.anSource !== 'paste') renderAll(); if (App.tab !== 'changes') App.tab = 'analysis'; renderView(); if (App.tab !== 'changes') runAnalysis(); return; }
      if (a === 'accept') { App.acceptNote = ''; const p = X.impact[+b.dataset.i]; if (!p) return; b.disabled = true; await applyChange(p.cut, p.add); (App.accepted = App.accepted || []).push({ cut: p.cut, add: p.add, src: App.anSource }); anStale(); if (App.anSource !== 'paste') renderAll(); if (App.tab !== 'changes') App.tab = 'analysis'; renderView(); if (App.tab !== 'changes') runAnalysis(); return; }
      if (a === 'undo') { const i = +b.dataset.i, r = App.accepted[i]; if (!r) return; await applyChange(r.add, r.cut); App.accepted.splice(i, 1); anStale(); if (App.anSource !== 'paste') renderAll(); if (App.tab !== 'changes') App.tab = 'analysis'; renderView(); if (App.tab !== 'changes') runAnalysis(); }
    });
    $('view').addEventListener('change', e => {
      const T = App.CT; if (!T || !T.res) return;
      const a = e.target.closest('[data-ctadd]'); if (a) { if (a.checked) T.sel.add(a.dataset.ctadd); else { T.sel.delete(a.dataset.ctadd); delete T.cutOv[a.dataset.ctadd]; } T.whole = null; return renderCats(); }
      const c = e.target.closest('[data-ctcut]'); if (c) { T.cutOv[c.dataset.ctcut] = c.value; T.whole = null; return renderCats(); }
    });
    $('view').addEventListener('change', e => { if (e.target.id === 'anGames') { App.anGames = +e.target.value; try { localStorage.setItem('edhgen.anGames', String(App.anGames)); } catch (x) { } } });
    $('view').addEventListener('click', e => {
      const a = e.target.closest('button[data-cbadd],button[data-cbaddall]'); if (a) return comboAddPanel(a);
      const g = e.target.closest('button[data-cbgo]'); if (g) { g.disabled = true; return comboAddGo(); }
      if (e.target.closest('button[data-cbx]')) document.querySelectorAll('tr.cbpanel').forEach(x => x.remove());
      const ct = e.target.closest('button[data-ct]');
      if (ct) { const k = ct.dataset.ct; if (k === 'pick') return catsRun(ct.dataset.k); if (k === 'measure') return catsMeasure(); if (k === 'apply') { ct.disabled = true; return catsApply(); } }
      const up = e.target.closest('button[data-up]');
      if (up) {
        const k = up.dataset.up;
        if (k === 'amt') { App.upAmt = +up.dataset.v; if ($('upAmt')) $('upAmt').value = ''; return upgradeRun(); }
        if (k === 'run') return upgradeRun();
        if (k === 'apply') { up.disabled = true; return upgradeApply([App.UP.res.swaps[+up.dataset.i]]); }
        if (k === 'apply-all') { up.disabled = true; return upgradeApply(App.UP.res.swaps.filter(x => !x.done)); }
        if (k === 'copy') return copyText(buyList(App.UP.res.swaps.map(x => ({ c: x.add, qty: 1 }))), null, $('upCopyNote'));
      }
    });
    document.querySelector('.results').addEventListener('click', e => { if (e.target.closest('button[data-fill]')) fillDeck(); });
    document.querySelector('.results').addEventListener('click', e => { const b = e.target.closest('button[data-goto]'); if (b) { App.tab = b.dataset.goto; renderView(); window.scrollTo({ top: 0 }); } });
    $('view').addEventListener('click', async e => {
      const b = e.target.closest('button[data-hist]'); if (!b) return;
      const v = b.dataset.hist, h = await histLoad();
      if (v === 'clear') { if (!confirm('Delete all ' + h.length + ' saved decks?')) return; h.length = 0; await IDB.put('history', h); renderHistory(); }
      else if (v === 'del') { const i = h.findIndex(x => x.id === b.dataset.id); if (i >= 0) h.splice(i, 1); await IDB.put('history', h); renderHistory(); }
      else if (v === 'open') histOpen(b.dataset.id);
      else if (v === 'diff') { App.hdiff = true; await renderHistory(); const d = $('hdiff'); if (d) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    });
    // history compare selection, sample hand, commander browser, print
    $('view').addEventListener('change', e => {
      const c = e.target.closest('input[data-hsel]'); if (!c) return;
      let sel = (App.hsel || []).filter(id => id !== c.dataset.hsel); if (c.checked) { sel.push(c.dataset.hsel); if (sel.length > 2) sel = sel.slice(-2); }
      App.hsel = sel; App.hdiff = false; renderHistory();
    });
    $('view').addEventListener('click', e => {
      const b = e.target.closest('button[data-sh]'), t = e.target.closest('button[data-hc]');
      if (b && App.R) { const v = b.dataset.sh, S = App.SH; if (v === 'new') shDeal(0); else if (v === 'mull') shDeal(Math.min(6, (S ? S.mull : 0) + 1)); else if (v === 'draw' && S && S.lib.length) { S.hand.push(S.lib.shift()); S.drawn++; } hidePop(); renderHand(); return; }
      if (t && App.SH && App.SH.need) { e.stopPropagation(); e.preventDefault(); const S = App.SH, c = S.hand.splice(+t.dataset.hc, 1)[0]; if (c) { S.bottom.push(c); S.lib.push(c); S.need--; } hidePop(); renderHand(); }
    });
    wireDiscover();
    $('view').addEventListener('click', e => { const t = e.target.closest('button[data-cb]'); if (!t) return; App.countsB = +t.dataset.cb; if (App.tab === 'analysis') renderAnalysis(); else renderCounts(); });
    let cbrT = 0;
    $('view').addEventListener('input', e => { if (e.target.id === 'cbrQ' && App.cbr) { App.cbr.q = e.target.value; App.cbr.n = 50; clearTimeout(cbrT); cbrT = setTimeout(renderCmdResults, 150); } });
    $('view').addEventListener('change', e => { const F = App.cbr, k = { cbrMode: 'mode', cbrTheme: 'theme', cbrSort: 'sort' }[e.target.id]; if (F && k) { F[k] = e.target.value; F.n = 50; renderCmdResults(); } });
    $('view').addEventListener('click', e => {
      const col = e.target.closest('button[data-col]'), use = e.target.closest('button[data-cuse]'), more = e.target.closest('button[data-cmore]'), pr = e.target.closest('button[data-print]'), F = App.cbr;
      if (col && F) { const x = col.dataset.col; F.cols = F.cols.includes(x) ? F.cols.replace(x, '') : F.cols + x; col.setAttribute('aria-pressed', F.cols.includes(x)); F.n = 50; renderCmdResults(); }
      else if (more && F) { F.n += 50; renderCmdResults(); }
      else if (use) {
        App.S.commanders = [use.dataset.cuse, '']; writeForm(App.S); persistSettings(); checkCommanders();
        App.tab = 'setup'; renderView(); window.scrollTo({ top: 0 }); setStatus(use.dataset.cuse + ' set as commander. Choose a budget and plan, then Generate deck.');
      }
      else if (pr) pr.dataset.print === 'proxies' ? printProxies() : printPrimer();
    });
    $('view').addEventListener('click', e => { const b = e.target.closest('button[data-jump]'), t = b && $(b.dataset.jump); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    // collection: the list (Collection page), how it is used (Start tile, Collection page) and the Improve header switch
    const saveOwn = t => {
      App.ownDraft = null;
      if (t === App.S.owned.list) { App.collNote = 'No change.'; renderView(); return; }
      App.S.owned.list = t; persistSettings();
      const o = ownedCards(); App.collNote = o ? 'Saved: ' + o.set.size.toLocaleString() + ' cards recognised' + (o.miss ? ', ' + o.miss + ' not found' : '') + '.' : 'Saved.';
      ownChanged();
    };
    document.querySelector('.results').addEventListener('click', e => {
      const m = e.target.closest('button[data-ownmode]'); if (m) { setOwnMode(m.dataset.ownmode); return; }
      const b = e.target.closest('[data-own]'); if (!b) return;
      const v = b.dataset.own;
      if (v === 'all' || v === 'only') { if (ownOnly() === (v === 'only')) return; setOwnMode(v === 'only' ? 'only' : LS.get('edhgen.ownPrev') || 'off'); }
      else if (v === 'save') saveOwn($('collList') ? $('collList').value : App.S.owned.list);
      else if (v === 'clear') { if (confirm('Clear your collection list?')) saveOwn(''); }
      else if (v === 'buy') { const D = deckOwned(); if (D) copyText(buyList(D.miss), null, $('buyNote')); }
    });
    document.querySelector('.results').addEventListener('input', e => { if (e.target.id === 'collList') { App.ownDraft = e.target.value; App.collNote = ''; } });
    document.querySelector('.results').addEventListener('change', async e => { if (e.target.id !== 'ownFile') return; const f = e.target.files[0]; if (!f) return; saveOwn(await f.text()); });
    // links between pages from the step tiles, the Start tiles and the page headers
    for (const id of ['pageHead', 'setupView']) $(id).addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); go(g.dataset.go); } });
    $('view').addEventListener('click', e => { const b = e.target.closest('button[data-ansub]'); if (!b) return; App.anSub = b.dataset.ansub; try { localStorage.setItem('edhgen.anSub', App.anSub); } catch (x) { } renderAnalysis(); });
    $('view').addEventListener('click', e => {
      const b = e.target.closest('button[data-an]'); if (!b) return;
      const a = b.dataset.an;
      if (a === 'src-deck' || a === 'src-paste' || a === 'src-compare') { App.anSource = a.slice(4) === 'deck' ? 'deck' : a.slice(4); App.AN = null; renderAnalysis(); if (App.anSource === 'deck' && App.R) runAnalysis(); }
      else if (a === 'run') runAnalysis();
      else if (a === 'swaps') { App.recsShown = true; const X = App.AN; if (X && X.held) { X.held = false; renderAnalysis(); scoreSwaps(X); } }
      else if (a === 'adv') { App.anAdv = !App.anAdv; try { localStorage.setItem('edhgen.anAdv', App.anAdv ? '1' : ''); } catch (x) { } renderAnalysis(); }
    });
    // deck edits: from the swap rows in the list, or from a card's popover anywhere
    const deckAct = async e => {
      const b = e.target.closest('button[data-act]'); if (!b || !App.R) return;
      const entry = App.R.deck[+b.dataset.i]; if (!entry) return;
      const act = b.dataset.act; hidePop();
      if (act === 'lock') { entry.locked = !entry.locked; entry.imp = false; renderView(); }
      else if (act === 'swap') { App.openSwap = App.openSwap === entry ? null : entry; if (App.tab !== 'deck' && App.tab !== 'role') App.tab = viewOf('cards'); renderView(); }
      else if (act === 'use') { const alt = App.R.alternatives(entry, 5)[+b.dataset.j]; if (alt) { const cut = entry.c.n; await App.R.replace(entry, alt.c, true); histOp({ op: 'replace', cut, add: alt.c.n, locked: true }); App.QS = null; App.openSwap = null; renderAll(); histPush('edit', cut + ' → ' + alt.c.n); } }
      else if (act === 'remove') { const cut = entry.c.n; const ne = await App.R.remove(entry); histOp({ op: 'remove', cut }); App.QS = null; App.openSwap = null; renderAll(); histPush('edit', 'Removed ' + cut + (ne && ne.c ? ' → ' + ne.c.n : '')); }
      if (act === 'use' || act === 'remove') { if (App.anSource !== 'paste') App.AN = null; }
    };
    $('view').addEventListener('click', deckAct); $('cardPop').addEventListener('click', e => { if (e.target.closest('button[data-act]')) { e.stopPropagation(); deckAct(e); } });
    $('saveSet').addEventListener('click', () => saveFile('edh-settings.json', JSON.stringify(readForm(), null, 2), $('idbNote')));
    $('loadSet').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { applySettings(JSON.parse(await f.text())); setStatus('Settings loaded.'); checkCommanders(); } catch (err) { setStatus('Settings file error: ' + err.message); } });
    $('copyTok').addEventListener('click', () => copyText($('shareTok').value, $('shareTok'), null));
    $('applyTok').addEventListener('click', async () => { try { applySettings(await decodeSettings($('shareTok').value)); setStatus('Token applied.'); checkCommanders(); } catch (err) { setStatus('Token error: ' + err.message); } });
    $('resetSet').addEventListener('click', () => { applySettings({}); setStatus('Defaults restored.'); });
    // appearance: mode, accent colour, text size, heading font (stored per browser)
    let AP = { mode: 'system', accent: '', size: '1', head: 'serif', img: 'off' };
    try { AP = Object.assign(AP, JSON.parse(LS.get('edhgen.appearance') || '{}')); } catch (e) { }
    const legacy = LS.get('edhgen.theme'); if (legacy && !LS.get('edhgen.appearance')) AP.mode = legacy;
    const root = document.documentElement;
    const applyAP = () => {
      if (AP.mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', AP.mode);
      if (AP.accent) root.setAttribute('data-accent', AP.accent); else root.removeAttribute('data-accent');
      root.style.setProperty('--fz', AP.size); root.setAttribute('data-headings', AP.head); App.img = AP.img;
      for (const [id, k] of [['apMode', 'mode'], ['apAccent', 'accent'], ['apSize', 'size'], ['apHead', 'head'], ['apImg', 'img']]) $(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === String(AP[k])));
    };
    applyAP();
    for (const [id, k] of [['apMode', 'mode'], ['apAccent', 'accent'], ['apSize', 'size'], ['apHead', 'head'], ['apImg', 'img']])
      $(id).addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (!b) return; AP[k] = b.dataset.v; applyAP(); LS.set('edhgen.appearance', JSON.stringify(AP)); if (k === 'img' && App.tab === 'hand') renderHand(); });
    $('clearBtn').addEventListener('click', () => {
      if (App.busy) return;
      if (!confirm('Start over? This clears the current deck and all settings. History, card data and appearance are kept.')) return;
      App.R = null; App.AN = null; App.QS = null; App.PR = null; App.SH = null; App.hsel = []; App.hdiff = false; App.chain = null; App.accepted = []; App.denied = new Set(); App.anText = ''; App.anSource = 'deck'; App.openSwap = null; App.cbQ = ''; App.cbN = '';
      applySettings({}); try { history.replaceState(null, '', location.pathname + location.search); } catch (x) { }
      showMsgs([], []); App.tab = 'setup'; renderAll(); setStatus('Cleared. Pick a commander to start a new deck.'); window.scrollTo({ top: 0 });
      $('cmd1').focus();
    });
    const pop = $('appearance'), setPop = open => { pop.classList.toggle('hidden', !open); $('themeBtn').setAttribute('aria-expanded', open); };
    $('themeBtn').addEventListener('click', e => { e.stopPropagation(); setPop(pop.classList.contains('hidden')); });
    document.addEventListener('click', e => { if (!pop.classList.contains('hidden') && !e.target.closest('.popwrap')) setPop(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setPop(false); });
    // card popover: hover (mouse) or click/tap any card name
    const fine = matchMedia('(hover: hover) and (pointer: fine)');
    document.addEventListener('mouseover', e => {
      if (!fine.matches || popPinned) return;
      const el = e.target.closest('[data-card]'); clearTimeout(popT);
      if (el) { if (el !== popFor) popT = setTimeout(() => showPop(el), 220); }
      else if (!e.target.closest('#cardPop')) popT = setTimeout(hidePop, 120);
    });
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-card]');
      if (el && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); if (popFor === el && popPinned) hidePop(); else showPop(el, true); return; }
      if (!e.target.closest('#cardPop') || e.target.closest('[data-popx]')) hidePop();
    });
    addEventListener('scroll', () => { if (!popPinned) hidePop(); }, { passive: true });
    $('undoBtn').addEventListener('click', undoLast);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { hidePop(); document.querySelectorAll('tr.cbpanel').forEach(x => x.remove()); return; }
      const tg = e.target; if (e.altKey || (tg && (tg.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(tg.tagName)))) return;
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k.toLowerCase() === 'z') { if (App.chain && App.chain.ops.length) { e.preventDefault(); undoLast(); } return; }
      if (e.ctrlKey || e.metaKey) return;
      const tabs = [...document.querySelectorAll('.tabs button[data-page]')];
      if (/^[1-9]$/.test(k)) { const b = tabs[+k - 1]; if (b) { e.preventDefault(); b.click(); } }
      else if (k === 'g' || k === 'G') { if (!$('genBtn').disabled) { e.preventDefault(); $('genBtn').click(); } }
      else if (k === 'u' || k === 'U') { if (App.chain && App.chain.ops.length) { e.preventDefault(); undoLast(); } }
      else if (k === '/') { e.preventDefault(); let f = $('cbQ') || $('cbrQ'); if (!f || f.offsetParent === null) { App.tab = 'setup'; renderView(); f = $('cmd1'); } f.focus(); }
      else if (k === '?') { e.preventDefault(); setStatus(KEYS_HELP); }
    });
    App.anGames = +(LS.get('edhgen.anGames') || 100000); App.anSub = LS.get('edhgen.anSub') || 'turns'; App.anAdv = !!LS.get('edhgen.anAdv');
    setupAC('cmd1', 'cmd1L'); setupAC('cmd2', 'cmd2L');
    wireQuick(); syncQuick(App.S);
  }
  function fillStatic() {
    const sel = $('archetype');
    for (const [k, t] of Object.entries(Engine.TAGS)) { const o = document.createElement('option'); o.value = k; o.textContent = t.label; sel.appendChild(o); }
    $('tagNote').textContent = 'Comma-separated. Any creature type in the data, a theme name, or o:text to match rules text. The commander\'s own text adds matching themes automatically.';
    const rows = [];
    for (const role of Engine.ROLES) for (const r of Engine.ROLE_RULES[role]) rows.push([Engine.SLOT_LABEL[role], r.id, r.desc]);
    for (const [k, f] of Object.entries(Engine.FLAGS)) rows.push(['Flag', k, f.desc]);
    for (const [k, d] of Object.entries(Engine.LAND_CLASS_DESC)) rows.push(['Land class', k, d]);
    for (const [k, t] of Object.entries(Engine.TAGS)) rows.push(['Synergy tag', k, (t.re ? 'oracle /' + t.re.source + '/' : '') + (t.type ? ' or type /' + t.type.source + '/' : '') + (t.flag ? 'flag ' + t.flag : '')]);
    $('rulesRef').innerHTML = '<table class="t"><tbody>' + rows.map(r => '<tr><td>' + esc(r[0]) + '</td><td class="mono">' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>').join('') + '</tbody></table>';
  }

  async function init() {
    fillStatic();
    let S = null;
    const hash = (location.hash || '').slice(1);
    if (hash && /^[zj][A-Za-z0-9_-]+$/.test(hash)) { try { S = await decodeSettings(hash); setStatus('Settings loaded from link.'); } catch (e) { } }
    if (!S) { try { const raw = LS.get('edhgen.settings'); if (raw) S = JSON.parse(raw); } catch (e) { } }
    App.S = deepAssign(uiDefaults(), S || {});
    if (!S || S.weightsV !== 3) { App.S.weights = uiDefaults().weights; App.S.variance = 0; App.S.reroll = 0; App.S.weightsV = 3; } // v2: weights recalibrated on real data; v3: no random variance, so a rebuild is identical
    if (App.S.bl && ({ 1: 2, 2: 3, 3: 6 })[App.S.bracket] === +App.S.bl.tutor) App.S.bl.tutor = 999; // old defaults; tutor limits were removed Oct 21 2025
    writeForm(App.S); updateShareToken();
    if (/^(easy|normal)$/i.test(hash)) { try { history.replaceState(null, '', location.pathname + location.search); } catch (x) { } } // old Easy / Normal links
    wire();
    renderSources(); renderAll();
    autoload();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
