/* ===== Card explorer: search a card, see its parts, similar cards (Similar.rank) and 2-card combos (Commander Spellbook) ===== */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const W0 = { mech: 60, cost: 20, type: 12, stats: 8 };
  const CX = { bulk: null, X: null, combos: null, sbData: null, card: null, tab: 'similar', focus: '', W: Object.assign({}, W0), F: { colors: 'any', type: 'any', max: '', legal: true }, sort: 'match', n: 30, img: 'on' };
  window.CardExplorer = CX;

  /* ---------- storage (same database and keys as the deck generator, so a file loaded on one page is reused on the other) ---------- */
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
  const IDB = {
    open() { return new Promise((res, rej) => { try { const r = indexedDB.open('edhgen', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); },
    async put(k, v) { try { const db = await IDB.open(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
    async get(k) { try { const db = await IDB.open(); return await new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly'); const r = tx.objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch (e) { return null; } }
  };
  function setStatus(t) { $('status').textContent = t || ''; $('statusBar').classList.toggle('hidden', !t); }

  /* ---------- card data: the newest Scryfall file listed in data/index.json, else the copy stored in this browser ---------- */
  const NORM_V = 2; // must match the generator's NORM_V so both pages accept each other's stored copy
  const BULK_RE = /^(?:oracle-cards|default-cards|all-cards|unique-artwork|cards)[\w.-]*\.jsonl?(?:\.gz)?$/i;
  const pickNewest = files => { const ok = files.filter(f => BULK_RE.test(f.name)); const rank = n => /^oracle/i.test(n) ? 0 : /^default/i.test(n) ? 1 : 2; ok.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? 1 : -1)); return ok[0] || null; };
  async function repoFile() {
    if (!window.EDH_SITE || !/^https?:$/.test(location.protocol)) return null;
    try {
      const r = await fetch('data/index.json', { cache: 'no-cache' });
      if (r.ok) { const ix = await r.json(); const f = ix && Array.isArray(ix.files) ? pickNewest(ix.files.map(x => ({ name: x.name, size: x.size, sha: x.sha256 }))) : null; if (f) return { url: 'data/' + f.name, tag: f.sha, size: f.size }; }
    } catch (e) { }
    return null;
  }
  async function readCards(res, url, size) {
    const gz = /\.gz$/.test(url) && !/gzip/i.test(res.headers.get('content-encoding') || '');
    if (gz && typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unzip ' + url);
    const reader = (gz ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body).pipeThrough(new TextDecoderStream()).getReader();
    const out = []; let buf = '', read = 0, parsed = 0;
    const handle = line => { let t = line.trim(); if (t.endsWith(',')) t = t.slice(0, -1); if (t[0] !== '{' || t[t.length - 1] !== '}') return; try { const n = Engine.norm(JSON.parse(t)); parsed++; if (n) out.push(n); } catch (e) { } };
    for (; ;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += value; read += value.length;
      let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      setStatus('Reading card data… ' + Math.min(99, Math.round(read / Math.max(1, (gz ? size * 8 : size)) * 100)) + '%');
    }
    handle(buf);
    return { cards: out, parsed };
  }
  async function loadCards() {
    const stored = await IDB.get('bulk'), rc = await repoFile();
    const fresh = stored && stored.meta && rc && rc.tag && stored.meta.tag === rc.tag && stored.meta.nv === NORM_V;
    if (rc && !fresh) {
      try {
        setStatus('Reading card data…');
        const res = await fetch(rc.url, { cache: 'no-cache' }); if (!res.ok || !res.body) throw new Error(rc.url + ': HTTP ' + res.status);
        const { cards, parsed } = await readCards(res, rc.url, rc.size);
        if (!cards.length) throw new Error('no Scryfall card objects found');
        const meta = { source: 'Scryfall bulk file', source2: 'site data', tag: rc.tag, nv: NORM_V, file: rc.url.split('/').pop(), loadedAt: new Date().toISOString(), records: parsed };
        CX.bulk = Engine.buildDB(cards, meta);
        IDB.put('bulk', { cards, meta });
      } catch (e) { setStatus('Site card data: ' + e.message); }
    }
    if (!CX.bulk && stored && stored.cards && stored.cards.length) CX.bulk = Engine.buildDB(stored.cards, stored.meta);
    renderSources();
  }
  /* ---------- Commander Spellbook combos (data/spellbook/), same files and stored copy as the generator ---------- */
  const SB_FORMAT = 'edhgen-spellbook/1';
  async function loadCombos() {
    try {
      let man = null;
      if (window.EDH_SITE && /^https?:$/.test(location.protocol)) { try { const r = await fetch('data/spellbook/manifest.json', { cache: 'no-cache' }); if (r.ok) man = await r.json(); } catch (e) { } }
      if (man && man.format !== SB_FORMAT) man = null;
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
      }
      if (data) CX.combos = Engine.localComboProvider(Engine.spellbookVariants(data.tables, data.rows, CX.bulk), data.meta);
    } catch (e) { CX.combos = null; setStatus('Combo data not loaded: ' + e.message + '.'); }
    renderSources();
  }
  function renderSources() {
    const pill = (id, ok, text) => { const el = $(id); el.classList.remove('hidden'); el.innerHTML = '<span class="dot ' + (ok ? 'ok' : '') + '"></span>' + esc(text); };
    pill('pBulk', !!CX.bulk, CX.bulk ? CX.bulk.all.length.toLocaleString() + ' cards' : 'Card data not loaded');
    if (CX.combos) pill('pCombo', true, CX.combos.count.toLocaleString() + ' combos');
  }

  /* ---------- formatting ---------- */
  const IMG = size => 'https://cards.scryfall.io/' + size + '/';
  const imgOn = () => CX.img === 'on';
  function manaHTML(mc) {
    if (!mc) return '';
    return esc(mc).replace(/\{([^}]+)\}/g, (m, s) => { const cols = s.split('/').filter(x => 'WUBRG'.includes(x)); const cls = cols.length === 1 ? cols[0] : ''; return '<span class="ms ' + cls + '">' + s.replace('/', '') + '</span>'; });
  }
  const pipsHTML = ci => ci ? ci.split('').map(x => '<span class="ms ' + x + '">' + x + '</span>').join('') : '<span class="ms C">C</span>';
  const usd = v => v == null ? '—' : '$' + v.toFixed(2);
  const oracleHTML = ot => String(ot || '').split('\n').map(l => '<p>' + manaHTML(l).replace(/\(([^)]*)\)/g, '<i class="rem">($1)</i>') + '</p>').join('');
  const thumb = (c, cls) => imgOn() && c.img ? '<img class="' + (cls || 'th') + '" src="' + IMG('small') + esc(c.img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="' + (cls || 'th') + ' th-txt" aria-hidden="true">' + pipsHTML(c.ci) + '</span>';
  const openBtn = (c, label) => '<button type="button" class="cname" data-open="' + esc(c.n) + '">' + esc(label || c.n) + '</button>';
  const SEG = { mech: 'Mechanics', cost: 'Mana cost', type: 'Type', stats: 'Stats' };

  /* ---------- search ---------- */
  let nameIx = null;
  function names() { if (!nameIx && CX.bulk) nameIx = CX.bulk.all.filter(c => c.stype !== 'funny' || c.leg === 'legal').map(c => ({ c, k: Engine.nameKey(c.n) })); return nameIx || []; }
  function setupSearch() {
    const inp = $('q'), ul = $('qL'); let items = [], sel = -1;
    const close = () => { ul.classList.add('hidden'); ul.innerHTML = ''; items = []; sel = -1; inp.setAttribute('aria-expanded', 'false'); };
    const show = () => {
      const k = Engine.nameKey(inp.value); if (k.length < 2) return close();
      const ix = names(), pre = [], sub = [];
      for (const x of ix) { const p = x.k.indexOf(k); if (p === 0) pre.push(x.c); else if (p > 0) sub.push(x.c); }
      const byRank = (a, b) => (a.rank || 1e9) - (b.rank || 1e9);
      items = pre.sort(byRank).concat(sub.sort(byRank)).slice(0, 12); sel = -1;
      if (!items.length) { ul.innerHTML = '<li class="none">No card named like that' + (CX.bulk ? '' : ' (card data still loading)') + '</li>'; ul.classList.remove('hidden'); return; }
      ul.innerHTML = items.map((c, i) => '<li role="option" id="qL' + i + '" data-i="' + i + '"><span>' + esc(c.n) + ' <span class="note">' + esc(c.ft) + '</span></span><span class="cost">' + manaHTML(c.mc) + '</span></li>').join('');
      ul.classList.remove('hidden'); inp.setAttribute('aria-expanded', 'true');
    };
    const pick = i => { const c = items[i]; if (!c) return; close(); inp.value = ''; inp.blur(); go(c.n); };
    inp.addEventListener('input', show);
    inp.addEventListener('focus', () => { if (inp.value) show(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!items.length) return; e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; [...ul.children].forEach((li, i) => li.setAttribute('aria-selected', i === sel)); inp.setAttribute('aria-activedescendant', 'qL' + sel); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items.length) pick(sel >= 0 ? sel : 0); else if (CX.bulk) { const c = Engine.lookup(CX.bulk, inp.value); if (c) { close(); inp.value = ''; go(c.n); } } }
      else if (e.key === 'Escape') { close(); inp.blur(); }
    });
    ul.addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
    inp.addEventListener('blur', () => setTimeout(close, 150));
  }

  /* ---------- navigation: the card name lives in the URL hash, so Back and shared links work ---------- */
  function go(name) { const h = '#' + encodeURIComponent(name); if (location.hash !== h) location.hash = h; else show(); }
  function hashName() { try { return decodeURIComponent((location.hash || '').slice(1)); } catch (e) { return ''; } }
  function show() {
    const n = hashName(), c = n && CX.bulk ? Engine.lookup(CX.bulk, n) : null;
    if (c !== CX.card) { CX.card = c; CX.focus = ''; CX.n = 30; }
    render(); if (c) window.scrollTo({ top: 0 });
  }

  /* ---------- page ---------- */
  function render() {
    const c = CX.card;
    document.title = c ? c.n + ' · card explorer' : 'broken-stuff card explorer';
    $('cx').classList.toggle('empty-state', !c);
    if (!c) { $('cxInfo').innerHTML = ''; $('cxRecs').innerHTML = ''; $('cxMid').innerHTML = emptyHTML(); return; }
    $('cxMid').innerHTML = midHTML(c);
    $('cxInfo').innerHTML = infoHTML(c);
    renderRecs();
  }
  function emptyHTML() {
    if (!CX.bulk) return '<div class="panel empty"><h2>Card explorer</h2><p class="note">Loading card data…</p></div>';
    const top = CX.bulk.all.filter(c => c.rank && c.leg === 'legal' && !Engine.isBasic(c)).sort((a, b) => a.rank - b.rank).slice(0, 12);
    return '<div class="panel empty"><h2>Search any card</h2><p class="note">Type a name above. You get the card, its parts, the closest cards by mechanics, mana cost, type and stats, and its 2-card combos. Or start with one of the most played Commander cards:</p>' +
      '<div class="starter">' + top.map(c => '<button type="button" class="st-card" data-open="' + esc(c.n) + '">' + (imgOn() && c.img ? '<img src="' + IMG('small') + esc(c.img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') + '<span>' + esc(c.n) + '</span></button>').join('') + '</div></div>';
  }
  function midHTML(c) {
    const faces = / \/\/ /.test(c.n);
    const art = imgOn() && c.img
      ? '<img id="bigImg" class="big-img" src="' + IMG('normal') + esc(c.img) + '" alt="' + esc(c.n) + '" referrerpolicy="no-referrer">'
      : '<div class="faux"><div class="fx-h"><b>' + esc(c.n) + '</b><span>' + manaHTML(c.mc) + '</span></div><div class="fx-t">' + esc(c.tl) + '</div><div class="fx-o">' + oracleHTML(c.ot) + '</div>' + (c.pt ? '<div class="fx-pt">' + esc(c.pt) + '</div>' : '') + '</div>';
    return '<div class="art">' + art + '</div>' +
      '<div class="prices"><div><span>USD</span><b>' + usd(c.p.usd) + '</b></div><div><span>EUR</span><b>' + (c.p.eur == null ? '—' : '€' + c.p.eur.toFixed(2)) + '</b></div><div><span>MTGO</span><b>' + (c.p.tix == null ? '—' : c.p.tix.toFixed(2) + ' tix') + '</b></div></div>' +
      '<p class="note pnote">Lowest Scryfall price across printings in the loaded file.</p>' +
      '<div class="row mid-acts">' + (faces && imgOn() && c.img ? '<button type="button" class="small" id="flipBtn">Flip</button>' : '') + (Engine.commanderEligibility(c).ok ? '<a class="small btnlink" href="./#' + deckToken(c) + '">Build a deck with it</a>' : '') + (c.uri ? '<a class="small btnlink" href="' + esc(c.uri) + '" target="_blank" rel="noopener">Scryfall ↗</a>' : '') + '</div>';
  }
  // deck generator link with this card as commander: the generator's plain (j) share token, base64url JSON of the settings
  function deckToken(c) { const u = new TextEncoder().encode(JSON.stringify({ commanders: [c.n, ''] })); let b = ''; for (const x of u) b += String.fromCharCode(x); return 'j' + btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function infoHTML(c) {
    const a = Engine.analyze(c), roles = Object.keys(a.roles).map(r => '<span class="chip">' + esc(Engine.SLOT_LABEL[r]) + '</span>').join('') +
      ['tutor', 'fast', 'stax', 'xturn', 'mld'].filter(f => a.flags[f]).map(f => '<span class="chip flag">' + esc(Engine.FLAGS[f].label) + '</span>').join('') + (c.gc ? '<span class="chip gc">Game Changer</span>' : '');
    const leg = c.leg === 'legal' ? '<span class="good">Legal</span>' : '<span class="badc">' + esc(c.leg.replace('_', ' ')) + '</span>';
    const cmd = Engine.commanderEligibility(c).ok;
    const kv = [['Mana value', c.cmc], ['Colour identity', pipsHTML(c.ci)], ['EDHREC rank', c.rank ? '#' + c.rank.toLocaleString() : '—'], ['Commander', leg + (cmd ? ' · can be commander' : '')],
      ['Printings', c.sets.length + (c.first ? ' · first ' + esc(c.first.slice(0, 4)) : '')], ['Reserved list', c.rl ? 'Yes' : 'No']];
    const M = CX.X ? Similar.cardMechanics(CX.X, c) : null;
    const mech = M == null ? '<p class="note">Reading rules text…</p>' : !M.length ? '<p class="note">No mechanics found in its rules text.</p>' :
      '<div class="mchips">' + M.map(m => '<button type="button" class="mchip" data-focus="' + esc(m.id) + '" aria-pressed="' + (CX.focus === m.id) + '" title="' + esc(m.group) + ' · on ' + m.cards.toLocaleString() + ' cards. Click to rank similar cards by this.">' + esc(m.label) + '<small>' + m.cards.toLocaleString() + '</small></button>').join('') + '</div><p class="note">Number = cards in the data with it. Click one to focus the recommendations on it.</p>';
    return '<div class="ih"><h2 class="display">' + esc(c.n) + '</h2><span class="cost">' + manaHTML(c.mc) + '</span></div>' +
      '<div class="tl">' + esc(c.tl) + (c.pt ? ' <b class="pt">' + esc(c.pt) + '</b>' : '') + '</div>' +
      (c.ot ? '<div class="oracle">' + oracleHTML(c.ot) + '</div>' : '<div class="oracle note">No rules text.</div>') +
      '<div class="kvs">' + kv.map(([k, v]) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>' +
      (c.kw.length ? '<h3>Keywords</h3><div>' + c.kw.map(k => '<span class="chip">' + esc(k.charAt(0).toUpperCase() + k.slice(1)) + '</span>').join('') + '</div>' : '') +
      (roles ? '<h3>Deck roles</h3><div>' + roles + '</div>' : '') +
      '<h3>Mechanics</h3>' + mech;
  }

  /* ---------- recommendations ---------- */
  function filterFn(c0) {
    const F = CX.F, max = parseFloat(F.max), t0 = Similar.typeInfo(c0).types;
    return c => {
      if (F.legal && c.leg !== 'legal') return false;
      if (c.stype === 'funny' || Engine.isBasic(c)) return false;
      if (F.colors === 'within' && ![...c.ci].every(x => c0.ci.includes(x))) return false;
      if (F.colors === 'same' && c.ci !== c0.ci) return false;
      if (F.type === 'same' && !Similar.typeInfo(c).types.some(t => t0.includes(t))) return false;
      if (isFinite(max) && (c.p.usd == null || c.p.usd > max)) return false;
      return true;
    };
  }
  function renderRecs() {
    const c = CX.card; if (!c) return;
    const K = CX.combos ? Similar.combos(CX.combos, c.n) : null;
    const tabs = '<div class="subtabs rtabs" role="tablist"><button role="tab" data-rtab="similar" aria-selected="' + (CX.tab === 'similar') + '">Similar cards</button><button role="tab" data-rtab="combos" aria-selected="' + (CX.tab === 'combos') + '">2-card combos' + (K ? ' <small>' + K.two.length + '</small>' : '') + '</button></div>';
    $('cxRecs').innerHTML = tabs + '<div id="recBody">' + (CX.tab === 'combos' ? combosHTML(c, K) : similarHTML(c)) + '</div>';
  }
  function similarHTML(c) {
    if (!CX.X) return '<p class="note">Indexing rules text for ' + (CX.bulk ? CX.bulk.all.length.toLocaleString() : '') + ' cards…</p>';
    const M = Similar.cardMechanics(CX.X, c), F = CX.F;
    const R = Similar.rank(CX.X, c, { weights: CX.W, focus: CX.focus, filter: filterFn(c), limit: 100 });
    let list = R.list.slice();
    if (CX.sort === 'price') list.sort((a, b) => (a.c.p.usd == null ? 1e9 : a.c.p.usd) - (b.c.p.usd == null ? 1e9 : b.c.p.usd));
    else if (CX.sort === 'rank') list.sort((a, b) => (a.c.rank || 1e9) - (b.c.rank || 1e9));
    const wsum = Object.keys(SEG).reduce((s, k) => s + (R.use[k] ? CX.W[k] : 0), 0) || 1;
    const focusLabel = CX.focus ? Similar.defOf(CX.focus).label : '';
    const sel = (id, v, opts) => '<select id="' + id + '">' + opts.map(([k, l]) => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
    const ctl = '<div class="focusrow"><span class="lbl">Focus</span><button type="button" class="mchip" data-focus="" aria-pressed="' + !CX.focus + '">Overall</button>' +
      M.slice(0, 14).map(m => '<button type="button" class="mchip" data-focus="' + esc(m.id) + '" aria-pressed="' + (CX.focus === m.id) + '">' + esc(m.label) + '</button>').join('') + '</div>' +
      '<div class="ctl">' +
      '<label class="f">Colours' + sel('fCol', F.colors, [['any', 'Any colours'], ['within', 'Within its colour identity'], ['same', 'Same colour identity']]) + '</label>' +
      '<label class="f">Type' + sel('fType', F.type, [['any', 'Any type'], ['same', 'Shares a card type']]) + '</label>' +
      '<label class="f">Max price (USD)<input type="number" id="fMax" min="0" step="0.5" placeholder="none" value="' + esc(F.max) + '"></label>' +
      '<label class="f">Sort' + sel('fSort', CX.sort, [['match', 'Best match'], ['price', 'Lowest price'], ['rank', 'Most played (EDHREC)']]) + '</label>' +
      '</div>' +
      '<div class="row ctl2"><label class="c"><input type="checkbox" id="fLegal"' + (F.legal ? ' checked' : '') + '> Commander-legal only</label>' +
      '<details class="wts"' + (CX.wOpen ? ' open' : '') + '><summary>Weights</summary><div class="wgrid">' +
      Object.keys(SEG).map(k => '<label class="f"><span><i class="sw s-' + k + '"></i>' + SEG[k] + ' <b class="mono" id="wv-' + k + '">' + CX.W[k] + '</b></span><input type="range" min="0" max="100" step="1" data-w="' + k + '" value="' + CX.W[k] + '"></label>').join('') +
      '<button type="button" class="small" id="wReset">Reset weights</button></div></details></div>';
    const legend = '<div class="legend">' + Object.keys(SEG).filter(k => R.use[k]).map(k => '<span><i class="sw s-' + k + '"></i>' + SEG[k] + ' ' + Math.round(CX.W[k] / wsum * (CX.focus ? 50 : 100)) + '%</span>').join('') + (CX.focus ? '<span><i class="sw s-focus"></i>' + esc(focusLabel) + ' 50%</span>' : '') + '</div>';
    const head = '<p class="note rhead">' + (CX.focus ? R.total.toLocaleString() + ' cards with ' + esc(focusLabel) + '. Score = ½ how alike their ' + esc(focusLabel) + ' text is + ½ overall match.' : R.total.toLocaleString() + ' cards compared. Score = weighted match of mechanics, mana cost, type and stats.') + (CX.sort !== 'match' ? ' Showing the top 100 matches sorted by ' + (CX.sort === 'price' ? 'price' : 'EDHREC rank') + '.' : '') + '</p>';
    const rows = list.slice(0, CX.n).map((r, i) => {
      const parts = Object.keys(SEG).filter(k => R.use[k]), f = CX.focus ? 0.5 : 1;
      const bar = (CX.focus ? '<i class="s-focus" style="width:' + (r.focus * 50).toFixed(1) + '%"></i>' : '') + parts.map(k => '<i class="s-' + k + '" style="width:' + (f * CX.W[k] / wsum * r.parts[k] * 100).toFixed(1) + '%"></i>').join('');
      const tip = (CX.focus ? focusLabel + ' text ' + Math.round(r.focus * 100) + '% · ' : '') + parts.map(k => SEG[k] + ' ' + Math.round(r.parts[k] * 100) + '%').join(' · ');
      const shared = r.shared.slice(0, 5).map(id => '<span class="chip">' + esc(Similar.defOf(id).label) + '</span>').join('') + (r.shared.length > 5 ? '<span class="note">+' + (r.shared.length - 5) + '</span>' : '');
      return '<li class="rec">' + '<button type="button" class="thb" data-open="' + esc(r.c.n) + '" aria-label="Open ' + esc(r.c.n) + '">' + thumb(r.c) + '</button>' +
        '<div class="rb"><div class="rt">' + openBtn(r.c) + '<span class="cost">' + manaHTML(r.c.mc) + '</span></div><div class="note">' + esc(r.c.tl) + (r.c.pt ? ' · ' + esc(r.c.pt) : '') + '</div>' + (shared ? '<div class="sh">' + shared + '</div>' : '') +
        '<div class="sbar" title="' + esc(tip) + '">' + bar + '</div><div class="note bd">' + esc(tip) + '</div></div>' +
        '<div class="rs"><b class="pct">' + Math.round(r.score * 100) + '%</b><span>' + usd(r.c.p.usd) + '</span>' + (r.c.rank ? '<span class="note">#' + r.c.rank.toLocaleString() + '</span>' : '') + '</div></li>';
    }).join('');
    return ctl + legend + head + (rows ? '<ol class="recs-l">' + rows + '</ol>' : '<p class="note">No cards pass these filters.</p>') +
      (list.length > CX.n ? '<button type="button" class="block" id="moreBtn">Show more (' + (list.length - CX.n) + ')</button>' : '') +
      '<details class="method"><summary class="note">How the match is computed</summary><ul class="note">' +
      '<li><b>Mechanics</b>: half the cosine similarity of the two cards\' rules text (words and word pairs, weighted by how rare they are across all cards, card names replaced), half the overlap of detected mechanics (keywords, triggers, counters, tokens, the generator\'s role and theme rules), with rare mechanics counting more.</li>' +
      '<li><b>Mana cost</b>: 60% mana value (−25% per point of difference), 40% colour identity overlap.</li>' +
      '<li><b>Type</b>: 70% card types, 20% subtypes, 10% legendary or not.</li>' +
      '<li><b>Stats</b>: power and toughness (−12.5% per point) or loyalty (−20% per point); only for cards that have them.</li>' +
      '<li>The score is the weighted mean of those parts; the bar shows each part\'s share. A focus keeps only cards with that mechanic and adds how alike their lines with it are.</li></ul></details>';
  }
  const BT = { R: 'Ruthless', S: 'Spicy', P: 'Powerful', O: 'Oddball', C: 'Core', E: 'Exhibition', B: 'Banned' };
  function combosHTML(c, K) {
    if (!K) return '<p class="note">' + (CX.combos === null && CX.comboTried ? 'Combo data is not available.' : 'Loading Commander Spellbook combos…') + '</p>';
    if (!K.two.length) return '<p class="note">No 2-card combos with ' + esc(c.n) + ' in Commander Spellbook' + (K.more ? '. It is in ' + K.more.toLocaleString() + ' combos that need 3 or more cards.' : '.') + '</p>' + sbSearch(c);
    const rows = K.two.slice(0, CX.cn || 40).map(({ v, partner }) => {
      const p = Engine.lookup(CX.bulk, partner) || { n: partner, ci: '', mc: '', tl: '', p: {}, img: '' };
      const tot = c.p.usd != null && p.p.usd != null ? c.p.usd + p.p.usd : null;
      const res = v.p.slice(0, 4).map(x => '<span class="chip' + (/infinite/i.test(x) ? ' inf' : '') + '">' + esc(x) + '</span>').join('') + (v.p.length > 4 ? '<span class="note">+' + (v.p.length - 4) + '</span>' : '');
      return '<li class="rec combo"><button type="button" class="thb" data-open="' + esc(p.n) + '" aria-label="Open ' + esc(p.n) + '">' + thumb(p) + '</button>' +
        '<div class="rb"><div class="rt"><span class="plus">+</span>' + openBtn(p) + '<span class="cost">' + manaHTML(p.mc) + '</span></div><div class="sh">' + res + '</div>' +
        (v.t.length ? '<div class="note">Also needs: ' + esc(v.t.join('; ')) + '</div>' : '') + (v.cmd.length ? '<div class="note">Needs ' + esc(v.cmd.join(' and ')) + ' as commander</div>' : '') +
        '<div class="note">' + (BT[v.bt] ? 'Spellbook bracket tag: ' + BT[v.bt] + ' · ' : '') + 'colour identity ' + pipsHTML(v.ci) + (v.pop ? ' · in ' + v.pop.toLocaleString() + ' decks' : '') + ' · <a href="https://commanderspellbook.com/combo/' + encodeURIComponent(v.id) + '/" target="_blank" rel="noopener">Steps ↗</a></div></div>' +
        '<div class="rs"><b>' + usd(p.p.usd) + '</b><span class="note">both ' + usd(tot) + '</span></div></li>';
    }).join('');
    return '<p class="note rhead">' + K.two.length.toLocaleString() + ' Commander Spellbook combos made of ' + esc(c.n) + ' and one other card, most played first' + (K.more ? '; ' + K.more.toLocaleString() + ' more need 3 or more cards' : '') + '.</p><ol class="recs-l">' + rows + '</ol>' +
      (K.two.length > (CX.cn || 40) ? '<button type="button" class="block" id="moreCombo">Show more (' + (K.two.length - (CX.cn || 40)) + ')</button>' : '') + sbSearch(c);
  }
  const sbSearch = c => '<p class="note"><a href="https://commanderspellbook.com/search/?q=' + encodeURIComponent('card:"' + c.n + '"') + '" target="_blank" rel="noopener">All combos with this card on Commander Spellbook ↗</a></p>';

  /* ---------- events ---------- */
  let rT = 0;
  const reRank = (delay) => { clearTimeout(rT); rT = setTimeout(() => { const y = window.scrollY; renderRecs(); window.scrollTo({ top: y }); }, delay || 0); };
  function wire() {
    document.addEventListener('click', e => {
      const o = e.target.closest('[data-open]'); if (o) { e.preventDefault(); go(o.dataset.open); return; }
      const f = e.target.closest('[data-focus]'); if (f) { CX.focus = f.dataset.focus; CX.tab = 'similar'; CX.n = 30; $('cxInfo').innerHTML = infoHTML(CX.card); reRank(); if (f.closest('#cxInfo') && innerWidth < 1100) $('cxRecs').scrollIntoView({ behavior: 'smooth' }); return; }
      const t = e.target.closest('[data-rtab]'); if (t) { CX.tab = t.dataset.rtab; renderRecs(); return; }
      if (e.target.id === 'moreBtn') { CX.n += 30; reRank(); return; }
      if (e.target.id === 'moreCombo') { CX.cn = (CX.cn || 40) + 40; reRank(); return; }
      if (e.target.id === 'wReset') { CX.W = Object.assign({}, W0); CX.wOpen = true; reRank(); return; }
      if (e.target.id === 'flipBtn') { const im = $('bigImg'); if (!im) return; const back = /\/front\//.test(im.src); im.onerror = () => { im.onerror = null; im.src = im.src.replace('/back/', '/front/'); e.target.disabled = true; e.target.title = 'No back face image'; }; im.src = back ? im.src.replace('/front/', '/back/') : im.src.replace('/back/', '/front/'); return; }
    });
    $('cxRecs').addEventListener('change', e => {
      const id = e.target.id;
      if (id === 'fCol') CX.F.colors = e.target.value; else if (id === 'fType') CX.F.type = e.target.value; else if (id === 'fSort') CX.sort = e.target.value;
      else if (id === 'fLegal') CX.F.legal = e.target.checked; else if (id === 'fMax') CX.F.max = e.target.value; else if (e.target.dataset.w) { CX.wOpen = true; }
      else return;
      CX.n = 30; reRank();
    });
    $('cxRecs').addEventListener('input', e => {
      const k = e.target.dataset.w; if (!k) return;
      CX.W[k] = +e.target.value; CX.wOpen = true; const v = $('wv-' + k); if (v) v.textContent = e.target.value; reRank(250);
    });
    $('cxRecs').addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('wts')) CX.wOpen = e.target.open; }, true);
    // a picture that fails to load (offline, blocked) falls back to the text card or the colour block
    document.addEventListener('error', e => {
      const im = e.target; if (!im || im.tagName !== 'IMG') return;
      if (im.id === 'bigImg' && CX.card && /\/front\//.test(im.src)) { const c = CX.card; im.outerHTML = '<div class="faux"><div class="fx-h"><b>' + esc(c.n) + '</b><span>' + manaHTML(c.mc) + '</span></div><div class="fx-t">' + esc(c.tl) + '</div><div class="fx-o">' + oracleHTML(c.ot) + '</div>' + (c.pt ? '<div class="fx-pt">' + esc(c.pt) + '</div>' : '') + '</div>'; }
      else if (im.classList.contains('th')) { const n = im.closest('[data-open]'), c = n && Engine.lookup(CX.bulk, n.dataset.open); im.outerHTML = '<span class="th th-txt" aria-hidden="true">' + pipsHTML(c ? c.ci : '') + '</span>'; }
      else if (im.closest('.st-card')) im.remove();
    }, true);
    window.addEventListener('hashchange', show);
    document.addEventListener('keydown', e => {
      if (e.target.matches && e.target.matches('input,select,textarea')) return;
      if (e.key === '/') { e.preventDefault(); $('q').focus(); }
      else if (e.key === 'Escape') $('appearance').classList.add('hidden');
    });
    // appearance: shared with the deck generator (edhgen.appearance); card pictures default to on here
    let AP = { mode: 'system', accent: '', size: '1', head: 'serif', img: 'off', cimg: 'on' };
    try { AP = Object.assign(AP, JSON.parse(LS.get('edhgen.appearance') || '{}')); } catch (e) { }
    const root = document.documentElement, keys = [['apMode', 'mode'], ['apAccent', 'accent'], ['apSize', 'size'], ['apHead', 'head'], ['apImg', 'cimg']];
    const applyAP = () => {
      if (AP.mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', AP.mode);
      if (AP.accent) root.setAttribute('data-accent', AP.accent); else root.removeAttribute('data-accent');
      root.style.setProperty('--fz', AP.size); root.setAttribute('data-headings', AP.head); CX.img = AP.cimg;
      for (const [id, k] of keys) $(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === String(AP[k])));
    };
    applyAP();
    for (const [id, k] of keys) $(id).addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (!b) return; AP[k] = b.dataset.v; applyAP(); LS.set('edhgen.appearance', JSON.stringify(AP)); if (k === 'cimg') render(); });
    $('themeBtn').addEventListener('click', e => { e.stopPropagation(); const p = $('appearance'), open = p.classList.toggle('hidden'); $('themeBtn').setAttribute('aria-expanded', String(!open)); });
    document.addEventListener('click', e => { if (!e.target.closest('.popwrap')) $('appearance').classList.add('hidden'); });
  }

  async function init() {
    wire(); setupSearch(); render();
    await loadCards();
    if (!CX.bulk) { setStatus('No card data. Open this page from the site, or load a file on the deck generator page first.'); $('cxMid').innerHTML = '<div class="panel empty"><h2>No card data</h2><p class="note">This page reads the Scryfall file in the site\'s data folder, or the copy the deck generator stored in this browser.</p></div>'; return; }
    setStatus(''); show();
    const comboP = loadCombos().then(() => { CX.comboTried = true; if (CX.card) { if (CX.tab === 'combos') renderRecs(); else { const b = document.querySelector('[data-rtab="combos"]'); if (b) renderRecs(); } } });
    setStatus('Indexing rules text…');
    CX.X = await Similar.build(CX.bulk, f => setStatus('Indexing rules text… ' + Math.round(f * 100) + '%'));
    setStatus('');
    if (CX.card) { $('cxInfo').innerHTML = infoHTML(CX.card); renderRecs(); }
    await comboP;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
