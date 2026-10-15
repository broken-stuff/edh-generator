/* ===== App: data loading, UI, exports ===== */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const uiDefaults = () => { const d = Engine.defaults(); delete d.apiPages; return d; };
  const App = { S: uiDefaults(), bulk: null, bulkCombos: null, R: null, tab: 'deck', groupBy: 'type', openSwap: null, busy: false, tests: null, cmdIndex: null };
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
  async function loadBulk(file, extra) {
    const prog = $('bulkProg'); prog.classList.remove('hidden');
    setStatus('Reading ' + file.name + '…');
    try {
      const { cards, parsed } = await parseBulkFile(file, f => { prog.firstElementChild.style.width = (f * 100).toFixed(0) + '%'; });
      if (!cards.length) throw new Error('No Scryfall card objects found (' + parsed + ' records parsed).');
      const meta = { source: 'Scryfall bulk file', ...(extra || {}), file: file.name, fileModified: file.lastModified ? new Date(file.lastModified).toISOString() : null, loadedAt: new Date().toISOString(), records: parsed };
      App.bulk = Engine.buildDB(cards, meta); App.cmdIndex = null; $('secData').open = false;
      setStatus('Loaded ' + App.bulk.all.length + ' unique cards from ' + file.name + '.');
      IDB.put('bulk', { cards, meta }).then(ok => { $('idbNote').textContent = ok ? 'Stored in this browser for next visit.' : ''; });
    } catch (e) { setStatus('Bulk file error: ' + e.message); showMsgs([e.message], []); }
    prog.classList.add('hidden'); renderSources();
  }
  /* ---------- data in the site's repo (GitHub Pages): data/cards.json[.gz], data/combos.json[.gz] ----------
     Reloads only when the file's ETag / Last-Modified changes; otherwise uses the copy stored in this browser. */
  async function repoFile(names) {
    if (!window.EDH_SITE || !/^https?:$/.test(location.protocol)) return null; // only the GitHub Pages build sets EDH_SITE
    for (const n of names) {
      try { const h = await fetch(n, { method: 'HEAD', cache: 'no-cache' }); if (h.ok) return { url: n, tag: h.headers.get('etag') || h.headers.get('last-modified') || '', size: +h.headers.get('content-length') || 0 }; } catch (e) { }
    }
    return null;
  }
  async function fromRepo(f, loader) {
    const res = await fetch(f.url, { cache: 'no-cache' }); if (!res.ok || !res.body) throw new Error(f.url + ': HTTP ' + res.status);
    const gz = /\.gz$/.test(f.url);
    if (gz && typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unzip ' + f.url);
    const body = gz ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
    let used = false;
    const src = { name: f.url, size: gz ? f.size * 7 : f.size, stream: () => { used = true; return body; }, text: () => used ? Promise.resolve('[]') : new Response(body).text() };
    await loader(src, { source: 'site data', tag: f.tag });
  }
  async function autoload() {
    const bulk = await IDB.get('bulk');
    const rc = await repoFile(['data/cards.json.gz', 'data/cards.json']);
    const fresh = (stored, f) => stored && stored.meta && f && f.tag && stored.meta.tag === f.tag;
    if (rc && !fresh(bulk, rc)) { try { await fromRepo(rc, loadBulk); } catch (e) { setStatus('Site card data: ' + e.message); } }
    if (!App.bulk && bulk && bulk.cards && bulk.cards.length) { App.bulk = Engine.buildDB(bulk.cards, bulk.meta); $('idbNote').textContent = 'Using stored card data: ' + (bulk.meta.file || '') + '.'; }
    renderSources(); renderView();
  }

  /* ---------- data state ---------- */
  function comboProvider() { return App.bulkCombos || null; }
  function renderSources() {
    const set = (id, cls, text) => { const el = $(id); el.innerHTML = '<span class="dot ' + cls + '"></span>' + esc(text); };
    set('pBulk', App.bulk ? 'ok' : '', 'Cards: ' + (App.bulk ? App.bulk.all.length.toLocaleString() + ' (' + (App.bulk.meta.file || 'stored') + ')' : 'not loaded'));
    $('dataHint').textContent = App.bulk ? 'loaded' : 'load a file';
    if (!App.bulk) $('secData').open = true;
    $('genBtn').disabled = App.busy || !App.bulk;
    $('testBtn').disabled = App.busy || !App.bulk;
    if (!App.R && App.tab === 'deck') renderView();
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
    if ($('qPlanNote')) $('qPlanNote').textContent = P ? P.t.lands + ' lands · ' + P.t.ramp + ' ramp · ' + P.t.draw + ' draw · ' + P.t.removal + ' removal · ' + P.t.wipes + ' wipe' + (P.t.wipes === 1 ? '' : 's') + ' · avg MV ' + P.mv.toFixed(1) + '. Sets Category targets; edit them under Fine-tune.' : '';
    const tags = new Set(tagList(S).map(t => t.toLowerCase()));
    document.querySelectorAll('#qThemes button').forEach(b => b.setAttribute('aria-pressed', String(tags.has(b.dataset.tag))));
    const qb = $('qBudget'); if (qb) { const v = S.budget && S.budget.total != null && S.budget.total !== '' ? String(+S.budget.total) : ''; qb.value = [...qb.options].some(o => o.value === v) ? v : 'custom'; }
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
    $('qBudget').addEventListener('change', e => { const v = e.target.value; if (v === 'custom') return; App.S.budget.total = v === '' ? '' : +v; writeForm(App.S); persistSettings(); });
    $('qGen').addEventListener('click', () => { $('genBtn').click(); if (window.matchMedia('(max-width: 720px)').matches) document.querySelector('.results').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }
  function onFormChange(ev) {
    const el = ev.target; if (!el.dataset || !el.dataset.k) return;
    setPath(App.S, el.dataset.k, readEl(el));
    if (el.id === 'bracket') { App.S.bl = Engine.bracketDefaults(App.S.bracket); writeForm(App.S); }
    if (el.id === 'variance') $('varOut').textContent = (+App.S.variance).toFixed(2);
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
    return esc(mc).replace(/\{([^}]+)\}/g, (m, s) => { const cols = s.split('/').filter(x => 'WUBRG'.includes(x)); const cls = cols.length === 1 ? cols[0] : ''; return '<span class="ms ' + cls + '">' + s.replace('/', '') + '</span>'; });
  }
  const fmtP = (v) => Engine.fmt(v, App.R ? App.R.settings.budget.cur : App.S.budget.cur);
  function setStatus(t) { $('status').textContent = t || ''; }
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

  /* ---------- analysis tab ---------- */
  function analysisInput() {
    if (App.anSource === 'paste') {
      if (!App.bulk) return { error: 'Load the Scryfall bulk file first.' };
      const P = Analysis.parseDecklist(App.anText || '');
      let cmdNames = P.cmd.map(x => x.name);
      if (!cmdNames.length) cmdNames = App.S.commanders.map(s => (s || '').trim()).filter(Boolean);
      const unknown = [], cmds = [], deck = [];
      for (const n of cmdNames) { const c = Engine.lookup(App.bulk, n); if (c) cmds.push(c); else unknown.push(n); }
      for (const it of P.main) { const c = Engine.lookup(App.bulk, it.name); if (!c) { unknown.push(it.name); continue; } if (cmds.includes(c)) continue; const ex = deck.find(e => e.c === c); if (ex) ex.qty += it.qty; else deck.push({ c, qty: it.qty }); }
      if (!cmds.length) return { error: 'No commander found. Put it under a "Commander" header, tag it [Commander], or fill the Commander field in settings.', unknown };
      if (!deck.length) return { error: 'Decklist is empty.', unknown };
      return { deck, cmds, unknown, label: 'Pasted list' };
    }
    if (!App.R || !App.R.stats) return { error: 'Generate a deck first, or switch to "Pasted list".' };
    return { deck: App.R.deck, cmds: App.R.commanders, unknown: [], label: 'Generated deck', combos: App.R.combos };
  }
  const anGames = () => { const g = +App.anGames || 100000; return [1500, 10000, 25000, 50000, 100000].includes(g) ? g : 100000; };
  async function runAnalysis() {
    const inp = analysisInput();
    if (inp.error) { App.AN = { error: inp.error, unknown: inp.unknown || [] }; renderAnalysis(); return; }
    const key = App.anSource + '|' + inp.cmds.map(c => c.n).join('+') + '|' + inp.deck.map(e => e.qty + e.c.n).join(',') + '|' + JSON.stringify(App.S.targets) + App.S.bracket + '|' + anGames() + '|' + JSON.stringify(App.S.budget) + '|' + [...(App.denied || [])].join(',');
    if (App.AN && App.AN.key === key) { renderAnalysis(); return; }
    setStatus('Analyzing (' + anGames().toLocaleString() + ' simulated games)…'); await new Promise(r => setTimeout(r, 30));
    let combos = inp.combos || null, almost = null;
    const cp = comboProvider();
    if (cp) {
      const names = inp.cmds.map(c => c.n).concat(inp.deck.map(e => e.c.n));
      try {
        if (!combos || App.anSource === 'paste') combos = await cp.find(names, inp.cmds.map(c => c.n));
        const CI = 'WUBRG'.split('').filter(x => inp.cmds.some(c => c.ci.includes(x))).join('');
        const poolNames = App.bulk.all.filter(c => c.leg === 'legal' && [...c.ci].every(x => CI.includes(x))).map(c => c.n);
        almost = (await cp.almost(names, poolNames)).filter(x => x.missing.length === 1).slice(0, 8).map(x => ({ cards: x.v.c, missing: x.missing, produces: x.v.p }));
      } catch (e) { }
    }
    const t0 = performance.now();
    App.denied = App.denied || new Set();
    const X = Analysis.run(App.bulk, inp.deck, inp.cmds, { settings: App.S, combos, almost, games: anGames(), deny: [...App.denied] });
    X.inp = inp;
    X.key = key; X.label = inp.label; X.unknown = inp.unknown; X.cmds = inp.cmds; X.comboLoaded = !!cp;
    App.AN = X;
    setStatus('Analysis done in ' + ((performance.now() - t0) / 1000).toFixed(2) + ' s (' + X.sim.games.toLocaleString() + ' simulated games).');
    X.impact = []; X.impactDone = !X.plans.length;
    renderAnalysis();
    if (!X.plans.length) return;
    // swap impact: one plan per tick so the page stays responsive
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
      if (App.tab === 'analysis') renderSwaps();
    }
    X.impactDone = true; setStatus('Analysis done; ' + X.plans.length + ' changes evaluated.');
    if (App.tab === 'analysis') renderSwaps();
  }
  // apply one swap to the analysed list: the generated deck (validated, locked) or the pasted text
  async function applyChange(cut, add) {
    if (App.anSource !== 'paste' && App.R) {
      const entry = App.R.deck.find(e => e.c === cut); if (!entry) { setStatus(cut.n + ' is no longer in the deck.'); return; }
      await App.R.swapOne(entry, add); setStatus('Swapped ' + cut.n + ' → ' + add.n + ' (locked).'); return;
    }
    const inp = App.AN && App.AN.inp; if (!inp) return;
    const deck = Analysis.applySwap(inp.deck, cut, add);
    App.anText = 'Commander\n' + inp.cmds.map(c => '1 ' + c.n).join('\n') + '\n\nDeck\n' + deck.map(e => (e.qty || 1) + ' ' + e.c.n).join('\n');
    setStatus('Swapped ' + cut.n + ' → ' + add.n + ' in the pasted list.');
  }
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
    const groups = ['Fix gaps', 'Upgrades', 'Budget'];
    const head = '<div class="an-top"><h3>Recommended changes</h3><span class="note">' + (X.impactDone ? X.impact.length + ' evaluated' : 'evaluating ' + X.impact.length + '/' + X.plans.length + '…') + '</span></div>';
    const log = (App.accepted || []).filter(a => a.src === App.anSource);
    const logHTML = log.length ? '<div class="accepted"><span class="note">Accepted:</span> ' + log.map((a, j) => '<span class="chip">− ' + esc(a.cut.n) + ' + ' + esc(a.add.n) + ' <button type="button" class="link" data-sw="undo" data-i="' + (App.accepted.indexOf(a)) + '" aria-label="Undo">undo</button></span>').join(' ') + '</div>' : '';
    const denN = App.denied && App.denied.size ? '<span class="note"> · ' + App.denied.size + ' denied <button type="button" class="link" data-sw="clear-deny">reset</button></span>' : '';
    if (!X.plans.length) return head + logHTML + denN + '<p class="note">No changes suggested: targets are met and no costly card has a cheaper same-role replacement in the loaded data.</p>';
    const rows = g => X.impact.filter(p => p.group === g).map(p => {
      const d = p.d, eff = [];
      for (const [k, v] of d.src || []) eff.push('<span class="' + cls(v) + '">' + k + ' land sources ' + sign(v) + '</span>');
      if (d.warn) eff.push('<span class="' + cls(-d.warn) + '">Colors flagged ' + sign(d.warn) + '</span>');
      if (d.pl) eff.push('<span class="' + cls(d.pl) + '">Power ' + sign(d.pl, 1) + '</span>');
      if (d.fund) eff.push('<span class="' + cls(d.fund) + '">Fundamentals ' + sign(d.fund) + '</span>');
      for (const [k, v] of d.vectors) eff.push('<span class="' + cls(v) + '">' + VL[k] + ' ' + sign(v) + '</span>');
      for (const [k, v] of d.axes) if (!['speed', 'consistency', 'interaction'].includes(k)) eff.push('<span class="' + cls(v) + '">' + esc(AL[k] || k) + ' ' + sign(v) + '</span>');
      if (Math.abs(d.keep) >= 0.005) eff.push('<span class="' + cls(d.keep) + '">Keepable 7 ' + sign(d.keep * 100, 1) + ' pts</span>');
      if (Math.abs(d.t4) >= 0.05) eff.push('<span class="' + cls(d.t4) + '">T4 mana ' + sign(d.t4, 2) + '</span>');
      if (d.typical) eff.push('<span class="' + cls(-d.typical) + '">Typical win T' + p.after.typical + '</span>');
      if (d.minB) eff.push('<span class="warn-t">Min. bracket → ' + p.after.minB + '</span>');
      const price = p.priceKnown ? '<span class="' + (p.dPrice > 0.005 ? 'pup' : p.dPrice < -0.005 ? 'pdown' : '') + '">' + (p.dPrice > 0.005 ? '▲ ' : p.dPrice < -0.005 ? '▼ ' : '') + money(p.dPrice) + '</span>' : '<span class="note">price n/a</span>';
      const i = X.impact.indexOf(p);
      const acts = '<div class="sw-acts"><button type="button" class="small primary" data-sw="accept" data-i="' + i + '">Accept</button><button type="button" class="small" data-sw="deny" data-i="' + i + '">Deny</button></div>';
      return '<tr><td><div class="sw"><span class="out">− ' + esc(p.cut.n) + '</span><span class="in">+ ' + (p.add.uri ? '<a href="' + esc(p.add.uri) + '" target="_blank" rel="noopener">' + esc(p.add.n) + '</a>' : esc(p.add.n)) + '</span></div><div class="note">' + esc(p.reason) + (p.tag ? ' · ' + esc(p.tag) : '') + '</div></td><td class="n nw">' + price + '</td><td><div class="eff">' + (eff.length ? eff.join(' ') : '<span class="note">no measurable change</span>') + '</div>' + acts + '</td></tr>';
    }).join('');
    return head + logHTML + denN + groups.filter(g => X.plans.some(p => p.group === g)).map(g => '<h4 class="an-sub">' + g + (g === 'Upgrades' ? ' (weakest power vectors)' : g === 'Budget' ? ' (cheaper card, same role or theme)' : '') + '</h4><div class="scroll"><table class="t compact swaps"><thead><tr><th>Change</th><th class="n">Price</th><th>Projected effect</th></tr></thead><tbody>' + (rows(g) || '<tr><td colspan="3" class="note">evaluating…</td></tr>') + '</tbody></table></div>').join('') +
      '<p class="note">Each change is applied alone and the whole analysis is re-run with 5,000 simulated games on the same shuffles as the current list, so differences come from the swap, not from random variation. Cuts are the lowest-value cards whose removal keeps every role at or above target (value = synergy links + 2×roles + Game Changer/fast/tutor bonus + EDHREC popularity). Adds come from the loaded card data within your color identity, bracket limits and per-card budget cap. Price is the difference in ' + cur.toUpperCase() + ' between the added and removed card.</p>';
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
  function renderAnalysis() {
    const X = App.AN;
    const src = '<div class="row an-src"><div class="seg" role="radiogroup" aria-label="Analyze"><button type="button" data-an="src-deck" aria-pressed="' + (App.anSource !== 'paste') + '">Generated deck</button><button type="button" data-an="src-paste" aria-pressed="' + (App.anSource === 'paste') + '">Pasted list</button></div><label class="f inline">Simulated games <select id="anGames">' + [1500, 10000, 25000, 50000, 100000].map(g => '<option value="' + g + '"' + (g === anGames() ? ' selected' : '') + '>' + g.toLocaleString() + '</option>').join('') + '</select></label><button type="button" class="primary small" data-an="run">Analyze</button></div>' +
      (App.anSource === 'paste' ? '<label class="f" style="margin-top:8px">Decklist (Moxfield, Archidekt, MTGO or plain "1 Name"; commander under a "Commander" header or tagged [Commander])<textarea id="anText" rows="8" spellcheck="false">' + esc(App.anText || '') + '</textarea></label>' : '');
    if (!X) { $('view').innerHTML = src + '<p class="note" style="margin-top:10px">Scores speed, mana, card advantage, interaction, resilience, synergy, consistency and win pressure from card data, exact probabilities and a seeded goldfish simulation. Runs entirely in this page.</p>'; return; }
    if (X.error) { $('view').innerHTML = src + '<div class="msg err" style="margin-top:10px">' + esc(X.error) + (X.unknown && X.unknown.length ? '<br>Unknown names: ' + esc(X.unknown.join(', ')) : '') + '</div>'; return; }
    const s = X.sim, b = X.bracket;
    const head = '<div class="summary an-head">' + [
      ['Power level', '<span class="big">' + X.power.pl.toFixed(1) + '</span><span class="note"> ±' + X.power.ci.toFixed(1) + '</span>'],
      ['Fundamentals', X.overall + '<span class="note"> / 100</span>'],
      ['Commander', X.cmds.map(c => esc(c.n)).join(' + ') + ' ' + pipsHTML(X.CI)],
      ['Min. bracket', String(X.power.minBracket)],
      ['Win turn', 'T' + X.power.win.best + ' / T' + X.power.win.typical + ' / T' + X.power.win.contested],
      ['Cards', X.deckSize + X.cmds.length + (X.deckSize + X.cmds.length !== 100 ? ' <span class="st fail">≠100</span>' : '')],
      ['Avg MV', X.avgMV.toFixed(2)],
      ['Commander turn (median)', s.cmdMedianTurn > 8 ? '>8' : 'T' + s.cmdMedianTurn]
    ].map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>' +
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
      '<tr><td>Win turn</td><td class="n">T' + P.win.best + ' / T' + P.win.typical + ' / T' + P.win.contested + '</td><td class="why">best / typical / contested' + (P.win.comboTurn ? '; fastest combo castable T' + P.win.comboTurn : '') + '</td></tr>' +
      '<tr><td>Recommended minimum bracket</td><td class="n">' + P.minBracket + '</td><td class="why">' + esc(P.minBracketWhy.join('; ')) + '</td></tr>' +
      '<tr><td>Uncertainty from</td><td></td><td class="why">' + esc(P.ciParts.join(', ')) + '</td></tr>' +
      '<tr><td>EDHREC rank of nonland cards</td><td></td><td class="why">' + P.quality.map(q => esc(q.label) + ': ' + q.n).join(' · ') + ' (popularity, not power)</td></tr>' +
      '</tbody></table></div>' +
      '<div class="an-grid">' + vecRows + '</div>' +
      '<div class="an-card wide"><h3>Combos (' + P.combos.length + ' lines, ' + P.families.length + ' families)</h3>' + comboRows + '<p class="note">Family = combos sharing a card; family value = best line + 25% of the rest, capped at 1.5× best. Line value = compactness (2 cards 1.0, 3 cards 0.7, 4 cards 0.45) × outcome (win 1.0, infinite resource 0.75, lock 0.45, value 0.3). Early = all pieces castable by turn 5 using simulated mana from two consecutive turns.</p></div>';
    const goldfish = '<div class="an-card"><h3>Goldfish simulation</h3>' + manaLineSVG(s) + '<p class="note">Average mana available at the start of each turn (line) against one land per turn (dashed). ' + s.games.toLocaleString() + ' seeded games; simulated percentages carry a 95% margin of at most ±' + (196 * Math.sqrt(0.25 / s.games)).toFixed(2) + ' points.</p><table class="t compact"><tbody>' +
      [['Keepable 7 (2–5 lands)', pct(s.keep7) + ' sim · ' + pct(X.prob.openingLands.p2to5) + ' exact'], ['Opening 7 with ≥3 lands (exact)', pct(X.prob.openingLands.p3plus)], ['≥1 ramp at MV ≤2 by turn 2 (exact)', pct(X.prob.pRampEarly) + ' (' + X.prob.nRamp2 + ' cards)'], ['Missed natural land drop by T4', pct(s.missLandDropT4)], ['Flooded at T6 (≥3 lands, ≤1 spell in hand)', pct(s.flood6)], ['Stuck on ≤3 lands at T6', pct(s.screw6)], ['Commander cast by its MV turn (MV ' + s.cmdCmc + ')', s.cmdOnCurve == null ? '—' : pct(s.cmdOnCurve)], ['Mana spent / available, T1–6', pct(s.efficiency6)], ['Spells cast by T6 (avg)', s.spellsBy6.toFixed(1)]]
        .map(r => '<tr><td>' + r[0] + '</td><td class="n">' + r[1] + '</td></tr>').join('') + '</tbody></table></div>';
    const mana = '<div class="an-card"><h3>Mana base</h3><table class="t compact"><thead><tr><th>Color</th><th class="n">Pips</th><th class="n">Pip %</th><th class="n">Land src</th><th class="n">All src</th><th>Check</th></tr></thead><tbody>' +
      X.mana.colors.map(c => '<tr><td>' + pipsHTML(c.color) + '</td><td class="n">' + c.pips.toFixed(1).replace(/\.0$/, '') + '</td><td class="n">' + pct(c.pipShare) + '</td><td class="n">' + c.landSources + '</td><td class="n">' + c.allSources + '</td><td>' + (c.warn ? '<span class="chip flag">' + esc(c.warn) + '</span>' : '<span class="chip">ok</span>') + '</td></tr>').join('') +
      '</tbody></table><p class="note">Lands entering tapped (' + X.mana.tapped.length + '): ' + cardList(X.mana.tapped) + '</p></div>';
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
    const sevLabel = { high: 'High', med: 'Medium', low: 'Low', info: 'Info' };
    const recs = '<div class="an-card wide"><h3>Findings</h3>' + (X.recs.length ? '<ol class="recs">' + X.recs.map(r => '<li><span class="chip sev-' + r.sev + '">' + sevLabel[r.sev] + '</span> ' + esc(r.text) +
      (r.cards.length ? '<div class="recc">' + r.cards.map(c => '<span class="chip">' + (c.uri ? '<a href="' + esc(c.uri) + '" target="_blank" rel="noopener">' + esc(c.n) + '</a>' : esc(c.n)) + (c.price != null ? ' · ' + fmtP(c.price) : '') + (c.rank ? ' · #' + c.rank : '') + '</span>').join('') + '</div>' : '') +
      (r.combos ? '<div class="recc">' + r.combos.map(v => '<span class="chip">+ ' + esc(v.missing.join(', ')) + ' → ' + esc(v.cards.join(' + ')) + (v.produces.length ? ' (' + esc(v.produces[0]) + ')' : '') + '</span>').join('') + '</div>' : '') + '</li>').join('') + '</ol>' : '<p class="note">No gaps against the benchmarks.</p>') + '</div>';
    const method = '<details class="an-method"><summary class="note" style="cursor:pointer">Method and assumptions</summary><ul class="note">' +
      '<li>Role, flag and theme detection use the oracle-text rules listed under Advanced → Tag and flag rules. Themes are enabler/payoff pairs; a link is one card on the opposite side of the same theme (commander counts 3).</li>' +
      '<li>Targets come from your Category targets and target average MV. "avg" next to a target is the mean per deck across EDHREC decklists (<a href="https://edhrec.com/articles/the-deck-of-many-things-card-frequencies-by-type-and-function-across-edh" target="_blank" rel="noopener">EDHREC, Jul 2022</a>: 35.9 lands, 12.7 ramp, 7.6 draw, 8.5 spot removal, 2.7 wipes, 3.0 tutors); it describes what players build, not an optimum. Other targets are heuristics shown next to each factor.</li>' +
      '<li>Color sources: Frank Karsten\'s 99-card figures call for about 19 sources to cast a single-pip card on turn 1 and 30 for a double-pip card on turn 2 at ~90% (<a href="https://scrollvault.net/guides/mana-bases.html" target="_blank" rel="noopener">summary</a>). The color warning here is a looser share-of-pips check.</li>' +
      '<li>Goldfish: seeded, ' + s.games + ' games, no opponents. One free mulligan when the opening 7 has fewer than 2 or more than 5 lands. Draws from turn 2. Each turn it plays an untapped land if possible, casts ramp first, then the commander, then the largest spells that fit. Mana rocks add mana immediately, creatures next turn, land-search ramp adds tapped lands. Colors, rituals and card draw are not modeled.</li>' +
      '<li>Exact probabilities use the hypergeometric distribution over the ' + X.deckSize + '-card library.</li>' +
      '<li>Power model follows the structure documented by <a href="https://scrycheck.com/docs" target="_blank" rel="noopener">ScryCheck</a>: five vectors (speed, consistency, interaction, mana base, threats), combo families from Spellbook, archetype-dependent weights, a strategy ceiling from four signals, a 1–10 scale with ± uncertainty, best/typical/contested win turns and a recommended minimum bracket. ScryCheck does not publish its weights, so every weight and curve here is this tool\'s own, shown on each card, and uncalibrated against labeled decks. Typical win turn maps power to WotC turn expectations (PL 5 → T8, 7 → T6, 8 → T5, 9 → T4). Raw power = 1 + 9·(0.7·vector mix + 0.3·card quality)/100. Card power (0–1) is an oracle-text heuristic: fast mana +0.45, Game Changer +0.35, tutor +0.2–0.35, cheap instant removal +0.3, MV≤1 ramp +0.3, free spells +0.25, cheap repeatable draw +0.2, plus 0.25×EDHREC popularity. Vector components weight each card by 0.6 + card power, so a like-for-like upgrade moves the score. ScryCheck\'s Playgroup.gg anchor, edhtop16 metagame test and per-card power ratings need online data and are not reproduced.</li>' +
      '<li>Bracket estimate: lowest bracket whose card limits (Bracket panel defaults) the list satisfies, per the <a href="https://mtg.wiki/page/Commander_Brackets" target="_blank" rel="noopener">Commander Brackets</a> as updated <a href="https://draftsim.com/mtg-october-2025-commander-bracket-changes/" target="_blank" rel="noopener">Oct 21 2025</a> and <a href="https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026" target="_blank" rel="noopener">Feb 9 2026</a>. Tutors are counted but no longer limit any bracket. Expected game length (B1 9+, B2 8+, B3 6+, B4 4+ turns) and intent are not measurable from card data.</li></ul></details>';
    $('view').innerHTML = src + head + '<div class="an-card wide" id="anSwaps">' + swapsHTML(X) + '</div>' + power + '<h3 class="an-sec">Fundamentals</h3><div class="an-grid top"><div class="an-card">' + '<h3>Profile</h3>' + radarSVG(X.axes) + '</div>' + goldfish + '</div>' + recs + axes + '<div class="an-grid">' + mana + inter + br + '</div>' + synergy + method;
  }

  /* ---------- views ---------- */
  function renderSummary() {
    const R = App.R, el = $('summary');
    if (!R || !R.stats) { el.classList.add('hidden'); return; }
    const s = R.stats, v = R.validation;
    const fails = v.rules.filter(r => r.pass === false).length;
    el.classList.remove('hidden');
    el.innerHTML = [
      ['Commander', R.commanders.map(c => esc(c.n)).join(' + ') + ' ' + pipsHTML(R.CI)],
      ['Cards', (R.commanders.length + R.deck.reduce((a, e) => a + e.qty, 0))],
      ['Total price', fmtP(s.total) + (s.unknown.length ? ' <span class="note">(' + s.unknown.length + ' unpriced)</span>' : '')],
      ['Avg MV', s.avgMV.toFixed(2)],
      ['Bracket', R.settings.bracket + ' · ' + esc(Engine.BRACKETS[R.settings.bracket].name)],
      ['Game Changers', s.gcs.length],
      ['Validation', fails ? '<span class="st fail">' + fails + ' FAIL</span>' : '<span class="st pass">PASS</span>'],
      ['Seed', '<span class="mono">' + esc(R.seedUsed) + '</span>']
    ].map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('');
  }
  function emptyView() {
    if (App.bulk) return '<div class="empty"><h2>Ready</h2><p>' + App.bulk.all.length.toLocaleString() + ' cards loaded from ' + esc(App.bulk.meta.file || 'stored data') + (App.bulkCombos ? ' and ' + App.bulkCombos.count.toLocaleString() + ' combo variants' : '') + '. Enter a commander and press Generate deck.</p></div>';
    return '<div class="empty"><h2>Load card data</h2><p>The generator runs offline from two files you download once.</p>' +
      '<ol><li><b>Scryfall Oracle Cards</b> (or Default Cards) from <a href="https://scryfall.com/docs/api/bulk-data" target="_blank" rel="noopener">scryfall.com/docs/api/bulk-data</a>. Required.</li><li><b>Commander Spellbook variants</b> from <a href="https://json.commanderspellbook.com/variants.json" target="_blank" rel="noopener">json.commanderspellbook.com/variants.json</a>. Optional; enables combo detection and bracket combo limits.</li><li>Load both under Data source. They are parsed in this browser and kept in its storage for the next visit.</li><li>Enter a commander, then Generate deck.</li></ol></div>';
  }
  function deckRows(entries, groupKey) {
    const R = App.R;
    const groups = new Map();
    for (const e of entries) { const k = groupKey(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    let h = '';
    for (const [k, list] of groups) {
      list.sort((a, b) => a.c.cmc - b.c.cmc || (a.c.n < b.c.n ? -1 : 1));
      h += '<tr class="grp"><td colspan="8">' + esc(k) + ' (' + list.reduce((s, e) => s + e.qty, 0) + ')</td></tr>';
      for (const e of list) {
        const idx = R.deck.indexOf(e), a = Engine.analyze(e.c);
        const roles = Object.keys(a.roles).map(r => '<span class="chip" title="' + esc((a.rules[r] || []).join(', ')) + '">' + esc(Engine.SLOT_LABEL[r]) + '</span>').join('') +
          (e.c.gc ? '<span class="chip gc">Game Changer</span>' : '') +
          ['tutor', 'fast', 'stax', 'xturn', 'mld'].filter(f => a.flags[f]).map(f => '<span class="chip flag" title="' + esc(Engine.FLAGS[f].desc) + '">' + esc(Engine.FLAGS[f].label) + '</span>').join('');
        const p = e.c.p[R.settings.budget.cur];
        h += '<tr class="' + (e.locked ? 'locked' : '') + '">' +
          '<td>' + (idx >= 0 ? '<button type="button" class="small lockbtn" data-act="lock" data-i="' + idx + '" aria-pressed="' + e.locked + '" title="' + (e.locked ? 'Unlock' : 'Lock') + '">' + (e.locked ? '■' : '□') + '</button>' : '') + '</td>' +
          '<td class="nm">' + (e.qty > 1 ? '<span class="mono">' + e.qty + '×</span> ' : '') + (e.c.uri ? '<a href="' + esc(e.c.uri) + '" target="_blank" rel="noopener">' + esc(e.c.n) + '</a>' : esc(e.c.n)) + '</td>' +
          '<td class="cost">' + manaHTML(e.c.mc) + '</td><td class="n">' + e.c.cmc + '</td><td class="n">' + (p == null ? '—' : fmtP(p * e.qty)) + '</td>' +
          '<td>' + roles + '</td><td class="why">' + esc(e.why) + '</td>' +
          '<td>' + (idx >= 0 && !Engine.isBasic(e.c) ? '<div class="acts"><button type="button" class="small" data-act="swap" data-i="' + idx + '">Swap</button><button type="button" class="small" data-act="remove" data-i="' + idx + '">Remove</button></div>' : '') + '</td></tr>';
        if (App.openSwap === e) {
          const alts = R.alternatives(e, 5);
          h += alts.length ? alts.map((x, j) => '<tr class="alt"><td></td><td class="nm">' + esc(x.c.n) + '</td><td>' + manaHTML(x.c.mc) + '</td><td class="n">' + x.c.cmc + '</td><td class="n">' + fmtP(x.c.p[R.settings.budget.cur]) + '</td><td class="n">score ' + x.s.toFixed(2) + '</td><td class="why">' + esc(x.why) + '</td><td><button type="button" class="small" data-act="use" data-i="' + idx + '" data-j="' + j + '">Use</button></td></tr>').join('')
            : '<tr class="alt"><td></td><td colspan="7">No eligible alternative within current constraints.</td></tr>';
        }
      }
    }
    return h;
  }
  function renderDeckTable(byRole) {
    const R = App.R;
    const head = '<tr><th></th><th>Name</th><th>Cost</th><th class="n">MV</th><th class="n">Price</th><th>Roles / flags</th><th>Reason (data)</th><th></th></tr>';
    const cmdRows = R.commanders.map(c => '<tr><td></td><td class="nm"><a href="' + esc(c.uri) + '" target="_blank" rel="noopener">' + esc(c.n) + '</a></td><td class="cost">' + manaHTML(c.mc) + '</td><td class="n">' + c.cmc + '</td><td class="n">' + fmtP(c.p[R.settings.budget.cur]) + '</td><td>' + (c.gc ? '<span class="chip gc">Game Changer</span>' : '') + '</td><td class="why">Commander' + (R.pairKind ? ' (' + esc(R.pairKind) + ')' : '') + ' · ' + (c.rank ? 'EDHREC #' + c.rank : 'no rank') + '</td><td></td></tr>').join('');
    const order = byRole ? ['include', 'locked', 'land', 'basic', 'ramp', 'draw', 'removal', 'wipes', 'protection', 'recursion', 'wincon', 'combo', 'synergy', 'flex'] : ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'];
    const key = byRole ? (e => Engine.SLOT_LABEL[e.slot] || e.slot) : (e => Engine.typeGroup(e.c));
    const sorted = R.deck.slice().sort((a, b) => { const ka = byRole ? order.indexOf(a.slot) : order.indexOf(Engine.typeGroup(a.c)); const kb = byRole ? order.indexOf(b.slot) : order.indexOf(Engine.typeGroup(b.c)); return ka - kb; });
    return '<div class="row" style="justify-content:space-between;margin-bottom:6px"><span class="note">' + sourceLine(R) + '</span></div>' +
      '<div class="scroll"><table class="t"><thead>' + head + '</thead><tbody><tr class="grp"><td colspan="8">Commander (' + R.commanders.length + ')</td></tr>' + cmdRows + deckRows(sorted, key) + '</tbody></table></div>';
  }
  function curveSVG(curve) {
    const W = 360, H = 150, pl = 26, pb = 22, pt = 10, max = Math.max(4, ...curve), step = max > 20 ? 10 : max > 10 ? 5 : 2;
    const bw = (W - pl - 4) / curve.length, sy = v => H - pb - (v / (Math.ceil(max / step) * step)) * (H - pb - pt);
    let g = '';
    for (let t = 0; t <= Math.ceil(max / step) * step; t += step) g += '<line class="gl" x1="' + pl + '" x2="' + (W - 4) + '" y1="' + sy(t) + '" y2="' + sy(t) + '"/><text x="' + (pl - 4) + '" y="' + (sy(t) + 3) + '" text-anchor="end">' + t + '</text>';
    curve.forEach((v, i) => { const x = pl + i * bw + 3, y = sy(v); g += '<rect class="b" x="' + x + '" y="' + y + '" width="' + (bw - 6) + '" height="' + Math.max(0, H - pb - y) + '" rx="2"/>' + (v ? '<text class="lbl" x="' + (x + (bw - 6) / 2) + '" y="' + (y - 3) + '" text-anchor="middle">' + v + '</text>' : '') + '<text x="' + (x + (bw - 6) / 2) + '" y="' + (H - 7) + '" text-anchor="middle">' + (i === 7 ? '7+' : i) + '</text>'; });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:' + W + 'px" role="img" aria-label="Mana curve of nonland cards">' + g + '</svg>';
  }
  function renderStats() {
    const R = App.R, s = R.stats;
    const cols = (R.CI || 'C').split('');
    const pipRow = '<table class="t"><thead><tr><th>Color</th><th class="n">Pips</th><th class="n">Sources</th></tr></thead><tbody>' + cols.map(x => '<tr><td>' + pipsHTML(x === 'C' ? '' : x) + '</td><td class="n">' + (s.pips[x] || 0).toFixed(1).replace(/\.0$/, '') + '</td><td class="n">' + (s.sources[x] || 0) + '</td></tr>').join('') + '</tbody></table><div class="note">Sources: lands plus ramp cards whose Scryfall produced_mana (or fetch targets / any-color text) includes the color.</div>';
    const meters = [['lands', 'Lands']].concat(Engine.ROLES.map(r => [r, Engine.SLOT_LABEL[r]])).map(([k, label]) => {
      const m = s.roles[k], f = m.target ? Math.min(1, m.have / m.target) : 1;
      return '<div class="meter"><span>' + esc(label) + '</span><span class="track"><span class="fill' + (m.have < m.target ? ' short' : '') + '" style="width:' + (f * 100).toFixed(0) + '%"></span></span><span class="num">' + m.have + ' / ' + m.target + '</span></div>';
    }).join('');
    const combos = R.combos && R.combos.length ? '<ul>' + R.combos.map(v => '<li>' + esc(v.c.join(' + ')) + ' → ' + esc(v.p.join(', ')) + (v.bt ? ' <span class="chip">' + esc(v.bt) + '</span>' : '') + '</li>').join('') + '</ul>' : '<p class="note">' + (R.comboStatus === 'unavailable' ? 'No Commander Spellbook file loaded, so combos were not checked.' : 'No complete combos detected.') + '</p>';
    $('view').innerHTML = '<div class="statsgrid">' +
      '<div><h3>Mana curve (nonland, excl. commander)</h3>' + curveSVG(s.curve) + '<p class="note">Average MV ' + s.avgMV.toFixed(2) + ' (target ' + (+R.settings.mana.avgMV).toFixed(1) + '). Creatures: ' + s.creatures + '.</p></div>' +
      '<div><h3>Color pips and sources</h3>' + pipRow + '</div>' +
      '<div><h3>Category counts vs targets</h3><div style="display:flex;flex-direction:column;gap:6px">' + meters + '</div><p class="note">A card counts toward every role its tags match.</p></div>' +
      '<div><h3>Price</h3><p class="num">Total ' + fmtP(s.total) + (R.settings.budget.total != null ? ' / cap ' + fmtP(+R.settings.budget.total) : '') + '</p>' + (s.unknown.length ? '<p class="note">No price: ' + esc(s.unknown.join(', ')) + '</p>' : '') + '<h3 style="margin-top:8px">Game Changers (' + s.gcs.length + ')</h3><p>' + (s.gcs.length ? esc(s.gcs.join(', ')) : '<span class="note">None</span>') + '</p>' +
      '<h3 style="margin-top:8px">Detected combos</h3>' + combos + '</div>' +
      '<div><h3>Synergy tags used</h3>' + (R.tags.length ? '<table class="t"><tbody>' + R.tags.map(t => '<tr><td>' + esc(t.label) + '</td><td class="note">' + esc(t.src) + ', weight ' + t.w + '</td></tr>').join('') + '</tbody></table>' : '<p class="note">None derived from commander text; scores rely on roles, popularity and curve.</p>') + '</div>' +
      '</div>';
  }
  function renderValidation() {
    const R = App.R;
    $('view').innerHTML = '<p class="note">' + sourceLine(R) + ' Checked ' + new Date(R.validation.at).toLocaleString() + '.</p><div class="scroll"><table class="t"><thead><tr><th>Rule</th><th>Result</th><th>Detail</th></tr></thead><tbody>' +
      R.validation.rules.map(r => '<tr><td>' + esc(r.label) + '</td><td><span class="st ' + (r.pass === true ? 'pass' : r.pass === false ? 'fail' : 'na') + '">' + (r.pass === true ? 'PASS' : r.pass === false ? 'FAIL' : 'N/A') + '</span></td><td>' + esc(r.detail) + (r.id === 'bracket' && !r.comboVerified ? ' <span class="note">(combo limit not verified)</span>' : '') + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function renderLog() { const R = App.R; $('view').innerHTML = '<ol class="mono" style="padding-left:22px;margin:0;display:flex;flex-direction:column;gap:3px">' + R.log.map(l => '<li>' + esc(l) + '</li>').join('') + '</ol>'; }
  function renderExport() {
    $('view').innerHTML = '<div class="row"><label class="f" style="min-width:220px">Format<select id="exFmt"><option value="plain">Plain text (1 Card Name)</option><option value="arena">Moxfield / Archidekt (Commander + Deck sections)</option><option value="archidekt">Archidekt ([Commander{top}] tag)</option><option value="mtgo">MTGO .txt (commander in sideboard)</option><option value="csv">CSV</option></select></label><button type="button" id="exCopy">Copy to clipboard</button><button type="button" id="exSave">Save file</button><span class="note" id="exNote"></span></div><textarea id="exText" rows="18" style="margin-top:8px" spellcheck="false" readonly></textarea>';
    const upd = () => { $('exText').value = Engine.exportDeck(App.R, $('exFmt').value); };
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
  function renderView() {
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === App.tab));
    if (App.tab === 'tests') return renderTests();
    if (App.tab === 'analysis') return renderAnalysis();
    if (!App.R || !App.R.stats) { $('view').innerHTML = emptyView(); return; }
    switch (App.tab) {
      case 'deck': $('view').innerHTML = renderDeckTable(false); break;
      case 'role': $('view').innerHTML = renderDeckTable(true); break;
      case 'stats': renderStats(); break;
      case 'valid': renderValidation(); break;
      case 'log': renderLog(); break;
      case 'export': renderExport(); break;
    }
  }
  function renderAll() { renderSummary(); renderView(); $('regenBtn').disabled = !App.R || !App.R.stats || App.busy; }

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
    throw new Error('No card data loaded. Load a Scryfall bulk JSON file under Data source.');
  }
  async function runGenerate(opts) {
    if (App.busy) return;
    opts = opts || {};
    readForm();
    const S = JSON.parse(JSON.stringify(App.S));
    App.busy = true; renderSources(); $('regenBtn').disabled = true; setProg(0.1); showMsgs([], []);
    const t0 = performance.now();
    try {
      setStatus('Scoring candidates…');
      const db = await getDB();
      setProg(0.6); setStatus('Scoring and filling slots…');
      await new Promise(r => setTimeout(r, 0));
      const env = { combos: comboProvider(), locks: opts.locks || [], bans: opts.bans || [] };
      const R = await Engine.generate(db, S, env);
      R.dbMeta = db.meta;
      if (db.meta.warnings && db.meta.warnings.length) R.warnings = db.meta.warnings.concat(R.warnings);
      if (R.errors.length) { App.R = null; showMsgs(R.errors, R.warnings); setStatus('Not generated.'); }
      else {
        App.R = R; App.openSwap = null; if (App.anSource !== 'paste') App.AN = null;
        showMsgs([], R.warnings, shortfallHTML(R));
        setStatus('Generated in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s from ' + R.poolSize.toLocaleString() + ' candidates.');
      }
    } catch (e) { App.R = null; showMsgs([e.message || String(e)], []); setStatus('Error.'); console.error(e); }
    App.busy = false; setProg(null); renderSources(); renderAll();
    if (App.tab === 'analysis' && App.anSource !== 'paste' && App.R) runAnalysis();
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
  function wire() {
    document.querySelector('.settings').addEventListener('input', onFormChange);
    document.querySelector('.settings').addEventListener('change', onFormChange);
    $('bulkFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadBulk(f); });
    $('oFile').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; $('oList').value = await f.text(); App.S.owned.list = $('oList').value; persistSettings(); });
    $('forgetBtn').addEventListener('click', async () => { await IDB.del('bulk'); await IDB.del('combos'); $('idbNote').textContent = 'Stored data removed.'; });
    $('seedBtn').addEventListener('click', () => { const s = Math.random().toString(36).slice(2, 10); $('seed').value = s; App.S.seed = s; App.S.reroll = 0; persistSettings(); });
    $('genBtn').addEventListener('click', () => { App.S.reroll = 0; runGenerate(); });
    $('regenBtn').addEventListener('click', () => {
      if (!App.R) return;
      App.S.reroll = (App.S.reroll || 0) + 1;
      const locks = App.R.deck.filter(e => e.locked && !e.inc).map(e => ({ name: e.c.n, slot: e.slot, qty: e.qty }));
      runGenerate({ locks, bans: App.R.bans || [] });
    });
    $('testBtn').addEventListener('click', runTests);
    document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return; App.tab = b.dataset.tab; renderView(); if (App.tab === 'analysis' && App.anSource !== 'paste' && App.R && App.R.stats) runAnalysis(); });
    $('view').addEventListener('input', e => { if (e.target.id === 'anText') App.anText = e.target.value; });
    $('view').addEventListener('click', async e => {
      const b = e.target.closest('button[data-sw]'); if (!b || !App.AN) return;
      const X = App.AN, a = b.dataset.sw;
      if (a === 'deny') { const p = X.impact[+b.dataset.i]; if (!p) return; App.denied.add(p.add.n); X.impact.splice(+b.dataset.i, 1); X.plans = X.plans.filter(q => q.add !== p.add); renderSwaps(); return; }
      if (a === 'clear-deny') { App.denied.clear(); App.AN = null; runAnalysis(); return; }
      if (a === 'accept') { const p = X.impact[+b.dataset.i]; if (!p) return; b.disabled = true; await applyChange(p.cut, p.add); (App.accepted = App.accepted || []).push({ cut: p.cut, add: p.add, src: App.anSource }); App.AN = null; if (App.anSource !== 'paste') renderAll(); App.tab = 'analysis'; renderView(); runAnalysis(); return; }
      if (a === 'undo') { const i = +b.dataset.i, r = App.accepted[i]; if (!r) return; await applyChange(r.add, r.cut); App.accepted.splice(i, 1); App.AN = null; if (App.anSource !== 'paste') renderAll(); App.tab = 'analysis'; renderView(); runAnalysis(); }
    });
    $('view').addEventListener('change', e => { if (e.target.id === 'anGames') { App.anGames = +e.target.value; try { localStorage.setItem('edhgen.anGames', String(App.anGames)); } catch (x) { } } });
    $('view').addEventListener('click', e => {
      const b = e.target.closest('button[data-an]'); if (!b) return;
      const a = b.dataset.an;
      if (a === 'src-deck' || a === 'src-paste') { App.anSource = a === 'src-paste' ? 'paste' : 'deck'; App.AN = null; renderAnalysis(); if (App.anSource === 'deck' && App.R) runAnalysis(); }
      else if (a === 'run') runAnalysis();
    });
    $('view').addEventListener('click', async e => {
      const b = e.target.closest('button[data-act]'); if (!b || !App.R) return;
      const entry = App.R.deck[+b.dataset.i]; if (!entry) return;
      const act = b.dataset.act;
      if (act === 'lock') { entry.locked = !entry.locked; renderView(); }
      else if (act === 'swap') { App.openSwap = App.openSwap === entry ? null : entry; renderView(); }
      else if (act === 'use') { const alt = App.R.alternatives(entry, 5)[+b.dataset.j]; if (alt) { await App.R.replace(entry, alt.c, true); App.openSwap = null; renderAll(); } }
      else if (act === 'remove') { await App.R.remove(entry); App.openSwap = null; renderAll(); }
      if (act === 'use' || act === 'remove') { if (App.anSource !== 'paste') App.AN = null; }
    });
    $('saveSet').addEventListener('click', () => saveFile('edh-settings.json', JSON.stringify(readForm(), null, 2), $('idbNote')));
    $('loadSet').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { applySettings(JSON.parse(await f.text())); setStatus('Settings loaded.'); checkCommanders(); } catch (err) { setStatus('Settings file error: ' + err.message); } });
    $('copyTok').addEventListener('click', () => copyText($('shareTok').value, $('shareTok'), null));
    $('applyTok').addEventListener('click', async () => { try { applySettings(await decodeSettings($('shareTok').value)); setStatus('Token applied.'); checkCommanders(); } catch (err) { setStatus('Token error: ' + err.message); } });
    $('resetSet').addEventListener('click', () => { applySettings({}); setStatus('Defaults restored.'); });
    const themes = ['system', 'light', 'dark'];
    const applyTheme = t => { if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); $('themeBtn').textContent = 'Theme: ' + t; };
    let theme = LS.get('edhgen.theme') || 'system'; applyTheme(theme);
    App.anGames = +(LS.get('edhgen.anGames') || 100000);
    $('themeBtn').addEventListener('click', () => { theme = themes[(themes.indexOf(theme) + 1) % 3]; applyTheme(theme); LS.set('edhgen.theme', theme); });
    setupAC('cmd1', 'cmd1L'); setupAC('cmd2', 'cmd2L');
    wireQuick(); syncQuick(App.S);
  }
  function fillStatic() {
    const sel = $('archetype');
    for (const [k, t] of Object.entries(Engine.TAGS)) { const o = document.createElement('option'); o.value = k; o.textContent = t.label; sel.appendChild(o); }
    $('tagNote').textContent = 'Keys: ' + Object.keys(Engine.TAGS).join(', ') + '. Commander text also adds matching tags and any creature type it names.';
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
    if (App.S.bl && ({ 1: 2, 2: 3, 3: 6 })[App.S.bracket] === +App.S.bl.tutor) App.S.bl.tutor = 999; // old defaults; tutor limits were removed Oct 21 2025
    writeForm(App.S); updateShareToken();
    wire(); renderSources(); renderAll();
    autoload();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
