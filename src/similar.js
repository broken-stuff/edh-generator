/* ===== Similar: card-to-card similarity for the card explorer =====
   Every score is computed from the loaded Scryfall data with the generator's own rules (Engine.ROLE_RULES, FLAGS, TAGS) plus
   the mechanic detectors below. A match is a weighted mean of four parts, each 0–1:
     mechanics = ½ · cosine of TF-IDF rules-text vectors (words and word pairs) + ½ · IDF-weighted Jaccard of shared mechanics
     mana cost = 0.6 · (1 − |ΔMV| / 4) + 0.4 · Jaccard of colour identities (both colourless = 1)
     type      = 0.7 · Jaccard of card types + 0.2 · Jaccard of subtypes + 0.1 · same legendary status
     stats     = 1 − (|Δpower| + |Δtoughness|) / 8, or 1 − |Δloyalty| / 5 (only when the chosen card has P/T or loyalty)
   Stats are left out when the chosen card has no P/T or loyalty, and the rest are re-weighted. A card with no rules text
   matches other cards with no rules text on mechanics (1) and nothing else (0). */
const Similar = (function () {
  'use strict';
  const E = typeof Engine !== 'undefined' ? Engine : require('./engine.js');

  /* ---------- rules text → terms ---------- */
  const STOP = new Set('a an the of to and or that this it its is are be on in for with as at by'.split(' '));
  function words(low) {
    return String(low || '')
      .replace(/\{t\}/g, ' tapsym ').replace(/\{q\}/g, ' untapsym ').replace(/\{e\}/g, ' energysym ').replace(/\{[^}]+\}/g, ' manasym ')
      .replace(/\+(?:\d+|x)\/\+(?:\d+|x)/g, ' pluspt ').replace(/-(?:\d+|x)\/-(?:\d+|x)/g, ' minuspt ')
      .replace(/'s\b/g, '').replace(/\d+/g, ' num ').replace(/~/g, ' self ').replace(/[^a-z' ]+/g, ' ')
      .split(/\s+/).filter(w => w && !STOP.has(w) && w !== "'");
  }
  function terms(low) {
    const w = words(low), out = new Map();
    for (let i = 0; i < w.length; i++) {
      out.set(w[i], (out.get(w[i]) || 0) + 1);
      if (i) { const b = w[i - 1] + ' ' + w[i]; out.set(b, (out.get(b) || 0) + 1); }
    }
    return out;
  }

  /* ---------- mechanics: [id, label, group, test on rules text] ---------- */
  const MECH = [
    ['etb', 'Enters trigger', 'Triggers', /\bwhen(?:ever)? (?:~|this (?:creature|permanent|artifact|enchantment|land|vehicle))[^.]{0,30}? enters\b/],
    ['enters-other', 'Others entering', 'Triggers', /\bwhenever (?:a|an|another|one or more)\b[^.]{0,60}? enters?\b/],
    ['dies', 'Death trigger', 'Triggers', /\bwhen(?:ever)? [^.]{0,60}?\bdies\b|\bis put into (?:a|your|an opponent's) graveyard from the battlefield/],
    ['attacks', 'Attack trigger', 'Triggers', /\bwhen(?:ever)? [^.]{0,60}?\battacks?\b/],
    ['combat-dmg', 'Combat damage trigger', 'Triggers', /deals combat damage to (?:a player|an opponent|one or more players|that player|a player or planeswalker)/],
    ['cast-trig', 'Cast trigger', 'Triggers', /\bwhen(?:ever)? (?:you|a player|an opponent) casts?\b/],
    ['phase-trig', 'Upkeep / end step trigger', 'Triggers', /\bat the beginning of (?:your|each|the|each opponent|each player)[^.]{0,20}?(?:upkeep|end step|combat|main phase|draw step)/],
    ['ltb', 'Leaves the battlefield', 'Triggers', /leaves the battlefield/],
    ['sac-trig', 'Sacrifice trigger', 'Triggers', /whenever you sacrifice/],
    ['lifegain-trig', 'Lifegain trigger', 'Triggers', /whenever you gain life/],
    ['draw-trig', 'Draw trigger', 'Triggers', /whenever (?:you|a player|an opponent) draws?/],
    ['landfall', 'Landfall', 'Triggers', /\blandfall\b|whenever (?:a|one or more) lands? (?:you control )?enters?/],
    ['sac-outlet', 'Sacrifice outlet', 'Abilities', /sacrifice (?:a|an|another|one|two|x)\b[^.:]{0,40}:/],
    ['tap-ab', 'Tap ability', 'Abilities', /\{t\}[^:.]{0,40}:/],
    ['untap', 'Untap effects', 'Abilities', /\buntap (?:target|all|up to|each|it|~|another|those|that|two|one)\b/],
    ['cost-red', 'Cost reduction', 'Abilities', /\bcosts? (?:\{[^}]+\})+ less|\bcost (?:\{[^}]+\})+ less|\bcosts? x less|less to cast/],
    ['free-cast', 'Cast without paying', 'Abilities', /without paying (?:its|their|that card's|that spell's|this spell's|the) mana costs?/],
    ['cast-exile', 'Play from exile', 'Abilities', /(?:play|cast) [^.]{0,50}(?:from exile|exiled with|cards? exiled)/],
    ['copy', 'Copy effects', 'Abilities', /\bcopy (?:target|that|it|each|the next|this)\b|\bcopies of\b|that's a copy|becomes a copy/],
    ['anthem', 'Anthem (+N/+N)', 'Abilities', /you control get \+\d|creatures you control get \+/],
    ['evasion', 'Grants evasion', 'Abilities', /(?:gains?|have|has) (?:flying|trample|menace|shadow|fear|intimidate|horsemanship)|can't be blocked/],
    ['replace', 'Replacement effect', 'Abilities', /\bwould\b[^.]*(?:\binstead\b|that many plus|twice that many|plus one)/],
    ['doubler', 'Doubling', 'Abilities', /\btwice that many\b|\bdouble (?:the|that|its|their|target)\b|deals double/],
    ['modal', 'Modal (choose)', 'Abilities', /\bchoose (?:one|two|three|one or more|any number)\b/],
    ['lifeloss', 'Life loss', 'Abilities', /\b(?:loses?|lose) (?:\d+|x|that much|half) life/],
    ['discard', 'Discard', 'Abilities', /\bdiscards?\b/],
    ['top-lib', 'Top of library', 'Abilities', /top (?:card|\w+ cards|x cards) of (?:your|their|target player's|each player's|that player's) library/],
    ['monarch', 'Monarch', 'Abilities', /\bmonarch\b/],
    ['initiative', 'Initiative', 'Abilities', /\binitiative\b/],
    ['energy', 'Energy', 'Abilities', /\{e\}/],
    ['x-cost', 'X spell', 'Abilities', null, c => /\{X\}/.test(c.mc), /\bx\b/]
  ];
  const ROLE_LABEL = {
    'ramp-mana': 'Mana ability', 'ramp-land': 'Land ramp', 'ramp-drop': 'Extra land drop', 'draw-n': 'Card draw', 'draw-impulse': 'Impulse draw',
    'rm-destroy': 'Targeted destroy / exile', 'rm-burn': 'Burn removal', 'rm-bounce': 'Bounce', 'rm-counter': 'Counterspell', 'rm-shrink': '−N/−N removal',
    'rm-edict': 'Edict', 'rm-fight': 'Fight / bite', 'wipe-all': 'Board wipe', 'wipe-shrink': '−N/−N sweeper', 'wipe-dmg': 'Damage sweeper',
    'wipe-bounce': 'Mass bounce', 'wipe-sac': 'Mass sacrifice', 'prot-team': 'Team protection', 'prot-target': 'Targeted protection',
    'prot-self': 'Hexproof / phasing', 'prot-equip': 'Protective equipment / aura', 'rec-return': 'Graveyard return', 'rec-reanimate': 'Reanimation',
    'rec-cast': 'Cast from graveyard', 'win-alt': 'Alternate win', 'win-drain': 'Drain opponents', 'win-ping': 'Damage each opponent',
    'win-overrun': 'Overrun', 'win-combat': 'Extra combat', 'win-double': 'Damage doubling', 'win-infect': 'Infect / poison'
  };
  const FLAG_IDS = ['tutor', 'fast', 'stax', 'xturn', 'mld'];
  const THEME_IDS = ['aristocrats', 'spellslinger', 'voltron', 'reanimator', 'lifegain', 'artifacts', 'enchantress', 'blink', 'wheels', 'superfriends', 'burn', 'graveyard', 'combat'];
  const TOKEN_KINDS = ['treasure', 'food', 'clue', 'blood', 'map', 'powerstone', 'gold', 'incubator', 'junk', 'shard', 'role'];
  const CTR_SKIP = new Set(['a', 'an', 'the', 'that', 'those', 'these', 'its', 'their', 'each', 'all', 'any', 'more', 'of', 'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'x', 'many', 'additional', 'other', 'another', 'different', 'kind', 'type', 'such', 'his', 'her', 'your', 'with', 'single', 'same', 'number', 'total', 'put', 'remove', 'kinds', 'types', 'or', 'and', 'of', 'twice', 'half', 'n', 'distributed', 'divided', 'those', 'additional', 'them']);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Definition of one mechanic id: label, group, and a test that also works on a single line of rules text (for focus).
  const DEF = new Map();
  for (const [id, label, group, re, cardTest, lineRe] of MECH) DEF.set('m:' + id, { label, group, card: cardTest || (c => re.test(c.low)), line: l => (lineRe || re).test(l) });
  for (const role of E.ROLES) for (const r of E.ROLE_RULES[role]) if (ROLE_LABEL[r.id]) DEF.set('r:' + r.id, { label: ROLE_LABEL[r.id], group: 'Roles', card: c => r.test(c), line: l => r.test({ low: l, kw: [], ft: '', pow: null }) });
  for (const f of FLAG_IDS) DEF.set('f:' + f, { label: E.FLAGS[f].label, group: 'Roles', card: c => !!E.analyze(c).flags[f], line: l => E.FLAGS[f].test({ low: l, kw: [], ft: 'Artifact', cmc: 9 }) });
  for (const t of THEME_IDS) { const T = E.TAGS[t]; if (T && T.re) DEF.set('t:' + t, { label: T.label, group: 'Themes', card: c => T.re.test(c.low), line: l => T.re.test(l) }); }
  function defOf(id) {
    let d = DEF.get(id); if (d) return d;
    const [k, v] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if (k === 'kw') { const re = new RegExp('\\b' + escRe(v) + '\\b'); d = { label: cap(v), group: 'Keywords', card: c => c.kw.includes(v), line: l => re.test(l) }; }
    else if (k === 'ctr') { const re = new RegExp(escRe(v) + ' counters?\\b'); d = { label: (v === '+1/+1' || v === '-1/-1' ? v : cap(v)) + ' counters', group: 'Counters and tokens', card: c => re.test(c.low), line: l => re.test(l) }; }
    else if (k === 'tok') { const re = v === 'creature' ? /creates? [^.]*creature tokens?/ : v === 'copy' ? /token that's a copy|tokens? that are copies/ : new RegExp('creates? [^.]*\\b' + escRe(v) + '\\b'); d = { label: v === 'creature' ? 'Creature tokens' : v === 'copy' ? 'Token copies' : cap(v) + ' tokens', group: 'Counters and tokens', card: c => re.test(c.low), line: l => re.test(l) }; }
    else d = { label: id, group: 'Other', card: () => false, line: () => false };
    DEF.set(id, d); return d;
  }
  // All mechanic ids of one card.
  function mechanics(c) {
    const out = [];
    if (!c.low && !c.kw.length && !/\{X\}/.test(c.mc)) return out;
    for (const [id, d] of DEF) if (/^(?:m|r|f|t):/.test(id) && d.card(c)) out.push(id);
    for (const k of c.kw) out.push('kw:' + k);
    const re = /(\+1\/\+1|-1\/-1|[a-z]+) counters?\b/g; let m; const ctr = new Set();
    while ((m = re.exec(c.low))) if (!CTR_SKIP.has(m[1])) ctr.add(m[1]);
    for (const x of ctr) out.push('ctr:' + x);
    const tr = /creates? ([^.]*?)tokens?\b/g; const tok = new Set();
    while ((m = tr.exec(c.low))) { const ph = m[1]; for (const k of TOKEN_KINDS) if (new RegExp('\\b' + k + '\\b').test(ph)) tok.add(k); if (/\bcreature\b/.test(ph)) tok.add('creature'); }
    if (/token that's a copy|tokens? that are copies/.test(c.low)) tok.add('copy');
    for (const x of tok) out.push('tok:' + x);
    return [...new Set(out)];
  }

  /* ---------- type, stats ---------- */
  const TYPES = ['Creature', 'Artifact', 'Enchantment', 'Instant', 'Sorcery', 'Land', 'Planeswalker', 'Battle', 'Kindred'];
  function typeInfo(c) {
    const ft = c.ft || '', [left, right] = ft.split('—');
    return { types: TYPES.filter(t => new RegExp('\\b' + t + '\\b').test(left || '')), subs: (right || '').trim().split(/\s+/).filter(Boolean), leg: /\bLegendary\b/.test(left || '') };
  }
  function statsOf(c) {
    const pt = /^([^/\s]+)\/([^/\s]+)$/.exec(c.pt || ''), ly = /^Loyalty (\S+)$/.exec(c.pt || '');
    const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
    if (pt) return { kind: 'pt', p: n(pt[1]), t: n(pt[2]) };
    if (ly) return { kind: 'loy', l: n(ly[1]) };
    return null;
  }
  const jacc = (A, B) => { if (!A.length && !B.length) return 1; let i = 0; for (const x of A) if (B.includes(x)) i++; return i / (A.length + B.length - i); };

  /* ---------- index: built once per card file ---------- */
  async function build(db, onProgress) {
    const cards = db.all, N = cards.length, tick = async i => { if (i % 3000 === 0) { if (onProgress) onProgress(i / N / 2 + (tick.half ? 0.5 : 0)); await new Promise(r => setTimeout(r, 0)); } };
    const df = new Map();
    for (let i = 0; i < N; i++) { for (const t of terms(cards[i].low).keys()) df.set(t, (df.get(t) || 0) + 1); await tick(i); }
    const vocab = new Map(), idf = [];
    for (const [t, d] of df) if (d >= 2 && d <= N * 0.4) { vocab.set(t, idf.length); idf.push(Math.log(N / d)); }
    tick.half = true;
    const off = new Int32Array(N + 1), ids = [], ws = [];
    const fids = new Map(), fdf = [], fOff = new Int32Array(N + 1), fl = [];
    const tinfo = new Array(N), sinfo = new Array(N);
    for (let i = 0; i < N; i++) {
      const c = cards[i], tm = terms(c.low), row = [];
      let norm = 0;
      for (const [t, n] of tm) { const id = vocab.get(t); if (id == null) continue; const w = (1 + Math.log(n)) * idf[id]; row.push([id, w]); norm += w * w; }
      norm = Math.sqrt(norm) || 1; row.sort((a, b) => a[0] - b[0]);
      for (const [id, w] of row) { ids.push(id); ws.push(w / norm); }
      off[i + 1] = ids.length;
      for (const f of mechanics(c)) { let k = fids.get(f); if (k == null) { k = fdf.length; fids.set(f, k); fdf.push(0); } fdf[k]++; fl.push(k); }
      fOff[i + 1] = fl.length;
      tinfo[i] = typeInfo(c); sinfo[i] = statsOf(c);
      await tick(i);
    }
    const fname = []; for (const [f, k] of fids) fname[k] = f;
    const fw = Float32Array.from(fdf, d => Math.log((N + 1) / d));
    const pos = new Map(); cards.forEach((c, i) => pos.set(c, i));
    if (onProgress) onProgress(1);
    return { cards, N, vocab, idf: Float32Array.from(idf), off, ids: Int32Array.from(ids), ws: Float32Array.from(ws), fname, fids, fw, fOff, fl: Int32Array.from(fl), tinfo, sinfo, pos };
  }
  function cardFeats(X, i) { return X.fl.subarray(X.fOff[i], X.fOff[i + 1]); }
  function vecOf(X, low) {
    const tm = terms(low), v = new Map(); let norm = 0;
    for (const [t, n] of tm) { const id = X.vocab.get(t); if (id == null) continue; const w = (1 + Math.log(n)) * X.idf[id]; v.set(id, w); norm += w * w; }
    norm = Math.sqrt(norm) || 1; for (const [k, w] of v) v.set(k, w / norm); return v;
  }
  const cosMap = (a, b) => { let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const [k, w] of x) { const u = y.get(k); if (u) s += w * u; } return s; };
  const lines = low => String(low || '').split('\n').map(s => s.trim()).filter(Boolean);
  function focusText(c, fid) { const d = defOf(fid), L = lines(c.low).filter(l => d.line(l)); return L.length ? L.join('\n') : c.low; }

  /* ---------- ranking ----------
     opts: { weights: {mech, cost, type, stats}, focus: mechanic id or '', filter: c => boolean, limit } */
  function rank(X, card, opts) {
    opts = opts || {};
    const W = Object.assign({ mech: 60, cost: 20, type: 12, stats: 8 }, opts.weights || {});
    const qi = X.pos.get(card); if (qi == null) return { list: [], parts: {} };
    const q = new Float32Array(X.idf.length), qo = X.off[qi], qe = X.off[qi + 1];
    for (let j = qo; j < qe; j++) q[X.ids[j]] = X.ws[j];
    const hasText = qe > qo;
    const qf = cardFeats(X, qi), qfs = new Set(qf); let qfw = 0; for (const k of qf) qfw += X.fw[k];
    const hasFeat = qf.length > 0;
    const qt = X.tinfo[qi], qs = X.sinfo[qi], qci = card.ci.split('');
    const vanilla = !hasText && !hasFeat; // no rules text: other cards without rules text match on mechanics, the rest do not
    const use = { mech: W.mech > 0, cost: W.cost > 0, type: W.type > 0, stats: !!qs && W.stats > 0 };
    const wsum = (use.mech ? W.mech : 0) + (use.cost ? W.cost : 0) + (use.type ? W.type : 0) + (use.stats ? W.stats : 0) || 1;
    const focus = opts.focus || '', fk = focus ? X.fids.get(focus) : null;
    const qFocus = focus ? vecOf(X, focusText(card, focus)) : null;
    const filter = opts.filter || (() => true), out = [];
    for (let i = 0; i < X.N; i++) {
      if (i === qi) continue;
      const c = X.cards[i]; if (c.oid === card.oid || !filter(c)) continue;
      const cf = cardFeats(X, i);
      if (focus && (fk == null || !cf.includes(fk))) continue;
      let text = 0; for (let j = X.off[i], e = X.off[i + 1]; j < e; j++) { const v = q[X.ids[j]]; if (v) text += v * X.ws[j]; }
      let inter = 0, uni = qfw; for (const k of cf) { if (qfs.has(k)) inter += X.fw[k]; else uni += X.fw[k]; }
      const feat = uni ? inter / uni : 0;
      text = Math.min(1, text);
      const mech = vanilla ? (X.off[i + 1] === X.off[i] && !cf.length ? 1 : 0) : hasText && hasFeat ? 0.5 * text + 0.5 * feat : hasText ? text : feat;
      const cost = 0.6 * Math.max(0, 1 - Math.abs(c.cmc - card.cmc) / 4) + 0.4 * jacc(qci, c.ci.split(''));
      const ti = X.tinfo[i], type = 0.7 * jacc(qt.types, ti.types) + 0.2 * jacc(qt.subs, ti.subs) + 0.1 * (qt.leg === ti.leg ? 1 : 0);
      let stats = 0; const si = X.sinfo[i];
      if (qs && si && qs.kind === si.kind) stats = qs.kind === 'pt' ? Math.max(0, 1 - (Math.abs(qs.p - si.p) + Math.abs(qs.t - si.t)) / 8) : Math.max(0, 1 - Math.abs(qs.l - si.l) / 5);
      const parts = { mech: use.mech ? mech : null, cost: use.cost ? cost : null, type: use.type ? type : null, stats: use.stats ? stats : null };
      const overall = ((use.mech ? W.mech * mech : 0) + (use.cost ? W.cost * cost : 0) + (use.type ? W.type * type : 0) + (use.stats ? W.stats * stats : 0)) / wsum;
      out.push({ c, i, overall, score: overall, text, feat, parts });
    }
    out.sort((a, b) => b.score - a.score);
    let list = out;
    if (focus) {
      // focus: half the score is how alike the two cards' lines with that mechanic are, half the overall match
      const pre = out.slice(0, Math.max(400, opts.limit || 0));
      for (const r of pre) { r.focus = Math.min(1, cosMap(qFocus, vecOf(X, focusText(r.c, focus)))); r.score = 0.5 * r.focus + 0.5 * r.overall; }
      pre.sort((a, b) => b.score - a.score); list = pre;
    }
    list = list.slice(0, opts.limit || 100);
    for (const r of list) r.shared = [...cardFeats(X, r.i)].filter(k => qfs.has(k)).sort((a, b) => X.fw[b] - X.fw[a]).map(k => X.fname[k]);
    return { list, total: out.length, use, W };
  }
  // Mechanic ids of a card, rarest first (most distinctive), with labels and groups.
  function cardMechanics(X, card) {
    const i = X.pos.get(card); if (i == null) return [];
    return [...cardFeats(X, i)].sort((a, b) => X.fw[b] - X.fw[a]).map(k => { const id = X.fname[k], d = defOf(id); return { id, label: d.label, group: d.group, cards: Math.round((X.N + 1) / Math.exp(X.fw[k])) }; });
  }

  /* ---------- 2-card combos from Commander Spellbook (Engine.localComboProvider) ---------- */
  function combos(provider, name) {
    const list = provider && provider.byCard.get(name) || [];
    const two = [], seen = new Set(); let more = 0;
    for (const v of list) {
      if (seen.has(v.id)) continue; seen.add(v.id);
      const u = [...new Set(v.c)];
      if (u.length === 2) two.push({ v, partner: u.find(n => n !== name) }); else if (u.length > 2) more++;
    }
    two.sort((a, b) => (b.v.pop || 0) - (a.v.pop || 0) || a.v.r - b.v.r);
    return { two, more };
  }

  return { words, terms, mechanics, defOf, typeInfo, statsOf, build, rank, cardMechanics, combos, focusText };
})();
if (typeof module !== 'undefined') module.exports = Similar;
