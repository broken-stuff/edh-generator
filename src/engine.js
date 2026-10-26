/* ===== Engine: pure deck-generation logic (no DOM, no network) ===== */
const Engine = (function () {
  'use strict';
  const WUBRG = 'WUBRG';
  const BASIC_NAMES = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest', C: 'Wastes' };
  const ROLES = ['ramp', 'draw', 'removal', 'wipes', 'protection', 'recursion', 'wincon'];
  const SLOT_LABEL = { commander: 'Commander', include: 'Include', locked: 'Locked', land: 'Land', basic: 'Basic land',
    ramp: 'Ramp', draw: 'Card draw', removal: 'Targeted removal', wipes: 'Board wipe', protection: 'Protection',
    recursion: 'Recursion', wincon: 'Win condition', synergy: 'Synergy', flex: 'Flex', combo: 'Combo piece' };
  const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar']);
  const BRACKETS = {
    // Commander Brackets as of the Oct 21 2025 update (unchanged by Feb 9 2026): tutor limits removed from all brackets.
    // turns = expected game length the bracket is built for. xturn 1/2 for B2/B3 encode "low quantity, not chained or looped".
    1: { name: 'Exhibition', turns: '9+', gc: 0, mld: 0, xturn: 0, tutor: 999, combo2: 0 },
    2: { name: 'Core', turns: '8+', gc: 0, mld: 0, xturn: 1, tutor: 999, combo2: 0 },
    3: { name: 'Upgraded', turns: '6+', gc: 3, mld: 0, xturn: 2, tutor: 999, combo2: 0 },
    4: { name: 'Optimized', turns: '4+', gc: 999, mld: 999, xturn: 999, tutor: 999, combo2: 999 },
    5: { name: 'cEDH', turns: 'any', gc: 999, mld: 999, xturn: 999, tutor: 999, combo2: 999 }
  };

  /* ---------- utils ---------- */
  function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function stable(o) { if (o === null || typeof o !== 'object') return JSON.stringify(o); if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']'; return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'; }
  function pnum(v) { const n = v == null ? NaN : parseFloat(v); return isFinite(n) ? n : null; }
  function nameKey(s) { return String(s || '').replace(/Æ/g, 'Ae').replace(/æ/g, 'ae').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim(); }
  function stripReminder(s) { return s.replace(/\([^)]*\)/g, ''); }
  function subsetCI(ci, CI) { for (const x of ci) if (!CI.includes(x)) return false; return true; }
  function deepMerge(base, over) {
    if (over == null || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(over)) {
      const b = base ? base[k] : undefined, v = over[k];
      out[k] = (b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(b, v) : v;
    }
    return out;
  }
  const r2 = x => Math.round(x * 100) / 100;

  /* ---------- defaults ---------- */
  function defaults() {
    return {
      v: 1, commanders: ['', ''], bracket: 3, bl: Object.assign({}, BRACKETS[3]),
      archetype: '', tags: '',
      budget: { total: null, perCard: null, cur: 'usd', inclBasics: true, unknown: 'exclude' },
      targets: { lands: 37, ramp: 10, draw: 10, removal: 9, wipes: 3, protection: 3, recursion: 2, wincon: 3 },
      mana: { avgMV: 3.0, nonbasic: null, types: { fetch: true, shock: true, dual: true, triome: true, utility: true, command: true } },
      include: '', exclude: '',
      filters: { combos: 'bracket', tutors: 'allow', fast: 'allow', stax: 'allow', xturn: 'allow', mld: 'allow', hate: 'allow',
        reserved: 'allow', funny: 'exclude', dateFrom: '', dateTo: '', sets: '', creaturesMin: null, creaturesMax: null },
      owned: { mode: 'off', list: '' },
      seed: '', reroll: 0, variance: 0,
      weights: { syn: 1.5, role: 1.5, pop: 5, quality: 2, curve: 1.5, price: 0.25, owned: 1, bracket: 0.5, power: 2, link: 1 }
    };
  }
  function bracketDefaults(b) { return Object.assign({}, BRACKETS[b] || BRACKETS[3]); }

  /* ---------- normalization of Scryfall card objects ---------- */
  // P/T, loyalty or defense for display; image path on cards.scryfall.io (shown only when the user turns images on)
  const ptOf = f => f.power != null ? f.power + '/' + f.toughness : f.loyalty != null ? 'Loyalty ' + f.loyalty : f.defense != null ? 'Defense ' + f.defense : '';
  function imgOf(u) { const m = u && typeof u.normal === 'string' && /^https:\/\/cards\.scryfall\.io\/normal\/(front\/[0-9a-f]\/[0-9a-f]\/[0-9a-f-]+\.jpg)/.exec(u.normal); return m ? m[1] : ''; }
  function norm(c) {
    if (!c || typeof c !== 'object' || !c.name || c.object === 'list') return null;
    if (SKIP_LAYOUTS.has(c.layout)) return null;
    if (c.lang && c.lang !== 'en') return null;
    const faces = Array.isArray(c.card_faces) ? c.card_faces : null;
    const name = c.name, fn = name.split(' // ')[0];
    const ot = c.oracle_text != null ? c.oracle_text : (faces ? faces.map(f => f.oracle_text || '').join('\n') : '');
    const mc = c.mana_cost ? c.mana_cost : (faces ? faces.map(f => f.mana_cost || '').filter(Boolean).join(' // ') : '');
    const tl = c.type_line || (faces ? faces.map(f => f.type_line || '').join(' // ') : '');
    const ft = tl.split(' // ')[0];
    let low = stripReminder(ot).toLowerCase();
    const nm = new Set([name, fn].concat(faces ? faces.map(f => f.name) : []).filter(Boolean).map(x => x.toLowerCase()));
    for (const n of [...nm].sort((a, b) => b.length - a.length)) low = low.split(n).join('~');
    const pr = c.prices || {};
    const pw = c.power != null ? c.power : (faces && faces[0] ? faces[0].power : null);
    return {
      n: name, fn, oid: c.oracle_id || (faces && faces[0] && faces[0].oracle_id) || c.id, mc, cmc: +c.cmc || 0, tl, ft, ot, low,
      ci: WUBRG.split('').filter(x => (c.color_identity || []).includes(x)).join(''),
      leg: (c.legalities && c.legalities.commander) || 'not_legal', gc: !!c.game_changer,
      rank: Number.isFinite(c.edhrec_rank) ? c.edhrec_rank : null,
      p: { usd: pnum(pr.usd), eur: pnum(pr.eur), tix: pnum(pr.tix) },
      rl: !!c.reserved, bc: c.border_color || '', stamp: c.security_stamp || '', stype: c.set_type || '',
      sets: c.set ? [c.set] : [], first: c.released_at || '', last: c.released_at || '',
      kw: (c.keywords || []).map(k => String(k).toLowerCase()), pm: Array.isArray(c.produced_mana) ? c.produced_mana : [],
      pow: pnum(pw), uri: c.scryfall_uri || '', otags: [], al: [c.flavor_name].concat(faces ? faces.map(f => f.flavor_name) : []).filter(x => x && x !== name && x !== fn),
      pt: ptOf(c.power != null || c.loyalty != null || c.defense != null ? c : (faces && faces[0]) || {}), img: imgOf(c.image_uris || (faces && faces[0] && faces[0].image_uris))
    };
  }
  function mergeCard(a, b) {
    for (const s of b.sets) if (!a.sets.includes(s)) a.sets.push(s);
    if (b.first && (!a.first || b.first < a.first)) a.first = b.first;
    if (b.last && (!a.last || b.last > a.last)) a.last = b.last;
    for (const k of ['usd', 'eur', 'tix']) if (b.p[k] != null && (a.p[k] == null || b.p[k] < a.p[k])) a.p[k] = b.p[k];
    if (b.rank != null && (a.rank == null || b.rank < a.rank)) a.rank = b.rank;
    a.gc = a.gc || b.gc; a.rl = a.rl || b.rl;
    for (const t of b.otags) if (!a.otags.includes(t)) a.otags.push(t);
    if (b.al && b.al.length) { a.al = a.al || []; for (const x of b.al) if (!a.al.includes(x)) a.al.push(x); }
    a.merged = (a.merged || 1) + 1;
  }
  function buildDB(cards, meta) {
    const byOid = new Map();
    for (const c of cards) { if (!c) continue; const e = byOid.get(c.oid); if (e) mergeCard(e, c); else byOid.set(c.oid, c); }
    const all = [...byOid.values()].sort((a, b) => a.n < b.n ? -1 : a.n > b.n ? 1 : 0);
    const byName = new Map();
    // a name shared by two cards (Mystery Booster playtest cards, Alchemy, tokens) means the real one: Commander-legal first, then not from an Un/playtest set
    const rank = c => (c.leg === 'legal' ? 2 : 0) + (c.stype === 'funny' || c.bc === 'silver' ? 0 : 1);
    for (const c of all) for (const k of [c.n, c.fn]) { const key = nameKey(k), e = byName.get(key); if (!e || rank(c) > rank(e)) byName.set(key, c); }
    for (const c of all) for (const k of c.n.split(' // ').slice(1).concat(c.al || [])) { const key = nameKey(k); if (!byName.has(key)) byName.set(key, c); } // back faces and printed alternate names, only where no card has that name
    return { all, byName, meta: meta || {}, _ctypes: null };
  }
  // pairs: [[alternate name, Oracle name], ...] (data/aliases.json: Universes Beyond flavour names such as "Rick, Steadfast Leader")
  function addAliases(db, pairs) {
    let n = 0;
    for (const [al, on] of pairs || []) { const key = nameKey(al), c = db.byName.get(nameKey(on)); if (c && !db.byName.has(key)) { db.byName.set(key, c); n++; } }
    return n;
  }
  // exact name first; then the same name with "/", "///" or unspaced "//" between faces, then the front face alone
  function lookup(db, name) {
    const k = nameKey(name), hit = db.byName.get(k); if (hit) return hit;
    if (!/\//.test(k)) return null;
    const faces = k.split(/\s*\/{1,3}\s*/).filter(Boolean);
    return db.byName.get(faces.join(' // ')) || db.byName.get(faces[0]) || null;
  }

  /* ---------- list parsing (decklists, collections) ---------- */
  function parseList(text) {
    const out = [];
    const lines = String(text || '').split(/\r?\n/);
    let csvName = -1, csvQty = -1;
    if (lines.length && /,/.test(lines[0]) && /\bname\b/i.test(lines[0])) {
      const h = splitCSV(lines[0]).map(x => x.toLowerCase().trim());
      csvName = h.indexOf('name'); csvQty = h.findIndex(x => x === 'count' || x === 'quantity' || x === 'qty');
      if (csvName >= 0) lines.shift();
    }
    for (let line of lines) {
      if (csvName >= 0) { const f = splitCSV(line); if (f[csvName]) out.push({ qty: csvQty >= 0 ? (parseInt(f[csvQty], 10) || 1) : 1, name: f[csvName].trim() }); continue; }
      line = line.trim();
      if (!line || /^(#|\/\/)/.test(line)) continue;
      if (/^(commander|deck|sideboard|maybeboard|companion|mainboard)\s*:?$/i.test(line)) continue;
      const it = parseLine(line);
      if (it) out.push(it);
    }
    return out;
  }
  // one decklist line: "1 Name", "1x Name", "Name x1", plus what Moxfield, Archidekt, MTGA and others append
  // (set code and collector number, *F* / *E* foil marks, [Category{flags}], ^Tag,#colour^, #tags)
  function parseLine(line) {
    line = String(line || '').replace(/\t/g, ' ').trim();
    let qty = 1, name = line, m;
    if ((m = line.match(/^(\d+)\s*x?\s+(.+)$/i)) || (m = line.match(/^x(\d+)\s+(.+)$/i))) { qty = parseInt(m[1], 10); name = m[2]; }
    else if ((m = line.match(/^(.+?)\s+\(?x(\d+)\)?$/i))) { qty = parseInt(m[2], 10); name = m[1]; }
    name = name.replace(/\s+\^[^^]*\^/g, '').replace(/\s+#\S.*$/, '').replace(/\s+\*[A-Za-z]+\*/g, '').replace(/(?:\s+\[[^\]]*\])+\s*$/, '')
      .replace(/\s+[([][A-Za-z0-9]{2,6}(?:-[A-Za-z0-9]{1,4})?[)\]](\s+[\w★†-]+)?\s*$/, '').replace(/\s+\*[A-Za-z]+\*\s*$/, '').trim();
    return name ? { qty: Math.max(1, qty), name } : null;
  }
  function splitCSV(line) { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; }

  /* ---------- tagging rules (all data-derived from oracle text / type line / Scryfall fields) ---------- */
  const rx = (id, desc, re) => ({ id, desc, test: typeof re === 'function' ? re : (c => re.test(c.low)) });
  const ROLE_RULES = {
    ramp: [
      rx('ramp-mana', 'non-land with a mana ability: "add {X}" / "add N mana"', /\badd \{[wubrgcs]\}|\badd (?:one|two|three|x) mana|\badd [^.]{0,30}mana of any/),
      rx('ramp-land', 'searches library for land or basic land type card(s) onto the battlefield', /search your library for [^.]{0,80}\b(?:land|plains|island|swamp|mountain|forest|wastes) cards?[\s\S]{0,160}?onto the battlefield/),
      rx('ramp-aura', 'aura on a land that adds extra mana when it is tapped', /whenever enchanted (?:land|plains|island|swamp|mountain|forest) is tapped for mana, its controller adds an additional/),
      rx('ramp-drop', 'extra land drop / put land from hand onto battlefield', /play (?:an|two|x) additional lands?|put (?:a|up to \w+) land cards? from your hand onto the battlefield/),
      rx('ramp-treasure', 'creates Treasure tokens', /\bcreates?[^.]{0,30}treasure/)
    ],
    draw: [
      rx('draw-n', '"draw N card(s)"', /\bdraws? (?:a|an|one|two|three|four|five|six|seven|x|\d+|that many|cards equal)(?: additional)? cards?\b|\bdraws? cards equal/),
      rx('draw-impulse', 'exile top card(s), you may play/cast them', /exile the top [^.]*?cards? of your library[^.]*\.[^.]*you may (?:play|cast)/),
      rx('draw-clue', 'investigate / creates Clues', /\binvestigates?\b|creates?[^.]{0,20}\bclue/),
      rx('draw-top', 'play lands or cast spells from the top of your library', /you may (?:play|cast) [^.]{0,40}from the top of your library/)
    ],
    removal: [
      rx('rm-destroy', '"destroy/exile target <permanent>" (not "you control", not cards in graveyards)', /\b(?:destroy|exile) (?:up to (?:one|two|three|x) )?(?:another )?target (?:(?:nonland|noncreature|nonartifact|tapped|attacking|blocking|nontoken|legendary|artifact or|creature or|enchantment or|artifact,) )*(?:creature|artifact|enchantment|planeswalker|permanent|land|battle)s?(?!s? (?:you control|card))/),
      rx('rm-burn', 'deals damage to target creature/planeswalker or any target', /\bdeals? [^.]{0,40}?damage to (?:any target|target creature|target planeswalker|up to one target creature|another target creature)/),
      rx('rm-bounce', 'returns target nonland permanent to owner\'s hand', /\breturn (?:up to one )?target (?:nonland |creature |artifact |enchantment )*(?:permanent|creature|artifact|enchantment|planeswalker)(?! you control)[^.]* to (?:its|their) owner'?s'? hands?/),
      rx('rm-counter', 'counter target spell/ability', /\bcounter target (?:(?:white|blue|black|red|green|multicolored|colorless) )?(?:spell|creature spell|noncreature spell|artifact|instant|activated|activated or triggered|instant or sorcery|enchantment)/),
      rx('rm-shrink', 'target creature gets -N/-N', /\btarget creature(?: an opponent controls)? gets -(?:\d+|x)\/-(?:\d+|x)/),
      rx('rm-edict', 'target player/each opponent sacrifices a creature/permanent', /\b(?:target player|target opponent|each opponent) sacrifices (?:a|an|one|two|x|that many)? ?(?:creature|nontoken creature|attacking creature|nonland permanent|permanent|artifact|enchantment|planeswalker)/),
      rx('rm-tuck', 'shuffles or puts target permanent into its owner\'s library', /\bthe owner of target (?:nonland )?permanent shuffles it into their library|\bput target (?:nonland )?(?:permanent|creature)[^.]{0,30} (?:on (?:the )?(?:top|bottom) of|into) its owner'?s library/),
      rx('rm-fight', 'fight / bite a target creature', /\bfights? (?:another |up to one )?target creature|target creature you control (?:fights|deals damage equal)/)
    ],
    wipes: [
      rx('wipe-all', '"destroy/exile all creatures/nonland permanents/…"', /\b(?:destroy|exile) all (?:other )?(?:creatures|nonland permanents|permanents|artifacts|enchantments|planeswalkers|nontoken creatures|creatures and planeswalkers|artifacts and enchantments|nonland, nontoken permanents|creatures your opponents control|nonland permanents your opponents control|attacking creatures)/),
      rx('wipe-shrink', 'all/each creature(s) get -N/-N', /\ball (?:other )?creatures get -(?:\d+|x)\/-(?:\d+|x)|\beach creature gets -/),
      rx('wipe-dmg', 'deals N damage to each creature', /\bdeals? (?:\d+|x) damage to each (?:other )?creature/),
      rx('wipe-bounce', 'returns all permanents/creatures to hand', /\breturn all (?:other )?(?:nonland )?(?:permanents|creatures)[^.]* to (?:their|its) owners'? hands?/),
      rx('wipe-sac', 'each player sacrifices all creatures', /\beach (?:player|opponent) sacrifices (?:all|x|\w+teen|ten|eleven|twelve|twenty) (?:creatures|nonland permanents)/)
    ],
    protection: [
      rx('prot-team', 'permanents/creatures you control gain hexproof/indestructible/shroud/protection', /(?:creatures|permanents|commanders?|nonland permanents|artifacts) you control (?:gain|have|get [^.]{0,30}and gain) (?:[^.]{0,40}?\b)?(?:hexproof|indestructible|shroud|protection)/),
      rx('prot-target', 'target permanent you control gains protection / phases out', /target (?:creature|permanent|artifact|nonland permanent)(?: or [a-z]+)? you control (?:gains|has|phases out)|target (?:creature|permanent) you control\. (?:it|that creature) gains (?:hexproof|indestructible|shroud|protection)/),
      rx('prot-blink', 'exile target permanent you control, then return it (dodges removal)', /\bexile (?:up to one )?(?:another )?target (?:creature|permanent|nonland permanent|artifact or creature)s? you control,? then return (?:it|that card|them|those cards) to the battlefield/),
      rx('prot-redirect', 'changes the target of a spell or ability', /\b(?:change the target of|choose new targets for) target spell/),
      rx('prot-self', 'you have hexproof/shroud; phase out', /\byou have (?:hexproof|shroud)|\bphases? out\b/),
      rx('prot-counter', 'counter target spell that targets', /counter target [^.]{0,40}that targets/),
      rx('prot-equip', 'equipped/enchanted creature has hexproof/indestructible/shroud/protection/ward', /(?:equipped|enchanted) creature (?:[^.]{0,30}\band )?(?:has|gains|gets [^.]{0,20}and has) (?:[^.]{0,30}?\b)?(?:hexproof|indestructible|shroud|protection|ward)/)
    ],
    recursion: [
      rx('rec-return', 'return card(s) from graveyard to hand/battlefield', /\breturn (?:target|up to (?:one|two|three|x) target|a|an|all|each|another target|any number of target|x target)[^.]*?cards?\b[^.]{0,40}? from (?:your|a|any) graveyard (?:to (?:your hand|the battlefield)|onto the battlefield)/),
      rx('rec-reanimate', 'put card(s) from a graveyard onto the battlefield', /put [^.]*cards? from (?:your|a|all|their|an opponent's) graveyards? onto the battlefield/),
      rx('rec-aura', 'aura that returns a creature card from a graveyard', /\benchant creature card in a graveyard/),
      rx('rec-chosen', 'chooses creature cards in your graveyard and returns them to the battlefield', /target [^.]{0,30}cards? in (?:your|a) graveyard[\s\S]{0,140}?return [^.]{0,30}to (?:the battlefield|your hand)/),
      rx('rec-cast', 'cast/play cards from your graveyard (reminder text excluded)', /\b(?:cast|play) [^.]{0,60}from your graveyard/)
    ],
    wincon: [
      rx('win-alt', '"you win the game" / "loses the game"', /you win the game|(?:target player|that player|each opponent|all opponents|each other player) loses the game/),
      rx('win-drain', 'each opponent loses N life', /each opponent loses (?:\d+|x|that much|life equal)/),
      rx('win-ping', 'deals damage to each opponent', /\bdeals? [^.]{0,30}damage to each opponent/),
      rx('win-overrun', 'creatures you control get +N/+N until end of turn', /creatures you control (?:gain [^.]{0,40}and )?get \+(?:\d+|x)\/\+(?:\d+|x)[^.]*until end of turn/),
      rx('win-burst', 'deals 10 or more (or X) damage to a player or any target', /\bdeals? [1-9]\d+ damage to (?:any target|target player|target opponent|each opponent)|\bdeals? x damage to (?:target player|target opponent|each opponent)/),
      rx('win-threaten', 'gains control of all creatures until end of turn', /gain control of all creatures|untap all creatures and gain control of them/),
      rx('win-combat', 'additional combat phase', /additional combat phase|extra combat/),
      rx('win-double', 'doubles damage', /deals double|double (?:the )?damage/),
      rx('win-infect', 'infect / toxic / poison', c => c.kw.includes('infect') || /\bpoison counters?\b/.test(c.low)),
      rx('win-big', 'creature with power ≥ 7 (Scryfall power)', c => /\bCreature\b/.test(c.ft) && c.pow != null && c.pow >= 7)
    ]
  };
  const STAX_RE = /(?:spells?|abilities)[^.]{0,40}cost \{\d\} more|(?:each player|each opponent|your opponents|players|that player)[^.]{0,40}can't (?:cast|search|untap|activate|draw|attack|play|gain)|(?:don't|doesn't) untap during (?:their|its) controllers?'? untap steps?|(?:permanents|creatures|artifacts|lands|nonland permanents) (?:your opponents control )?enter(?: the battlefield)? tapped/;
  const FLAGS = {
    gc: { label: 'Game Changer', desc: 'Scryfall field game_changer = true', test: c => c.gc },
    tutor: { label: 'Tutor', desc: '"search your library for" a card that is not a land / basic type', test: c => { const re = /search your library for ([^.]*)/g; let m; while ((m = re.exec(c.low))) { if (!/\bland\b|\blands\b|plains|island|swamp|mountain|forest/.test(m[1])) return true; } return c.kw.includes('transmute'); } },
    xturn: { label: 'Extra turn', desc: '"take an extra turn"', test: c => /takes? (?:an|one|two|x|that many)? ?extra turns?/.test(c.low) },
    mld: { label: 'Mass land denial', desc: 'destroy/exile/return all lands, sacrifice multiple lands, or lands don\'t untap', test: c => /(?:destroy|exile|return) all (?:nonbasic )?lands\b|(?:destroy|exile) all permanents\b|each player sacrifices [^.]{0,20}lands\b|sacrifices? all lands|lands (?:don't|do not) untap|lands? (?:your opponents control |players control )?(?:don't|can't) untap/.test(c.low) },
    fast: { label: 'Fast mana', desc: '≤1 MV mana artifact, or instant/sorcery adding more mana than its MV', test: c => { if (/\bLand\b/.test(c.ft)) return false; if (/\bArtifact\b/.test(c.ft) && c.cmc <= 1 && /\badd \{|\badd (?:one|two|three) mana|\badd [^.]{0,30}mana of any/.test(c.low) && !/^\{\d+\}, \{t\}: add (?:one mana|\{[wubrgc]\}\.)/m.test(c.low)) return true; if (/\b(?:Instant|Sorcery)\b/.test(c.ft)) { const m = c.low.match(/\badd ((?:\{[wubrgc]\})+)/); if (m && (m[1].match(/\{/g) || []).length > c.cmc) return true; } return false; } },
    stax: { label: 'Stax', desc: 'taxes/restricts opponents: "cost {N} more", "can\'t …", "don\'t untap", "enter tapped"', test: c => STAX_RE.test(c.low) },
    hate: { label: 'Hate-bear', desc: 'creature with MV ≤ 3 that matches the stax rule', test: c => /\bCreature\b/.test(c.ft) && c.cmc <= 3 && STAX_RE.test(c.low) }
  };
  const TAGS = {
    counters: { label: '+1/+1 counters', re: /\+1\/\+1 counters?|\bproliferate/, q: '(o:"+1/+1 counter" or o:proliferate)' },
    tokens: { label: 'Tokens', re: /\bcreates? [^.]*tokens?|\bpopulate|tokens? you control/, q: '(o:create o:token)' },
    aristocrats: { label: 'Aristocrats', re: /\bsacrifice (?:a|an|another|one|two|x)\b[^.]{0,25}(?:creature|permanent|artifact)|whenever [^.]{0,40}\bdies\b/, q: '(o:"sacrifice a" or o:dies)' },
    spellslinger: { label: 'Spellslinger', re: /instant (?:or|and) sorcery|whenever you cast (?:an|a) (?:instant|noncreature)|\bmagecraft|copy target (?:instant|sorcery)/, q: '(o:"instant or sorcery" or o:magecraft or o:"noncreature spell")' },
    voltron: { label: 'Voltron', re: /equipped creature|enchanted creature gets|\bequip \{|\baura spells?|double strike/, type: /\b(?:Equipment|Aura)\b/, q: '(t:equipment or t:aura or o:"equipped creature")' },
    reanimator: { label: 'Reanimator', re: /graveyards? (?:onto|to) the battlefield|\bmills?\b|\bsurveil|discard (?:a|two|x) cards?/, q: '(o:"graveyard to the battlefield" or o:"graveyard onto the battlefield" or o:mill or o:surveil)' },
    landfall: { label: 'Landfall', re: /\blandfall|whenever a land (?:you control )?enters|additional lands?|land cards? from your graveyard/, q: '(o:landfall or o:"land you control enters" or o:"additional land")' },
    lifegain: { label: 'Lifegain', re: /\bgain (?:\d+|x|that much) life|\bgains? life\b|whenever you gain life|\blifelink/, q: '(o:"gain" o:"life")' },
    artifacts: { label: 'Artifacts', re: /\bartifacts? you control|whenever (?:an|another) artifact|artifact spells?|\btreasure|\bclues?\b/, type: /\bArtifact\b/, q: '(o:artifact)' },
    enchantress: { label: 'Enchantments', re: /enchantments? you control|whenever you cast an enchantment|\bconstellation/, type: /\bEnchantment\b/, q: '(o:enchantment)' },
    blink: { label: 'Blink / ETB', re: /\bexile [^.]*you control[^.]*\.?[^.]*return (?:it|that card|them|those cards) to the battlefield|\bflicker/, q: '(o:"return it to the battlefield" or o:"return that card to the battlefield")' },
    wheels: { label: 'Wheels', re: /each player (?:discards[^.]*and )?draws|whenever an opponent draws/, q: '(o:"each player draws" or o:"whenever an opponent draws")' },
    mill: { label: 'Mill', re: /\bmills?\b/, q: '(o:mill)' },
    superfriends: { label: 'Superfriends', re: /\bloyalty|planeswalkers? you control|\bproliferate/, type: /\bPlaneswalker\b/, q: '(t:planeswalker or o:planeswalker)' },
    stax: { label: 'Stax', flag: 'stax', q: '(o:"can\'t" o:opponent)' },
    burn: { label: 'Burn', re: /damage to (?:each opponent|any target|target player|each player)/, q: '(o:"damage to each opponent" or o:"damage to any target")' },
    graveyard: { label: 'Graveyard', re: /\bgraveyard\b/, q: '(o:graveyard)' },
    combat: { label: 'Go-wide / combat', re: /creatures you control get \+|whenever (?:a|one or more) creatures? you control attacks?|additional combat/, q: '(o:"creatures you control get" or o:"creatures you control attack")' },
    drawmatters: { label: 'Draw-matters', re: /whenever you draw/, q: '(o:"whenever you draw")' }
  };
  const IRREG = { elf: 'elves', dwarf: 'dwarves', wolf: 'wolves', werewolf: 'werewolves', fungus: 'fungi', ox: 'oxen', mouse: 'mice', sphinx: 'sphinxes', fox: 'foxes', octopus: 'octopuses', homunculus: 'homunculi', djinn: 'djinn', sheep: 'sheep', fish: 'fish', jellyfish: 'jellyfish', elk: 'elk', dryad: 'dryads', faerie: 'faeries' };
  function plural(t) { const l = t.toLowerCase(); if (IRREG[l]) return IRREG[l]; if (/(?:s|x|ch|sh)$/.test(l)) return l + 'es'; if (/[^aeiou]y$/.test(l)) return l.slice(0, -1) + 'ies'; return l + 's'; }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function tribalTag(T) {
    const t = T.toLowerCase(), p = plural(T);
    const typeRe = new RegExp('\\b' + escRe(T) + '\\b', 'i');
    const textRe = new RegExp('\\b(?:' + escRe(t) + '|' + escRe(p) + ')\\b');
    const real = c => typeRe.test(c.tl.split('—').slice(1).join(' ')) || textRe.test(c.low);
    return { label: 'Tribal: ' + T, test: c => real(c) || c.kw.includes('changeling'), factor: c => real(c) ? 1 : 0.5, q: '(t:"' + T + '" or o:"' + T + '")', desc: 'subtype ' + T + ', oracle mentions ' + t + '/' + p + ', or Changeling' };
  }
  function creatureTypes(db) {
    if (db._ctypes) return db._ctypes;
    const set = new Set();
    for (const c of db.all) {
      if (c.stype === 'funny' || c.bc === 'silver') continue; // Un-set joke types ("The Biggest, Baddest...") are not real subtypes
      for (const face of c.tl.split(' // ')) {
        if (!/\b(?:Creature|Kindred|Tribal)\b/.test(face)) continue;
        const sub = face.split('—')[1]; if (!sub) continue;
        const words = sub.trim().replace(/\bTime Lord\b/g, 'Time_Lord').split(/\s+/);
        for (const w of words) if (w === 'Time_Lord') set.add('Time Lord'); else if (w.length >= 3 && /^[A-Z][a-z'-]+$/.test(w)) set.add(w);
      }
    }
    db._ctypes = set; return set;
  }

  /* ---------- per-card analysis (cached) ---------- */
  const AC = new WeakMap();
  function isBasic(c) { return /\bBasic\b/.test(c.ft) && /\bLand\b/.test(c.ft); }
  function landClass(c) {
    if (!/\bLand\b/.test(c.ft)) return null;
    if (isBasic(c)) return 'basic';
    const types = ((c.ft.split('—')[1] || '').match(/\b(Plains|Island|Swamp|Mountain|Forest)\b/g)) || [];
    const cols = c.pm.filter(x => WUBRG.includes(x));
    if (/search your library for an? [^.]*(?:plains|island|swamp|mountain|forest|basic land)/.test(c.low) && /sacrifice (?:~|this)/.test(c.low)) return 'fetch';
    if (types.length >= 3) return 'triome';
    if (/mana of any (?:one )?colou?r|mana of any type/.test(c.low) || cols.length >= 3) return 'command';
    if (/you may pay 2 life/.test(c.low) && types.length === 2) return 'shock';
    if (cols.length === 2) return 'dual';
    return 'utility';
  }
  const LAND_CLASS_DESC = { fetch: 'sacrifices to search for a land (fetch)', shock: 'two basic types + "you may pay 2 life"', dual: 'produces exactly two colors', triome: 'three basic land types', command: 'mana of any color (Command Tower style)', utility: 'other nonbasic (colorless / mono / utility)' };
  function analyze(c) {
    let a = AC.get(c); if (a) return a;
    a = { roles: {}, rules: {}, flags: {}, land: landClass(c) };
    a.isLand = a.land != null;
    a.creature = /\bCreature\b/.test(c.ft);
    if (!a.isLand) {
      for (const role of ROLES) {
        for (const r of ROLE_RULES[role]) if (r.test(c)) { a.roles[role] = true; (a.rules[role] = a.rules[role] || []).push(r.id); }
        if (c.otags && c.otags.includes(role)) { a.roles[role] = true; (a.rules[role] = a.rules[role] || []).push('otag'); }
      }
    }
    for (const k of Object.keys(FLAGS)) if (FLAGS[k].test(c)) a.flags[k] = true;
    if (c.otags && c.otags.includes('tutor')) a.flags.tutor = true;
    const m = c.ot.match(/a deck can have (any number of|up to (\w+)) cards named/i);
    a.exempt = m ? (m[2] ? ({ two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }[m[2].toLowerCase()] || parseInt(m[2], 10) || 1) : Infinity) : (isBasic(c) ? Infinity : 1);
    AC.set(c, a); return a;
  }
  function pips(mc) {
    const out = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const re = /\{([^}]+)\}/g; let m;
    while ((m = re.exec(mc || ''))) {
      const s = m[1].toUpperCase();
      const cols = s.split('/').filter(x => 'WUBRG'.includes(x));
      if (cols.length) for (const x of cols) out[x] += 1 / cols.length;
      else if (s === 'C') out.C += 1;
    }
    return out;
  }

  /* ---------- commanders ---------- */
  function cmdTraits(c) {
    const ot = stripReminder(c.ot);
    const pw = ot.match(/(?:^|\n)Partner with ([^\n(]+?)\s*(?:\(|$|\n)/);
    const pdash = ot.match(/(?:^|\n)Partner\s*[—-]\s*([^\n(]+?)\s*(?:\(|$|\n)/);
    return {
      partner: /(?:^|\n)Partner\s*(?:$|\n)/.test(ot) || /(?:^|\n)Partner \(/.test(c.ot),
      partnerWith: pw ? pw[1].trim() : null,
      partnerDash: pdash ? pdash[1].trim().toLowerCase() : null,
      friends: /(?:^|\n)Friends forever/i.test(c.ot),
      chooseBg: /Choose a Background/i.test(c.ot),
      isBg: /\bBackground\b/.test(c.ft) && /\bLegendary\b/.test(c.ft),
      companion: /Doctor's companion/i.test(c.ot),
      isDoctor: /\bTime Lord Doctor\b/.test(c.ft) && /\bLegendary\b/.test(c.ft) && /\bCreature\b/.test(c.ft)
    };
  }
  function commanderEligibility(c) {
    if (c.leg !== 'legal') return { ok: false, msg: 'not legal in Commander (Scryfall legality: ' + c.leg + ')' };
    const t = cmdTraits(c);
    if ((/\bLegendary\b/.test(c.ft) && /\bCreature\b/.test(c.ft)) || /can be your commander/i.test(c.ot) || t.isBg) return { ok: true };
    return { ok: false, msg: 'not a legendary creature and lacks "can be your commander"' };
  }
  function pairCheck(a, b) {
    const A = cmdTraits(a), B = cmdTraits(b);
    if (A.isBg && B.isBg) return { ok: false, msg: 'Two Backgrounds cannot be commanders together.' };
    if (A.partner && B.partner) return { ok: true, kind: 'Partner' };
    if (A.partnerWith && B.partnerWith && nameKey(A.partnerWith) === nameKey(b.n) && nameKey(B.partnerWith) === nameKey(a.n)) return { ok: true, kind: 'Partner with' };
    if (A.partnerDash && A.partnerDash === B.partnerDash) return { ok: true, kind: 'Partner—' + A.partnerDash };
    if (A.friends && B.friends) return { ok: true, kind: 'Friends forever' };
    if ((A.chooseBg && B.isBg) || (B.chooseBg && A.isBg)) return { ok: true, kind: 'Background' };
    if ((A.companion && B.isDoctor) || (B.companion && A.isDoctor)) return { ok: true, kind: "Doctor's companion" };
    return { ok: false, msg: a.n + ' and ' + b.n + ' cannot be paired: no shared Partner, Partner with, Friends forever, Background or Doctor\'s companion relationship in their oracle text.' };
  }

  /* ---------- Inspire me: ranks commanders against quiz answers (colours, play style, creature type, themes, power,
     popularity, price). Every point carries the reason the page shows. Weights are this tool's own; they order commanders,
     they are not a published rating. ---------- */
  const STYLES = {
    aggro: { label: 'Aggressive', desc: 'Attack early and keep up the pressure', sig: [
      ['attack trigger', c => /whenever ~ attacks|whenever (?:a|an|one or more|another) [^.]{0,30}you control attacks?|whenever you attack/.test(c.low), 1.5],
      ['extra combat', c => /additional combat/.test(c.low), 1.5],
      ['combat-damage trigger', c => /deals? combat damage to (?:a player|an opponent|one or more players)/.test(c.low), 1],
      ['pumps or hastes your team', c => /creatures you control (?:get \+|have haste|gain haste)|attacking creatures you control get|creatures you control (?:have|gain) [^.]{0,30}(?:double strike|trample|menace)/.test(c.low), 1],
      ['haste', c => c.kw.includes('haste'), 1],
      ['trample, menace or double strike', c => ['trample', 'menace', 'double strike'].some(k => c.kw.includes(k)), 0.5],
      ['damages opponents directly', c => TAGS.burn.re.test(c.low), 0.75],
      ['cheap to cast (MV ≤ 3)', c => c.cmc <= 3, 0.5]] },
    control: { label: 'Control', desc: 'Answer threats and win the long game', sig: [
      ['counters spells', c => /counter target/.test(c.low), 1.5],
      ['board wipe', c => analyze(c).roles.wipes, 1.5],
      ['taxes or restricts opponents', c => analyze(c).flags.stax, 1.5],
      ['removes permanents', c => analyze(c).roles.removal, 1],
      ['taps or locks down creatures', c => /tap (?:up to \w+ )?target|(?:doesn't|don't) untap|can't attack|can't block/.test(c.low), 0.75],
      ['draws cards', c => analyze(c).roles.draw, 0.75],
      ['flash or instant speed', c => c.kw.includes('flash') || /\binstants?\b/.test(c.low), 0.5]] },
    combo: { label: 'Combo', desc: 'Assemble pieces and win in one turn', sig: [
      ['untaps permanents', c => /\buntap (?:target|all|each|another|up to|~|it|that)/.test(c.low), 1],
      ['tutors', c => analyze(c).flags.tutor, 1],
      ['copies spells or abilities', c => /\bcop(?:y|ies) (?:target|that|it|the next|each)/.test(c.low), 0.75],
      ['cast or activate triggers', c => /whenever you (?:cast|activate)/.test(c.low), 0.5],
      ['cost reduction', c => /costs? \{\d+\} less|cost \{x\} less|less to (?:cast|activate)/.test(c.low), 0.5]] },
    value: { label: 'Value engine', desc: 'Grind out card and board advantage', sig: [
      ['triggers every turn', c => /at the beginning of (?:your|each)/.test(c.low), 1],
      ['draws cards', c => analyze(c).roles.draw, 1],
      ['returns cards from the graveyard', c => analyze(c).roles.recursion, 1],
      ['enter triggers', c => /whenever (?:another|a|an|one or more) [^.]{0,40}enters/.test(c.low), 0.75],
      ['makes tokens', c => TAGS.tokens.re.test(c.low), 0.75],
      ['ramps', c => analyze(c).roles.ramp, 0.75]] },
    big: { label: 'Go big', desc: 'Ramp into huge creatures and spells', sig: [
      ['rewards big spells or creatures', c => /(?:mana value|power) (?:[4-9]|\d\d) or greater|with (?:mana value|power) [5-9]|greatest (?:power|mana value)/.test(c.low), 1.5],
      ['ramps', c => analyze(c).roles.ramp, 1],
      ['cost reduction', c => /costs? \{\d+\} less|cost \{x\} less|less to cast/.test(c.low), 1],
      ['extra lands or landfall', c => TAGS.landfall.re.test(c.low), 0.75],
      ['high mana value (MV ≥ 6)', c => c.cmc >= 6, 1],
      ['power 6 or more', c => c.pow != null && c.pow >= 6, 1]] }
  };
  // pop with no answer still counts a little (0.75), so among equal fits the better-supported commander comes first
  const INSPIRE_W = { style: 3, tribe: 3, themes: 2, power: 1, pop: 1, popAny: 0.75 };
  // combos(name) → { n, inf }: Commander Spellbook combos that include the card (optional)
  function styleFit(c, key, combos) {
    const S = STYLES[key], hit = []; let p = 0;
    for (const [label, test, pts] of S.sig) if (test(c)) { hit.push(label); p += pts; }
    if (key === 'combo' && combos) { const k = combos(c.n); if (k && k.n) { p += Math.min(2, 0.5 * Math.log2(1 + k.n)); hit.unshift('in ' + k.n.toLocaleString('en-US') + ' Commander Spellbook combo' + (k.n === 1 ? '' : 's') + (k.inf ? ' (' + k.inf.toLocaleString('en-US') + ' infinite)' : '')); } }
    return { fit: Math.min(1, p / 3), hit };
  }
  // the play styles a commander leans toward, strongest first
  function styleProfile(c, combos) { return Object.keys(STYLES).map(k => Object.assign({ key: k, label: STYLES[k].label }, styleFit(c, k, combos))).filter(x => x.fit >= 0.5).sort((a, b) => b.fit - a.fit); }
  const subtypes = c => c.tl.split(' // ').map(f => (f.split('—')[1] || '')).join(' ');
  function tribeCounts(db, T) {
    const M = db._tribe || (db._tribe = new Map()); if (M.has(T)) return M.get(T);
    const re = new RegExp('\\b' + escRe(T) + '\\b'), by = {};
    for (const c of db.all) if (c.leg === 'legal' && c.stype !== 'funny' && /\b(?:Creature|Kindred|Tribal)\b/.test(c.tl) && re.test(subtypes(c))) by[c.ci] = (by[c.ci] || 0) + 1;
    M.set(T, by); return by;
  }
  const ciWithin = (ci, outer) => [...ci].every(x => outer.includes(x));
  function colourOK(c, cols, mode) {
    if (!cols) return true;
    if (mode === 'exact') return c.ci === WUBRG.split('').filter(x => cols.includes(x)).join('');
    if (mode === 'incl') return [...cols].every(x => c.ci.includes(x));
    return ciWithin(c.ci, cols);
  }
  // A: { cols, mode: within|exact|incl, style, tribe, themes: [TAGS keys], power: casual|mid|high, pop: popular|hidden, price, cur }
  function inspire(db, A, opts) {
    opts = opts || {}; A = A || {};
    const pool = opts.pool || db.all.filter(c => commanderEligibility(c).ok), combos = opts.combos || null, cur = A.cur || 'usd';
    const T = (A.tribe || '').trim(), tl = T.toLowerCase(), tp = T ? plural(T) : '';
    const tType = T ? new RegExp('\\b' + escRe(T) + '\\b', 'i') : null, tText = T ? new RegExp('\\b(?:' + escRe(tl) + '|' + escRe(tp) + ')\\b') : null;
    const tc = T ? tribeCounts(db, T) : null;
    // popularity = EDHREC rank percentile among commanders (1 = most played, 0 = no rank)
    const ranked = pool.filter(c => c.rank).sort((a, b) => a.rank - b.rank), pctOf = new Map(ranked.map((c, i) => [c, 1 - i / ranked.length]));
    const themes = (A.themes || []).filter(k => TAGS[k]);
    const used = { style: !!STYLES[A.style], tribe: !!T, themes: themes.length > 0, power: !!A.power, pop: !!A.pop };
    const wSum = Object.keys(used).reduce((s, k) => s + (used[k] ? INSPIRE_W[k] : 0), 0) + (used.pop ? 0 : INSPIRE_W.popAny);
    const Tp = tp.charAt(0).toUpperCase() + tp.slice(1);
    const out = [];
    for (const c of pool) {
      if (!colourOK(c, A.cols || '', A.mode || 'within')) continue;
      const price = c.p[cur];
      if (A.price != null && A.price !== '' && (price == null || price > +A.price)) continue;
      const why = [], fit = {}; let tied = false;
      if (used.style) { const s = styleFit(c, A.style, combos); fit.style = s.fit; if (s.hit.length) why.push({ part: 'style', t: STYLES[A.style].label + ': ' + s.hit.join(', ') }); }
      if (used.tribe) {
        const names = tText.test(c.low), is = tType.test(subtypes(c)), ch = c.kw.includes('changeling'); tied = names || is || ch;
        let depth = 0; for (const k in tc) if (ciWithin(k, c.ci)) depth += tc[k];
        fit.tribe = (names ? 0.6 : 0) + (is || ch ? 0.25 : 0) + 0.15 * Math.min(1, depth / 60);
        const bits = [];
        if (names) bits.push('rules text names ' + Tp); if (is) bits.push('is ' + (/^[aeiou]/i.test(T) ? 'an ' : 'a ') + T); else if (ch) bits.push('Changeling (every creature type)');
        bits.push(depth.toLocaleString('en-US') + ' ' + T + ' creature' + (depth === 1 ? '' : 's') + ' in its colours');
        why.push({ part: 'tribe', t: T + ': ' + bits.join(', ') });
      }
      if (used.themes) {
        const hit = themes.filter(k => { const t = TAGS[k]; return (t.re && t.re.test(c.low)) || (t.type && t.type.test(c.tl)) || (t.flag && analyze(c).flags[t.flag]); });
        fit.themes = hit.length / themes.length;
        if (hit.length) why.push({ part: 'themes', t: 'Themes in its rules text: ' + hit.map(k => TAGS[k].label).join(', ') });
      }
      const k = combos ? combos(c.n) : null, inf = k ? k.inf || 0 : 0, cp = cardPower(c);
      if (used.power) {
        if (A.power === 'casual') { fit.power = Math.max(0, 1 - (c.gc ? 0.7 : 0) - 0.3 * Math.min(1, inf / 10)); if (c.gc) why.push({ part: 'power', t: 'Game Changer: limited to brackets 3 and up', neg: true }); else why.push({ part: 'power', t: 'Not a Game Changer, fits brackets 1–2' }); }
        else if (A.power === 'mid') { fit.power = c.gc ? 0.5 : 1; if (c.gc) why.push({ part: 'power', t: 'Game Changer: counts toward the bracket 3 limit of 3', neg: true }); }
        else { fit.power = Math.min(1, 0.5 * cp / 0.6 + (c.gc ? 0.3 : 0) + 0.2 * Math.min(1, inf / 10)); const b = []; if (c.gc) b.push('Game Changer'); if (inf) b.push(inf + ' infinite combo' + (inf === 1 ? '' : 's')); b.push('card power ' + cp.toFixed(2)); why.push({ part: 'power', t: 'High power: ' + b.join(', ') }); }
      }
      const p = pctOf.get(c) || 0, top = Math.max(1, Math.ceil((1 - p) * 100));
      if (used.pop) {
        fit.pop = A.pop === 'hidden' ? (c.rank ? 1 - p : 0.5) : p;
        why.push({ part: 'pop', t: c.rank ? (A.pop === 'hidden' ? 'Less played: ' : 'Popular: ') + 'EDHREC #' + c.rank.toLocaleString('en-US') + ', ' + (top <= 50 ? 'top ' + top + '%' : 'bottom ' + (101 - top) + '%') + ' of commanders' : 'No EDHREC rank yet' });
      } else fit.popAny = p;
      let s = 0; for (const key in fit) s += INSPIRE_W[key] * fit[key];
      const pct = s / wSum;
      // a chosen creature type is a gate: commanders that are or name the type rank above those that only share its colours
      out.push({ c, pct, score: pct + (tied ? 1 : 0), fit, why, price });
    }
    out.sort((a, b) => b.score - a.score || (a.c.rank || 1e9) - (b.c.rank || 1e9));
    return { list: out, pool: pool.length, used };
  }

  /* ---------- combos (Commander Spellbook) ---------- */
  // Decodes the site's compact Spellbook files (tools/spellbook-shard.js) into variant objects:
  // { id, c: card names, cmd: names that must be the commander, p: produced features, t: required templates, r: template count,
  //   inf, bt: bracket tag, mv: mana value needed, ci: colour identity, pop: popularity, ex: example variant }
  // db (optional) maps Spellbook names onto the loaded card names so lookups are exact.
  function spellbookVariants(tables, rows, db) {
    const canon = tables.cards.map(n => { const c = db ? lookup(db, n) || lookup(db, String(n).split(' // ')[0]) : null; return c ? c.n : n; });
    const out = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const [id, cards, feats, tmpl, ci, mv, bt, pop, flags] = rows[i];
      const c = [], cmd = [];
      for (const k of cards) { const n = canon[k < 0 ? -k - 1 : k]; c.push(n); if (k < 0) cmd.push(n); }
      const p = feats.map(k => tables.features[k]), t = tmpl.map(k => tables.templates[k]);
      out[i] = { id, c, cmd, p, t, r: t.length, inf: p.some(x => /infinite/i.test(x)), bt: bt || '', mv, ci: ci || '', pop, ex: !!(flags & 1) };
    }
    return out;
  }
  const NO_VARIANTS = Object.freeze([]);
  // names: an array of card names, a Set, or a predicate n => boolean. cmds: commander names (variants that need a card
  // to be the commander only count when it is). Variants that also need a non-card template are listed but never
  // counted as assembled, because the template cannot be checked against the list.
  function localComboProvider(variants, meta) {
    const by = new Map();
    for (const v of variants) for (const n of new Set(v.c)) { let l = by.get(n); if (!l) by.set(n, l = []); l.push(v); }
    const asHas = names => typeof names === 'function' ? names : names instanceof Set ? n => names.has(n) : (st => n => st.has(n))(new Set(names));
    const cmdOk = (v, cmds) => !v.cmd.length || (cmds && v.cmd.every(n => cmds.has ? cmds.has(n) : cmds.includes(n)));
    return {
      kind: 'local', meta: meta || {}, count: variants.length, variants, byCard: by,
      async find(names, cmdNames) {
        const has = asHas(names), cmds = new Set(cmdNames || []), seen = new Set(), out = [];
        for (const n of names) for (const v of by.get(n) || NO_VARIANTS) { if (seen.has(v.id)) continue; seen.add(v.id); if (v.r === 0 && cmdOk(v, cmds) && v.c.every(has)) out.push(v); }
        return out;
      },
      completes(cardName, names, cmdNames) {
        const list = by.get(cardName); if (!list) return NO_VARIANTS;
        const has = asHas(names), cmds = cmdNames ? (cmdNames instanceof Set ? cmdNames : new Set(cmdNames)) : null, out = [];
        for (const v of list) if (v.r === 0 && cmdOk(v, cmds) && v.c.every(n => n === cardName || has(n))) out.push(v);
        return out;
      },
      async almost(names, poolNames, maxMissing) {
        const has = asHas(names), pool = asHas(poolNames), seen = new Set(), out = [], mm = maxMissing || 2;
        for (const n of names) for (const v of by.get(n) || NO_VARIANTS) {
          if (seen.has(v.id) || v.r !== 0 || v.c.length > 4) continue; seen.add(v.id);
          const missing = v.c.filter(x => !has(x));
          if (missing.length >= 1 && missing.length <= mm && missing.every(pool)) out.push({ v, missing });
        }
        return out;
      }
    };
  }

  /* ---------- card power index (0–1) from card data: flags, efficiency of each role at its mana value, free casting, EDHREC popularity.
     Weights are this tool's own; they rank cards, they are not a published rating. ---------- */
  const CP = new WeakMap();
  // noRank: the same index without its EDHREC term (mechanics-only builds)
  function cardPower(c, noRank) {
    if (noRank) { const p = cardPower(c); return Math.max(0, p - 0.25 * (c.rank ? Math.max(0, 1 - Math.log10(c.rank) / Math.log10(40000)) : 0)); }
    let v = CP.get(c); if (v != null) return v;
    const a = analyze(c), low = c.low || '', mv = c.cmc || 0, inst = /\bInstant\b/.test(c.ft) || (c.kw || []).includes('flash');
    let p = 0;
    if (a.flags.fast) p += 0.45;
    if (a.flags.gc) p += 0.35;
    if (a.flags.tutor) p += mv <= 2 ? 0.35 : 0.2;
    if (a.roles.removal) p += mv <= 2 ? (inst ? 0.3 : 0.2) : mv <= 3 ? 0.1 : 0;
    if (a.roles.wipes && mv <= 4) p += 0.1;
    if (a.roles.ramp && !a.isLand) p += mv <= 1 ? 0.3 : mv === 2 ? 0.15 : 0;
    if (a.roles.draw) p += (/\b(?:Artifact|Creature|Enchantment|Planeswalker)\b/.test(c.ft) && /whenever|at the beginning of/.test(low) && mv <= 3) ? 0.2 : mv <= 2 ? 0.1 : 0;
    if (a.roles.protection && mv <= 1) p += 0.15;
    if (/without paying (?:its|this spell's) mana cost|rather than pay (?:this spell's|its) mana cost/.test(low)) p += 0.25;
    if (a.flags.stax) p += 0.1;
    p += 0.25 * (c.rank ? Math.max(0, 1 - Math.log10(c.rank) / Math.log10(40000)) : 0);
    v = Math.max(0, Math.min(1, p)); CP.set(c, v); return v;
  }
  // how much each bracket prefers raw card power when generating (negative = avoid strong cards)
  const POWER_PREF = { 1: -0.3, 2: 0.2, 3: 0.6, 4: 1.3, 5: 2 };

  /* ---------- generation ---------- */
  async function generate(db, S0, env) {
    env = env || {};
    const S = deepMerge(defaults(), S0 || {});
    const R = { ok: false, errors: [], warnings: [], log: [], deck: [], commanders: [], settings: S, shortfalls: [], combos: [], comboStatus: 'unavailable', poolSize: 0, excluded: {} };
    const L = m => R.log.push(m);
    const cur = S.budget.cur || 'usd';
    const price = c => c.p[cur];
    const cap = S.budget.total != null && S.budget.total !== '' ? +S.budget.total : null;
    const pcap = S.budget.perCard != null && S.budget.perCard !== '' ? +S.budget.perCard : null;
    const budgetOn = cap != null || pcap != null;
    const W = S.weights;

    /* commanders */
    const cmdNames = (S.commanders || []).map(s => String(s || '').trim()).filter(Boolean);
    if (!cmdNames.length) { R.errors.push('Commander is required.'); return R; }
    const cmds = [];
    for (const nm of cmdNames) { const c = lookup(db, nm); if (!c) R.errors.push('Unknown card: "' + nm + '" is not in the loaded card data.'); else cmds.push(c); }
    if (R.errors.length) return R;
    for (const c of cmds) { const el = commanderEligibility(c); if (!el.ok) R.errors.push(c.n + ': ' + el.msg); }
    if (cmds.length > 2) R.errors.push('At most two commanders.');
    if (cmds.length === 2) { if (cmds[0].oid === cmds[1].oid) R.errors.push('The two commanders are the same card.'); else { const pc = pairCheck(cmds[0], cmds[1]); if (!pc.ok) R.errors.push(pc.msg); else R.pairKind = pc.kind; } }
    if (cmds.length === 1 && cmdTraits(cmds[0]).isBg && !/\bCreature\b/.test(cmds[0].ft)) R.errors.push(cmds[0].n + ' is a Background; it needs a commander with "Choose a Background".');
    if (R.errors.length) return R;
    R.commanders = cmds;
    const CI = WUBRG.split('').filter(x => cmds.some(c => c.ci.includes(x))).join('');
    R.CI = CI;
    const mainSize = 100 - cmds.length;
    const lim = Object.assign(bracketDefaults(S.bracket), S.bl || {});
    for (const k of ['gc', 'mld', 'xturn', 'tutor', 'combo2']) lim[k] = lim[k] == null || lim[k] === '' ? 999 : +lim[k];
    R.lim = lim;

    /* tags */
    const tags = [];
    const addTag = (key, t, w, src) => { const e = tags.find(x => x.key === key); if (e) { e.w = Math.max(e.w, w); if (!e.src.includes(src)) e.src += ', ' + src; return; } tags.push({ key, label: t.label, factor: t.factor, test: t.test || (c => (t.re && t.re.test(c.low)) || (t.type && t.type.test(c.ft)) || (t.flag && analyze(c).flags[t.flag])), q: t.q, w, src }); };
    const ctypes = creatureTypes(db);
    const ctLower = new Map([...ctypes].map(t => [t.toLowerCase(), t]));
    if (S.archetype && TAGS[S.archetype]) addTag(S.archetype, TAGS[S.archetype], 1.5, 'archetype');
    for (const raw of String(S.tags || '').split(',')) {
      const t = raw.trim(); if (!t) continue; const tl = t.toLowerCase();
      const byLabel = Object.keys(TAGS).find(k => TAGS[k].label.toLowerCase() === tl);
      if (TAGS[tl]) addTag(tl, TAGS[tl], 1.5, 'user tag');
      else if (byLabel) addTag(byLabel, TAGS[byLabel], 1.5, 'user tag');
      else if (tl.startsWith('o:') && tl.length > 3) { const s = tl.slice(2).replace(/^"|"$/g, ''); addTag('o:' + s, { label: 'Oracle: ' + s, test: c => c.low.includes(s), q: 'o:"' + s + '"' }, 1.5, 'user tag'); }
      else {
        const tt = tl.replace(/^tribal:\s*/, '');
        const ty = ctLower.get(tt) || [...ctLower.entries()].find(([k]) => plural(k) === tt)?.[1];
        if (ty) addTag('tribal:' + ty, tribalTag(ty), 1.5, 'user tag');
        else R.warnings.push('Tag "' + t + '" is not mapped. Use a listed archetype, a creature type present in the data, or o:<oracle text>.');
      }
    }
    if (S.archetype === 'tribal' && !tags.some(t => t.key.startsWith('tribal:'))) R.warnings.push('Archetype "Tribal" needs a creature type in the tags field (e.g. Elf).');
    for (const c of cmds) {
      for (const k of Object.keys(TAGS)) if (TAGS[k].re && TAGS[k].re.test(c.low)) addTag(k, TAGS[k], 1, 'commander text');
      for (const [lt, T] of ctLower) { if (lt.length < 3) continue; const re = new RegExp('\\b(?:' + escRe(lt) + '|' + escRe(plural(lt)) + ')\\b'); if (re.test(c.low)) addTag('tribal:' + T, tribalTag(T), 1, 'commander text'); }
    }
    R.tags = tags.map(t => ({ key: t.key, label: t.label, w: t.w, src: t.src, q: t.q }));

    /* owned */
    let owned = null;
    if (S.owned && S.owned.mode !== 'off') {
      owned = new Set(); const unknown = [];
      for (const it of parseList(S.owned.list)) { const c = lookup(db, it.name); if (c) owned.add(c.n); else unknown.push(it.name); }
      if (unknown.length) R.warnings.push('Collection: ' + unknown.length + ' name(s) not found in data: ' + unknown.slice(0, 8).join('; ') + (unknown.length > 8 ? ' …' : ''));
      if (!owned.size) R.warnings.push('Collection list is empty or unmatched.');
    }

    /* includes / excludes */
    const excludeSet = new Set();
    for (const it of parseList(S.exclude)) { const c = lookup(db, it.name); if (c) excludeSet.add(c.n); else R.warnings.push('Exclude list: unknown card "' + it.name + '".'); }
    const bans = new Set(env.bans || []);
    const incs = [], incW = env.imported ? 'Import' : 'Include';
    const locks = (env.locks || []).map(x => typeof x === 'string' ? { name: x } : x);
    for (const it of parseList(S.include).map(x => ({ name: x.name, qty: x.qty, slot: 'include' })).concat(locks.map(l => ({ name: l.name, qty: l.qty || 1, slot: 'locked', prev: l.slot })))) {
      const c = lookup(db, it.name);
      if (!c) { R.warnings.push(incW + ' list: unknown card "' + it.name + '".'); continue; }
      if (cmds.includes(c)) continue;
      if (incs.some(x => x.c === c)) continue;
      const a = analyze(c);
      if (c.leg !== 'legal') { R.warnings.push(incW + ' rejected: ' + c.n + ' is ' + c.leg + ' in Commander.'); continue; }
      if (!subsetCI(c.ci, CI)) { R.warnings.push(incW + ' rejected: ' + c.n + ' (identity ' + (c.ci || 'C') + ') is outside commander identity ' + (CI || 'C') + '.'); continue; }
      if (excludeSet.has(c.n)) { R.warnings.push(incW + ' rejected: ' + c.n + ' is also on the exclude list.'); continue; }
      let qty = it.qty;
      if (qty > a.exempt) { R.warnings.push(c.n + ': quantity ' + qty + ' reduced to ' + (a.exempt === Infinity ? qty : a.exempt) + ' (singleton rule).'); qty = Math.min(qty, a.exempt); }
      incs.push({ c, qty, slot: it.slot, prev: it.prev });
    }

    /* budget feasibility (hard lower bound) */
    const basicsCards = {};
    for (const x of (CI ? CI.split('') : ['C'])) { const b = lookup(db, BASIC_NAMES[x]); if (!b) { R.errors.push('Basic land "' + BASIC_NAMES[x] + '" is missing from the loaded data.'); } else basicsCards[x] = b; }
    if (R.errors.length) return R;
    const basicPrices = Object.values(basicsCards).map(b => price(b)).filter(p => p != null);
    const floor = S.budget.inclBasics ? (basicPrices.length ? Math.min(...basicPrices) : 0) : 0;
    const cmdCost = cmds.reduce((s, c) => s + (price(c) || 0), 0);
    for (const c of cmds) if (price(c) == null) R.warnings.push('No ' + cur.toUpperCase() + ' price for commander ' + c.n + '; counted as 0.');
    const incCost = incs.reduce((s, e) => s + (isBasic(e.c) && !S.budget.inclBasics ? 0 : (price(e.c) || 0) * e.qty), 0);
    if (pcap != null) {
      const over = incs.filter(e => !isBasic(e.c) && price(e.c) != null && price(e.c) > pcap);
      const cOver = [];
      if (over.length || cOver.length) R.warnings.push('Per-card cap ' + fmt(pcap, cur) + ' is exceeded by required cards: ' + cOver.concat(over.map(e => e.c)).map(c => c.n + ' (' + fmt(price(c), cur) + ')').join(', ') + '. These stay in the deck and the budget rule will fail.');
    }
    if (cap != null) {
      const incQty = incs.reduce((s, e) => s + e.qty, 0);
      const minTotal = cmdCost + incCost + Math.max(0, mainSize - incQty) * floor;
      R.minTotal = minTotal;
      if (minTotal > cap + 1e-9 && env.imported) R.warnings.push('Budget: the imported list costs at least ' + fmt(minTotal, cur) + ', over the ' + fmt(cap, cur) + ' cap. The cards are kept and the budget rule will fail.');
      else if (minTotal > cap + 1e-9) {
        R.errors.push('Budget infeasible: minimum achievable total is ' + fmt(minTotal, cur) + ' (commanders ' + fmt(cmdCost, cur) + ' + includes ' + fmt(incCost, cur) + ' + ' + Math.max(0, mainSize - incQty) + ' cheapest slots at ' + fmt(floor, cur) + (S.budget.inclBasics ? ' each, basic lands counted' : '') + '). Cap ' + fmt(cap, cur) + ' is short by ' + fmt(minTotal - cap, cur) + '. Binding constraint: ' + (cmdCost > cap ? 'commander price alone' : incCost + cmdCost > cap ? 'commanders + include list' : 'basic-land cost of the remaining slots') + '.');
        return R;
      }
    }

    /* seeded RNG */
    const seedBase = String(S.seed || '').trim() || ('auto:' + hashStr(stable(Object.assign({}, S, { seed: '', reroll: 0 }, S.mode ? {} : { mode: undefined })))); // an empty mode leaves the seed as before
    R.seedUsed = seedBase + (S.reroll ? '#' + S.reroll : '');
    const rng = mulberry32(hashStr(R.seedUsed));

    /* candidate pool */
    const F = S.filters;
    const allowedSets = String(F.sets || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    const serverFiltered = (db.meta && db.meta.serverFiltered) || {};
    const exReasons = {};
    const ex = (c, why) => { exReasons[why] = (exReasons[why] || 0) + 1; R.excluded[c.n] = why; };
    const pool = [];
    for (const c of db.all) {
      if (cmds.includes(c) || isBasic(c)) continue;
      if (!subsetCI(c.ci, CI)) continue;
      if (c.leg !== 'legal') { if (c.leg === 'banned') ex(c, 'banned'); continue; }
      const a = analyze(c);
      if (excludeSet.has(c.n)) { ex(c, 'exclude list'); continue; }
      if (bans.has(c.n)) { ex(c, 'removed by user'); continue; }
      if (F.reserved === 'exclude' && c.rl) { ex(c, 'reserved list'); continue; }
      if (F.funny === 'exclude' && (c.stype === 'funny' || c.bc === 'silver' || c.stamp === 'acorn')) { ex(c, 'silver-border/acorn/Un'); continue; }
      if (!serverFiltered.dates) {
        if (F.dateFrom && c.last && c.last < F.dateFrom) { ex(c, 'date filter'); continue; }
        if (F.dateTo && c.first && c.first > F.dateTo) { ex(c, 'date filter'); continue; }
      }
      if (!serverFiltered.sets && allowedSets.length && !c.sets.some(s => allowedSets.includes(s))) { ex(c, 'set filter'); continue; }
      if (owned && S.owned.mode === 'only' && !owned.has(c.n)) { ex(c, 'not owned'); continue; }
      let skip = null;
      for (const [fk, flag] of [['tutors', 'tutor'], ['fast', 'fast'], ['stax', 'stax'], ['xturn', 'xturn'], ['mld', 'mld'], ['hate', 'hate']]) if (F[fk] === 'exclude' && a.flags[flag]) { skip = FLAGS[flag].label + ' filter'; break; }
      if (!skip) for (const k of ['gc', 'mld', 'xturn', 'tutor']) if (a.flags[k] && lim[k] <= 0) { skip = 'bracket ' + S.bracket + ' (' + FLAGS[k].label + ')'; break; }
      if (skip) { ex(c, skip); continue; }
      const p = price(c);
      if (budgetOn && p == null && S.budget.unknown === 'exclude') { ex(c, 'no ' + cur.toUpperCase() + ' price'); continue; }
      if (pcap != null && p != null && p > pcap) { ex(c, 'per-card cap'); continue; }
      pool.push(c);
    }
    R.poolSize = pool.length; R.exReasons = exReasons;
    /* mechanics-only mode: no EDHREC rank anywhere in the score; the commander's plan profile and a rules-text quality
       model take its place, and the curve target comes from the plan (src/plan.js) */
    const mechMode = S.mode === 'mech';
    const PL = mechMode ? ((typeof Plan !== 'undefined') ? Plan : require('./plan.js')) : null;
    const plan = mechMode ? PL.profile(db, cmds, pool) : null;
    if (plan) {
      R.plan = { summary: PL.summary(plan), parts: plan.parts, supply: plan.supply, partSupply: plan.partSupply, quota: plan.quota, avgMV: plan.avgMV, strength: plan.strength, score: plan.score, why: plan.why, isPlan: plan.isPlan };
      L('Plan (mechanics only): ' + R.plan.summary + '. ' + plan.supply + ' plan cards in the pool; quota ' + plan.quota + '; curve target ' + (S.mana.fixedMV ? (+S.mana.avgMV || 3) + ' (fixed by you)' : plan.avgMV + ' from the plan cards') + '.');
      if (plan.quota) addTag('plan', { label: 'Plan', test: plan.isPlan }, 2, 'commander plan');
      R.tags = tags.map(t => ({ key: t.key, label: t.label, w: t.w, src: t.src, q: t.q }));
    }
    L('Pool: ' + pool.length + ' candidates within identity ' + (CI || 'C') + '. Excluded: ' + (Object.entries(exReasons).map(([k, v]) => k + ' ' + v).join(', ') || 'none') + '.');
    if (!pool.length && !incs.length) R.warnings.push('Candidate pool is empty after filters; deck will be filled with basic lands only.');

    /* scoring */
    const T = plan && !S.mana.fixedMV ? plan.avgMV : (+S.mana.avgMV || 3);
    R.curveTarget = T;
    const noise = new Map();
    for (const c of pool) noise.set(c.n, (rng() * 2 - 1) * (+S.variance || 0));
    const syn = new Map();
    const synOf = c => { let v = syn.get(c); if (v) return v; let s = 0; const hit = []; for (const t of tags) if (t.test(c)) { s += t.w * (t.factor ? t.factor(c) : 1); hit.push(t.label); } v = { s, hit }; syn.set(c, v); return v; };
    const pop = c => !mechMode && c.rank ? Math.max(0, 1 - Math.log10(c.rank) / Math.log10(40000)) : 0;
    const Wplan = W.plan != null ? +W.plan : 3, Wqual = W.textQuality != null ? +W.textQuality : 7; // mechPower 3 and textQuality 7: tools/bench-plan.js on 24 commanders (see the PR)
    const mechTerms = c => plan ? Wplan * plan.score(c) + Wqual * PL.quality(c) : 0;
    const priceRef = pcap != null ? pcap : (cap != null ? Math.max(1, cap / mainSize * 3) : null);
    const pricePen = c => { const p = price(c); if (p == null || !priceRef) return 0; return Math.min(3, p / priceRef); }; // no budget → price is ignored
    const curveFit = c => Math.max(-0.5, 1 - Math.abs(c.cmc - T) / (c.cmc < T ? 4 : 3));
    const pPref = (POWER_PREF[S.bracket] != null ? POWER_PREF[S.bracket] : 0.5) * (W.power != null ? +W.power : 2);
    const bpen = c => { const a = analyze(c); let s = 0; for (const k of ['gc', 'tutor', 'xturn', 'mld']) if (a.flags[k] && lim[k] < 999) s += 1; return s; };
    const baseCache = new Map();
    const base = c => {
      let v = baseCache.get(c); if (v != null) return v;
      v = W.syn * Math.min(synOf(c).s, 3) + W.pop * pop(c) + W.curve * curveFit(c) + (owned && S.owned.mode === 'prefer' && owned.has(c.n) ? W.owned : 0) - W.price * pricePen(c) - W.bracket * bpen(c) + (pPref + (mechMode ? (W.mechPower != null ? +W.mechPower : 3) : W.quality != null ? +W.quality : 2)) * cardPower(c, mechMode) + mechTerms(c) + (noise.get(c.n) || 0);
      baseCache.set(c, v); return v;
    };

    R.explain = c => ({ syn: W.syn * Math.min(synOf(c).s, 3), pop: W.pop * pop(c), curve: W.curve * curveFit(c), owned: owned && S.owned.mode === 'prefer' && owned.has(c.n) ? W.owned : 0, price: -W.price * pricePen(c), bracket: -W.bracket * bpen(c), power: (pPref + (mechMode ? (W.mechPower != null ? +W.mechPower : 3) : W.quality != null ? +W.quality : 2)) * cardPower(c, mechMode), plan: plan ? Wplan * plan.score(c) : 0, textQuality: plan ? Wqual * PL.quality(c) : 0, planWhy: plan ? plan.why(c) : [], noise: noise.get(c.n) || 0, total: base(c), inPool: pool.includes(c), excluded: R.excluded[c.n] || null, tags: synOf(c).hit });
    /* deck state */
    const st = { total: cmdCost, cnt: { gc: 0, mld: 0, xturn: 0, tutor: 0 }, creatures: 0, names: new Set(cmds.map(c => c.n)) };
    for (const c of cmds) { const a = analyze(c); for (const k of Object.keys(st.cnt)) if (a.flags[k]) st.cnt[k]++; }
    const deck = R.deck;
    const size = () => deck.reduce((s, e) => s + e.qty, 0);
    const landCount = () => deck.reduce((s, e) => s + (analyze(e.c).isLand ? e.qty : 0), 0);
    const roleCount = role => deck.reduce((s, e) => s + (analyze(e.c).roles[role] ? 1 : 0), 0);
    const cmin = F.creaturesMin != null && F.creaturesMin !== '' ? +F.creaturesMin : null;
    const cmax = F.creaturesMax != null && F.creaturesMax !== '' ? +F.creaturesMax : null;
    const combos = env.combos || null;
    const comboPolicy = F.combos || 'bracket';
    const comboForbidden = v => {
      const two = v.inf && v.c.length <= 2;
      if (comboPolicy === 'none') return true;
      if (comboPolicy === 'noinf' && v.inf) return true;
      if (comboPolicy === 'no2inf' && two) return true;
      return false;
    };
    R.comboStatus = combos ? (combos.kind === 'local' ? 'local' : 'api') : 'unavailable';
    const deckNames = () => cmds.map(c => c.n).concat(deck.map(e => e.c.n));
    const cmdSet = new Set(cmds.map(c => c.n));
    function canAdd(c, opts) {
      opts = opts || {};
      if (st.names.has(c.n) && analyze(c).exempt <= 1) return 'duplicate';
      if (bans.has(c.n) || R._runBan && R._runBan.has(c.n)) return 'banned for this run';
      const a = analyze(c), p = price(c) || 0;
      const freed = opts.replacing ? (price(opts.replacing.c) || 0) * (isBasic(opts.replacing.c) && !S.budget.inclBasics ? 0 : 1) : 0;
      if (cap != null) {
        const left = mainSize - size() - (opts.replacing ? 0 : 1);
        if (st.total - freed + (isBasic(c) && !S.budget.inclBasics ? 0 : p) + Math.max(0, left) * floor > cap + (opts.slack || 0) + 1e-9) return 'total budget';
        if (!opts.replacing && !opts.noPace) { const slots = Math.max(1, left + 1); const pace = (cap - st.total - Math.max(0, left) * floor) / slots * 3 + floor; if (p > pace + 1e-9) return 'budget pacing (≤3× remaining per-slot share)'; }
      }
      const rm = opts.replacing ? analyze(opts.replacing.c) : null;
      for (const k of ['gc', 'mld', 'xturn', 'tutor']) if (a.flags[k] && st.cnt[k] - (rm && rm.flags[k] ? 1 : 0) >= lim[k]) return 'bracket limit (' + FLAGS[k].label + ')';
      if (a.creature && cmax != null && st.creatures - (rm && rm.creature ? 1 : 0) >= cmax) return 'creature maximum';
      if (combos && combos.completes) {
        const repl = opts.replacing ? opts.replacing.c.n : null, inDeck = n => n !== repl && st.names.has(n);
        const vs = combos.completes(c.n, inDeck, cmdSet);
        const others = vs.length ? deckNames().filter(n => n !== repl) : null;
        for (const v of vs) {
          if (comboForbidden(v)) return 'combo filter';
          if (v.inf && v.c.length <= 2 && lim.combo2 < 999) {
            if (countTwoInf(others) >= lim.combo2) return 'bracket limit (2-card infinite)';
          }
        }
      }
      return null;
    }
    function countTwoInf(names) {
      if (!combos || !combos.completes) return 0;
      const seen = new Set(); let n = 0;
      for (const nm of names) for (const v of combos.completes(nm, names, cmdSet)) if (v.inf && v.c.length <= 2 && !seen.has(v.id)) { seen.add(v.id); n++; }
      return n;
    }
    function reason(c, slot, extra) {
      const a = analyze(c), s = synOf(c), p = price(c), parts = [];
      if (slot && a.rules[slot]) parts.push(SLOT_LABEL[slot] + ' via ' + a.rules[slot].join('+'));
      else if (slot === 'land') parts.push('Land: ' + a.land + ' (' + LAND_CLASS_DESC[a.land] + ')');
      else parts.push(SLOT_LABEL[slot] || slot);
      if (extra) parts.push(extra);
      if (s.hit.length) parts.push('tags: ' + s.hit.join(', '));
      parts.push(c.rank ? 'EDHREC #' + c.rank : 'no EDHREC rank');
      parts.push(p == null ? 'no ' + cur.toUpperCase() + ' price' : fmt(p, cur));
      if (owned && owned.has(c.n)) parts.push('owned');
      return parts.join(' · ');
    }
    function add(c, slot, qty, score, extra, flags) {
      qty = qty || 1;
      const a = analyze(c);
      const e = { c, qty, slot, score: score != null ? score : base(c), why: reason(c, slot, extra), locked: !!(flags && flags.locked), inc: !!(flags && flags.inc), imp: !!(flags && flags.imp) };
      deck.push(e); st.names.add(c.n);
      st.total += (isBasic(c) && !S.budget.inclBasics ? 0 : (price(c) || 0)) * qty;
      for (const k of Object.keys(st.cnt)) if (a.flags[k]) st.cnt[k] += qty;
      if (a.creature) st.creatures += qty;
      return e;
    }
    function removeEntry(e) {
      const i = deck.indexOf(e); if (i < 0) return;
      deck.splice(i, 1); const a = analyze(e.c);
      if (!deck.some(x => x.c === e.c)) st.names.delete(e.c.n);
      st.total -= (isBasic(e.c) && !S.budget.inclBasics ? 0 : (price(e.c) || 0)) * e.qty;
      for (const k of Object.keys(st.cnt)) if (a.flags[k]) st.cnt[k] -= e.qty;
      if (a.creature) st.creatures -= e.qty;
    }
    const sortScored = arr => arr.sort((x, y) => y.s - x.s || (x.c.n < y.c.n ? -1 : 1));
    const dyn = c => { const a = analyze(c); let need = 0; for (const r of ROLES) if (a.roles[r] && roleCount(r) < (+S.targets[r] || 0)) need++; return base(c) + (need ? W.role * (1 + 0.25 * (need - 1)) : 0); }; // extra roles add a little, so multi-role filler cannot outrank staples

    /* 1. includes / locks */
    for (const e of incs) add(e.c, e.slot === 'locked' ? (e.prev || 'locked') : 'include', e.qty, null, e.slot === 'locked' ? 'locked by user' : 'include list', { locked: true, inc: e.slot === 'include', imp: !!env.imported && e.slot === 'locked' });
    if (incs.length) L('Includes/locks: ' + incs.map(e => (e.qty > 1 ? e.qty + 'x ' : '') + e.c.n).join(', ') + '.');
    if (size() > mainSize) { R.errors.push((env.imported ? 'Imported list' : 'Include list') + ' has ' + size() + ' cards; maximum is ' + mainSize + ' with ' + cmds.length + ' commander(s).'); return R; }

    /* 2. lands (nonbasic now, basics after nonland fill) */
    const landTarget = Math.max(0, Math.min(mainSize, +S.targets.lands || 0));
    const autoNB = { 0: 8, 1: 7, 2: 14, 3: 17, 4: 19, 5: 21 }[CI.length];
    let nbTarget = S.mana.nonbasic != null && S.mana.nonbasic !== '' ? +S.mana.nonbasic : autoNB;
    nbTarget = Math.max(0, Math.min(nbTarget, landTarget - landCount()));
    const landColors = c => { const a = analyze(c); if (a.land === 'command') return CI.length; if (a.land === 'fetch') { if (/basic land/.test(c.low)) return Math.min(CI.length, 1); const m = c.low.match(/plains|island|swamp|mountain|forest/g) || []; const map = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' }; return new Set(m.map(x => map[x]).filter(x => CI.includes(x))).size; } return c.pm.filter(x => CI.includes(x)).length; };
    const landScore = c => { const a = analyze(c); const on = landColors(c); return W.pop * pop(c) + (CI.length > 1 ? 1.5 * Math.min(on, CI.length) / CI.length : 0) + 0.5 * W.syn * Math.min(synOf(c).s, 2) - W.price * pricePen(c) + (owned && S.owned.mode === 'prefer' && owned.has(c.n) ? W.owned : 0) + (noise.get(c.n) || 0) - (a.land === 'utility' && CI.length >= 3 ? 0.5 : 0) + (mechMode ? landText(c) : 0); };
    // mechanics-only: untapped and fetchable lands first, since popularity no longer sorts them
    function landText(c) { const l = c.low; let v = 0; if (/enters (?:the battlefield )?tapped/.test(l) && !/unless|you may pay|if you control/.test(l)) v -= 1; if (/\b(?:plains|island|swamp|mountain|forest)\b/.test(c.ft.toLowerCase())) v += 0.5; if (analyze(c).land === 'fetch' || analyze(c).land === 'shock' || analyze(c).land === 'triome') v += 0.5; if (/spend this mana only|only to cast|can't be spent/.test(l)) v -= 1.5; if (CI && !c.pm.some(x => CI.includes(x)) && analyze(c).land !== 'fetch') v -= 1.5; if (/\{t\}, pay \d life|deals 1 damage to you|\{\d\}, \{t\}: add/.test(l)) v -= 0.3; return v; }
    const landOK = c => { const a = analyze(c); if (!a.isLand || a.land === 'basic') return false; if (!S.mana.types[a.land]) return false; if (a.land === 'fetch' && CI.length && landColors(c) === 0) return false; if ((a.land === 'dual' || a.land === 'shock' || a.land === 'triome') && landColors(c) < 2) return false; return true; };
    const landCands = sortScored(pool.filter(landOK).map(c => ({ c, s: landScore(c) })));
    let nb = 0, why = {};
    for (const x of landCands) { if (nb >= nbTarget) break; const r = canAdd(x.c); if (r) { why[r] = (why[r] || 0) + 1; continue; } add(x.c, 'land', 1, x.s); nb++; }
    L('Lands: ' + nb + '/' + nbTarget + ' nonbasic selected from ' + landCands.length + ' allowed (' + Object.keys(S.mana.types).filter(k => S.mana.types[k]).join(', ') + ').' + (Object.keys(why).length ? ' Rejected: ' + JSON.stringify(why) : ''));
    if (nb < nbTarget) L('Nonbasic shortfall ' + (nbTarget - nb) + '; filled with basics.');

    const nonlandSlots = () => mainSize - landTarget - (deck.reduce((s, e) => s + (analyze(e.c).isLand ? 0 : e.qty), 0)) - Math.max(0, landCount() - landTarget);
    /* 3. roles */
    for (const role of ROLES) {
      const target = +S.targets[role] || 0;
      let have = roleCount(role);
      if (have >= target) { L(SLOT_LABEL[role] + ': ' + have + '/' + target + ' already covered.'); continue; }
      const cands = sortScored(pool.filter(c => !analyze(c).isLand && analyze(c).roles[role] && !st.names.has(c.n)).map(c => ({ c, s: dyn(c) })));
      const rej = {};
      for (const x of cands) {
        if (have >= target || nonlandSlots() <= 0) break;
        const r = canAdd(x.c); if (r) { rej[r] = (rej[r] || 0) + 1; continue; }
        add(x.c, role, 1, x.s); have = roleCount(role);
      }
      L(SLOT_LABEL[role] + ': ' + have + '/' + target + ' from ' + cands.length + ' tagged candidates.' + (Object.keys(rej).length ? ' Rejected: ' + Object.entries(rej).map(([k, v]) => k + ' ' + v).join(', ') + '.' : ''));
      if (have < target) {
        const exByRole = {};
        for (const c of db.all) { const why2 = R.excluded[c.n]; if (why2 && !analyze(c).isLand && analyze(c).roles[role]) exByRole[why2] = (exByRole[why2] || 0) + 1; }
        R.shortfalls.push({ role, have, target, pool: cands.length, rejected: rej, excluded: exByRole });
      }
    }

    /* 4. synergy then flex */
    const fill = (phase, filter) => {
      const cands = sortScored(pool.filter(c => !analyze(c).isLand && !st.names.has(c.n) && filter(c)).map(c => ({ c, s: dyn(c) })));
      let n = 0;
      for (const x of cands) {
        if (nonlandSlots() <= 0) break;
        if (cmin != null && cmin - st.creatures >= nonlandSlots() && !analyze(x.c).creature) continue;
        if (canAdd(x.c)) continue;
        add(x.c, phase, 1, x.s); n++;
      }
      return n;
    };
    /* several themes: round-robin by weight so one large theme cannot crowd out the others */
    const synFill = () => {
      if (tags.length < 2) return fill('synergy', c => synOf(c).s > 0);
      const lists = tags.map(t => ({ t, got: 0, cands: sortScored(pool.filter(c => !analyze(c).isLand && t.test(c)).map(c => ({ c, s: dyn(c) }))), i: 0 }));
      for (const l of lists) l.got = deck.filter(e => !analyze(e.c).isLand && l.t.test(e.c)).length;
      let n = 0;
      for (let guard = 0; guard < 400 && nonlandSlots() > 0; guard++) {
        const open = lists.filter(l => l.i < l.cands.length);
        if (!open.length) break;
        const l = open.sort((a, b) => a.got / a.t.w - b.got / b.t.w || (a.t.key < b.t.key ? -1 : 1))[0];
        const x = l.cands[l.i++];
        if (st.names.has(x.c.n)) continue;
        if (cmin != null && cmin - st.creatures >= nonlandSlots() && !analyze(x.c).creature) continue;
        if (canAdd(x.c)) continue;
        add(x.c, 'synergy', 1, dyn(x.c)); n++;
        for (const m of lists) if (m.t.test(x.c)) m.got++;
      }
      R.themeCounts = lists.map(l => ({ label: l.t.label, n: l.got }));
      return n;
    };
    const nSyn = tags.length ? synFill() : 0;
    L('Synergy: ' + nSyn + ' cards matching tags [' + tags.map(t => t.label).join(', ') + ']' + (R.themeCounts ? '; per theme (incl. role cards): ' + R.themeCounts.map(x => x.label + ' ' + x.n).join(', ') : '') + '.');
    const nFlex = fill('flex', () => true);
    L('Flex: ' + nFlex + ' cards by score.');

    /* 5. combos: prefer */
    if (comboPolicy === 'prefer' && combos && combos.almost) {
      try {
        const poolNames = pool.filter(c => !st.names.has(c.n)).map(c => c.n);
        const al = (await combos.almost(deckNames(), poolNames)).filter(x => !(x.v.inf && x.v.c.length <= 2 && lim.combo2 <= 0));
        al.sort((a, b) => a.missing.length - b.missing.length || (a.v.id < b.v.id ? -1 : 1));
        let added = 0;
        for (const x of al) {
          if (added >= 2) break;
          const cards = x.missing.map(n => lookup(db, n)).filter(Boolean);
          if (cards.length !== x.missing.length || cards.some(c => !pool.includes(c) || st.names.has(c.n))) continue;
          const victims = deck.filter(e => !e.locked && (e.slot === 'flex' || e.slot === 'synergy')).sort((a, b) => a.score - b.score).slice(0, cards.length);
          if (victims.length < cards.length) break;
          victims.forEach(removeEntry);
          if (cards.some(c => canAdd(c))) { victims.forEach(v => add(v.c, v.slot, v.qty, v.score)); continue; }
          cards.forEach(c => add(c, 'combo', 1, base(c), 'completes combo: ' + x.v.c.join(' + ') + ' → ' + x.v.p.slice(0, 2).join(', ')));
          L('Combo (prefer): added ' + cards.map(c => c.n).join(', ') + ' replacing ' + victims.map(v => v.c.n).join(', ') + ' for ' + x.v.c.join(' + ') + '.');
          added++;
        }
        if (!added) L('Combo (prefer): no completable combo found in pool.');
      } catch (err) { R.warnings.push('Combo lookup failed: ' + (err && err.message || err)); }
    }

    /* 6. curve adjustment (soft) */
    const avgMV = () => { const nl = deck.filter(e => !analyze(e.c).isLand); const q = nl.reduce((s, e) => s + e.qty, 0); return q ? nl.reduce((s, e) => s + e.c.cmc * e.qty, 0) / q : 0; };
    const curveOk = (c, slot) => slot === 'synergy' ? synOf(c).s > 0 : ROLES.includes(slot) ? !!analyze(c).roles[slot] : true;
    const curveStep = up => {
      const victims = deck.filter(e => !e.locked && e.qty === 1 && (e.slot === 'flex' || e.slot === 'synergy' || ROLES.includes(e.slot)) && (up ? e.c.cmc < T - 0.5 : e.c.cmc > T))
        .sort((a, b) => (up ? a.c.cmc - b.c.cmc : b.c.cmc - a.c.cmc) || a.score - b.score);
      for (const victim of victims) {
        const rep = sortScored(pool.filter(c => !analyze(c).isLand && !st.names.has(c.n) && (up ? c.cmc > victim.c.cmc && c.cmc <= T + 2 : c.cmc <= T) && curveOk(c, victim.slot)).map(c => ({ c, s: dyn(c) })))
          .find(x => x.s >= victim.score - 1.5 && !canAdd(x.c, { replacing: victim }));
        if (!rep) continue;
        removeEntry(victim); add(rep.c, victim.slot, 1, rep.s);
        L('Curve' + (up ? ' (up)' : '') + ': swapped ' + victim.c.n + ' (' + victim.slot + ', MV ' + victim.c.cmc + ', score ' + victim.score.toFixed(2) + ') → ' + rep.c.n + ' (MV ' + rep.c.cmc + ', score ' + rep.s.toFixed(2) + '); avg MV now ' + avgMV().toFixed(2) + '.');
        return true;
      }
      return false;
    };
    for (let i = 0; i < 20 && avgMV() > T + 0.15 && curveStep(false); i++);
    for (let i = 0; i < 20 && avgMV() < T - 0.15 && curveStep(true); i++);

    /* 7. basics */
    function addBasics(n, label) {
      if (n <= 0) return;
      const pp = { W: 0, U: 0, B: 0, R: 0, G: 0 };
      for (const c of cmds) { const p = pips(c.mc); for (const k in pp) pp[k] += p[k]; }
      for (const e of deck) if (!analyze(e.c).isLand) { const p = pips(e.c.mc); for (const k in pp) pp[k] += p[k] * e.qty; }
      const cols = CI ? CI.split('') : ['C'];
      const wsum = cols.reduce((s, x) => s + (pp[x] || 0), 0);
      const share = cols.map(x => ({ x, w: wsum > 0 ? (pp[x] || 0) / wsum : 1 / cols.length }));
      const alloc = share.map(s => ({ x: s.x, n: Math.floor(s.w * n), r: s.w * n - Math.floor(s.w * n) }));
      let left = n - alloc.reduce((s, a) => s + a.n, 0);
      alloc.slice().sort((a, b) => b.r - a.r || (a.x < b.x ? -1 : 1)).forEach(a => { if (left > 0) { a.n++; left--; } });
      for (const a of alloc) {
        if (!a.n) continue;
        const b = basicsCards[a.x];
        const ex = deck.find(e => e.c === b);
        if (ex) { ex.qty += a.n; st.total += (S.budget.inclBasics ? (price(b) || 0) : 0) * a.n; ex.why = reason(b, 'basic', 'pip-weighted: ' + ex.qty + ' of ' + (landTarget) + ' lands'); }
        else add(b, 'basic', a.n, 0, label || ('pip-weighted share ' + (share.find(s => s.x === a.x).w * 100).toFixed(0) + '%'));
      }
      R.pipShare = share;
    }
    const nlLeft = nonlandSlots();
    if (nlLeft > 0) {
      const flexRej = {}; for (const c of pool) if (!st.names.has(c.n) && !analyze(c).isLand) { const r = canAdd(c, { noPace: true }); if (r) flexRej[r] = (flexRej[r] || 0) + 1; }
      R.warnings.push(nlLeft + ' nonland slot(s) could not be filled within the constraints and were filled with basic lands. Remaining nonland candidates: ' + pool.filter(c => !st.names.has(c.n) && !analyze(c).isLand).length + (Object.keys(flexRej).length ? ' (blocked by: ' + Object.entries(flexRej).map(([k, v]) => k + ' ' + v).join(', ') + ')' : '') + '.');
    }
    addBasics(mainSize - size());
    L('Basics: ' + deck.filter(e => isBasic(e.c)).map(e => e.qty + ' ' + e.c.n).join(', ') + '.');

    /* 7b. optimise: steps 1–7 are a greedy baseline. This step searches the whole candidate pool for swaps that raise the
       deck's total score J, re-scanning every (deck card, pool card) pair after each round until no swap improves J.
       J = Σ base(nonland card) + pair synergy (enabler × payoff per theme) − role-shortfall − curve-drift penalties.
       A swap blocked by the total budget may be paired with a cheaper swap elsewhere (incl. nonbasic land → basic)
       when the two together raise J. All moves pass canAdd (budget, bracket, creature cap, combos). */
    {
      const t0 = Date.now(), timeCap = +(S.optTimeMs || 60000); // safety only: rounds, not time, end the search, so results never depend on machine speed
      const Wl = W.link != null ? +W.link : 1;
      const NP = PAIRS.length, tagKeys = new Set(tags.map(t => t.key));
      const PW = PAIRS.map(p => (cmds.some(c => p.en(c) || p.pay(c)) || tagKeys.has(p.key)) ? 1 : 0.35);
      const sidesCache = new Map();
      const sides = c => { let v = sidesCache.get(c); if (v) return v; v = []; PAIRS.forEach((p, i) => { if (p.en(c)) v.push(2 * i); if (p.pay(c)) v.push(2 * i + 1); }); sidesCache.set(c, v); return v; };
      const ORS = plan && plan.quota ? ROLES.concat(['plan']) : ROLES, hasR = (c, r) => r === 'plan' ? plan.isPlan(c) : !!analyze(c).roles[r];
      const roleBits = c => { let b = 0; ORS.forEach((r, i) => { if (hasR(c, r)) b |= 1 << i; }); return b; };
      const pc = b => { let n = 0; while (b) { n += b & 1; b >>>= 1; } return n; };
      const G = (i, en, pay) => PW[i] * 2 * Math.sqrt(en * pay);
      const cnt = new Float64Array(NP * 2);
      for (const c of cmds) for (const k of sides(c)) cnt[k] += 3; // commander counts 3, as in the analysis
      for (const e of deck) if (!isBasic(e.c)) for (const k of sides(e.c)) cnt[k] += e.qty;
      const synTotal = () => { let g = 0; for (let i = 0; i < NP; i++) g += G(i, cnt[2 * i], cnt[2 * i + 1]); return Wl * g; };
      const tgt = ORS.map(r => r === 'plan' ? plan.quota : +S.targets[r] || 0), rc = ORS.map(r => r === 'plan' ? deck.filter(e => !analyze(e.c).isLand && plan.isPlan(e.c)).length : roleCount(r));
      const nlE = () => deck.filter(e => !analyze(e.c).isLand);
      const nN = nlE().reduce((s, e) => s + e.qty, 0); let mvSum = nlE().reduce((s, e) => s + e.c.cmc * e.qty, 0);
      const curvePen = sum => W.curve * 8 * Math.max(0, Math.abs((nN ? sum / nN : T) - T) - 0.15);
      const shortfall = () => ORS.reduce((s, r, i) => s + Math.max(0, tgt[i] - rc[i]), 0);
      const landVal = c => isBasic(c) ? 0 : landScore(c);
      const J = () => deck.reduce((s, e) => s + (analyze(e.c).isLand ? landVal(e.c) * e.qty : base(e.c) * e.qty), 0) + synTotal() - W.role * 2 * shortfall() - curvePen(mvSum);
      const pr = c => isBasic(c) && !S.budget.inclBasics ? 0 : (price(c) || 0);
      const split = sd => { const both = [], one = []; for (const k of sd) { if (k % 2 === 0 && sd.includes(k + 1)) both.push(k / 2); else if (!(k % 2 === 1 && sd.includes(k - 1))) one.push(k); } return { both, one }; };
      const cands = pool.filter(c => !analyze(c).isLand).map(c => ({ c, b: base(c), sd: sides(c), ...split(sides(c)), rb: roleBits(c), cr: analyze(c).creature, mv: c.cmc, p: pr(c), inDeck: st.names.has(c.n) }));
      const byName = new Map(cands.map(x => [x.c.n, x]));
      const bestBasic = () => { const sh = (R.pipShare || []).slice().sort((a, b) => b.w - a.w); for (const x of sh) if (basicsCards[x.x]) return basicsCards[x.x]; return basicsCards[Object.keys(basicsCards)[0]]; };
      const J0 = J(); let pairs = 0, rounds = 0; const swaps = [], tabu = new Set();
      const validBudget = () => cap == null || st.total <= cap + 1e-9;
      const doSwap = (out, x, d, tag) => {
        for (const k of sides(out.c)) cnt[k] -= 1; const ob = roleBits(out.c); ORS.forEach((r, i) => { if (ob & (1 << i)) rc[i]--; });
        if (!analyze(out.c).isLand) mvSum -= out.c.cmc;
        const xr = x.land ? null : ORS.find((r, i) => (x.rb & (1 << i)) && rc[i] < tgt[i]) || ORS.find((r, i) => (x.rb & (1 << i)) && (roleBits(out.c) & (1 << i)));
        const slot = (xr === 'plan' ? 'synergy' : xr) || (!x.land && synOf(x.c).s > 0 ? 'synergy' : 'flex');
        removeEntry(out); const ox = byName.get(out.c.n); if (ox) ox.inDeck = false;
        if (x.land) { const ex = deck.find(e => e.c === x.c); if (ex) { ex.qty++; st.total += pr(x.c); } else add(x.c, 'basic', 1, 0, 'optimiser: budget for a better spell'); }
        else { add(x.c, slot, 1, x.b, 'optimiser swap (' + tag + ')'); x.inDeck = true; for (const k of x.sd) cnt[k] += 1; ORS.forEach((r, i) => { if (x.rb & (1 << i)) rc[i]++; }); mvSum += x.mv; }
        swaps.push({ out: out.c.n, in: x.c.n, d, tag });
      };
      // exact change in J for one swap in the current state (used to verify paired moves)
      const exactD = (out, x) => { const snap = { cnt: Float64Array.from(cnt), rc: rc.slice(), mv: mvSum };
        for (const k of sides(out.c)) cnt[k] -= 1; const ob = roleBits(out.c); ORS.forEach((r, i) => { if (ob & (1 << i)) rc[i]--; }); if (!analyze(out.c).isLand) mvSum -= out.c.cmc;
        if (!x.land) { for (const k of x.sd) cnt[k] += 1; ORS.forEach((r, i) => { if (x.rb & (1 << i)) rc[i]++; }); mvSum += x.mv; }
        const outV = analyze(out.c).isLand ? landVal(out.c) : base(out.c), inV = x.land ? 0 : x.b;
        const synAfter = synTotal(), sfAfter = shortfall(), cpAfter = curvePen(mvSum);
        cnt.set(snap.cnt); rc.splice(0, rc.length, ...snap.rc); mvSum = snap.mv;
        return (inV - outV) + (synAfter - synTotal()) - W.role * 2 * (sfAfter - shortfall()) - (cpAfter - curvePen(mvSum)); };
      for (; rounds < 250 && Date.now() - t0 < timeCap; rounds++) {
        const outs = deck.filter(e => !e.locked && e.qty === 1 && e.slot !== 'combo' && e.slot !== 'include' && !analyze(e.c).isLand);
        const moves = [], blocked = [];
        const BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
        const down = BUCKETS.map(() => []); // per saving bucket: best few (d, out, x) with saving ≥ bucket
        const pushDown = (sv, d, e, x) => { for (let b = 0; b < BUCKETS.length && BUCKETS[b] <= sv; b++) { const L2 = down[b]; if (L2.length < 6 || d > L2[L2.length - 1].d) { L2.push({ d, e, x }); L2.sort((a, b2) => b2.d - a.d); if (L2.length > 6) L2.pop(); } } };
        const curNow = curvePen(mvSum), synNow = synTotal(), sfNow = shortfall();
        const gain = new Float64Array(NP * 2), gainBoth = new Float64Array(NP);
        for (const e of outs) {
          const c = e.c, cs = sides(c), cb = roleBits(c), bc = base(c), pOut = pr(c);
          for (const k of cs) cnt[k] -= 1;
          let gNoC = 0;
          for (let i = 0; i < NP; i++) { const en = cnt[2 * i], pay = cnt[2 * i + 1], g = G(i, en, pay); gNoC += g; gain[2 * i] = G(i, en + 1, pay) - g; gain[2 * i + 1] = G(i, en, pay + 1) - g; gainBoth[i] = G(i, en + 1, pay + 1) - g; }
          for (const k of cs) cnt[k] += 1;
          const lossC = synNow - Wl * gNoC;
          let needMask = 0, openMask = 0;
          ORS.forEach((r, i) => { if ((cb & (1 << i)) && rc[i] <= tgt[i]) needMask |= 1 << i; if (!(cb & (1 << i)) && rc[i] < tgt[i]) openMask |= 1 << i; });
          const cp = new Map();
          const fixed = -bc - lossC + curNow;
          for (let q = 0; q < cands.length; q++) {
            const x = cands[q]; pairs++;
            if (x.inDeck || (x.rb & needMask) !== needMask) continue; // never open a role shortfall
            let sg = 0; const one = x.one, both = x.both; for (let k = 0; k < one.length; k++) sg += gain[one[k]]; for (let k = 0; k < both.length; k++) sg += gainBoth[both[k]];
            let cpv = cp.get(x.mv); if (cpv === undefined) { cpv = curvePen(mvSum - c.cmc + x.mv); cp.set(x.mv, cpv); }
            const d = x.b + fixed + Wl * sg + W.role * 2 * pc(x.rb & openMask) - cpv;
            if (d > 1e-6) (cap != null && st.total - pOut + x.p > cap + 1e-9 ? blocked : moves).push({ e, x, d });
            if (cap != null && pOut - x.p >= BUCKETS[0]) pushDown(pOut - x.p, d, e, x);
          }
        }
        // nonbasic land → basic as a budget source
        if (cap != null) { const bb = bestBasic(); if (bb) for (const e of deck) if (!e.locked && analyze(e.c).isLand && !isBasic(e.c) && e.qty === 1 && pr(e.c) - pr(bb) >= BUCKETS[0]) pushDown(pr(e.c) - pr(bb), landVal(bb) - landVal(e.c), e, { c: bb, land: true, p: pr(bb) }); }
        // every budget-feasible improving move is tried in order (no cut-off), then the best budget-blocked ones for pairing
        const ord = (a, b) => b.d - a.d || (a.x.c.n < b.x.c.n ? -1 : 1);
        moves.sort(ord); blocked.sort(ord);
        let applied = 0; const usedOut = new Set(), usedIn = new Set();
        for (const m of moves.concat(blocked.slice(0, 300))) {
          if (applied >= 8) break;
          if (usedOut.has(m.e) || usedIn.has(m.x.c.n) || m.x.inDeck || !deck.includes(m.e)) continue;
          if (cmin != null && analyze(m.e.c).creature && !m.x.cr && st.creatures - 1 < cmin) continue;
          const dd = applied ? exactD(m.e, m.x) : m.d; if (dd <= 1e-6) continue;
          const why = canAdd(m.x.c, { replacing: m.e });
          if (!why) { doSwap(m.e, m.x, dd, 'single'); usedOut.add(m.e); usedIn.add(m.x.c.n); applied++; continue; }
          if (why !== 'total budget' || cap == null) continue;
          // pair with a cheaper swap elsewhere so the two together fit the budget and raise J
          const over = st.total - pr(m.e.c) + m.x.p - cap;
          const bi = BUCKETS.findIndex(b => b >= over - 1e-9); if (bi < 0) continue;
          for (const dn of down[bi]) {
            if (dn.e === m.e || dn.x.c === m.x.c || usedOut.has(dn.e) || tabu.has(dn.e.c.n) || !deck.includes(dn.e) || (dn.x.c && !dn.x.land && dn.x.inDeck)) continue;
            if (dd + dn.d <= 1e-6) continue;
            if (!dn.x.land && canAdd(dn.x.c, { replacing: dn.e })) continue;
            if (canAdd(m.x.c, { replacing: m.e, slack: pr(dn.e.c) - dn.x.p })) continue; // other limits (bracket, combos, creatures) still block it
            const d2 = exactD(dn.e, dn.x); if (dd + d2 <= 1e-6) continue;
            // apply both, then keep them only if J really rose (state snapshot makes this exact and reversible)
            const Jb = J(), snap = { deck: deck.map(e => [e, e.qty]), total: st.total, cnt: Object.assign({}, st.cnt), cr: st.creatures, names: new Set(st.names), pc: Float64Array.from(cnt), rc: rc.slice(), mv: mvSum, inD: cands.map(x => x.inDeck), sw: swaps.length };
            doSwap(dn.e, dn.x, d2, 'budget pair');
            const d1 = exactD(m.e, m.x); doSwap(m.e, m.x, d1, 'budget pair');
            if (J() <= Jb + 1e-6 || validBudget() === false) {
              deck.splice(0, deck.length, ...snap.deck.map(([e, q]) => { e.qty = q; return e; })); st.total = snap.total; st.cnt = snap.cnt; st.creatures = snap.cr; st.names = snap.names;
              cnt.set(snap.pc); rc.splice(0, rc.length, ...snap.rc); mvSum = snap.mv; cands.forEach((x, i) => { x.inDeck = snap.inD[i]; }); swaps.length = snap.sw; continue;
            }
            usedOut.add(m.e); usedOut.add(dn.e); usedIn.add(m.x.c.n); tabu.add(m.x.c.n); applied += 2; break;
          }
        }
        if (!applied) break;
      }
      const J1 = J();
      R.optimize = { baseline: J0, final: J1, swaps, pairs, rounds, pool: cands.length, ms: Date.now() - t0, timedOut: Date.now() - t0 >= timeCap };
      L('Optimise: deck score ' + J0.toFixed(1) + ' → ' + J1.toFixed(1) + ' after ' + swaps.length + ' swap(s) in ' + rounds + ' round(s); ' + pairs.toLocaleString() + ' (deck card, pool card) pairs scored across ' + cands.length.toLocaleString() + ' nonland candidates in ' + R.optimize.ms + ' ms' + (R.optimize.timedOut ? ' (time cap reached)' : '; no improving swap left') + '.');
      for (const w of swaps) L('  ' + w.tag + ': ' + w.out + ' → ' + w.in + ' (' + (w.d >= 0 ? '+' : '') + w.d.toFixed(2) + ')');
    }

    /* deck score from scratch for the current list (same J as the optimiser), so edits and history show a comparable number */
    R.deckScore = () => {
      const Wl = W.link != null ? +W.link : 1, tagKeys = new Set(tags.map(t => t.key));
      const cnt = new Float64Array(PAIRS.length * 2);
      const addSides = (c, q) => PAIRS.forEach((p, i) => { if (p.en(c)) cnt[2 * i] += q; if (p.pay(c)) cnt[2 * i + 1] += q; });
      for (const c of cmds) addSides(c, 3);
      let b = 0, mv = 0, n = 0; const rc = {};
      for (const e of deck) { const a = analyze(e.c); if (!isBasic(e.c)) addSides(e.c, e.qty); for (const r of ROLES) if (a.roles[r]) rc[r] = (rc[r] || 0) + 1;
        if (a.isLand) b += isBasic(e.c) ? 0 : landScore(e.c) * e.qty; else { b += base(e.c) * e.qty; mv += e.c.cmc * e.qty; n += e.qty; } }
      let g = 0; PAIRS.forEach((p, i) => { const w = (cmds.some(c => p.en(c) || p.pay(c)) || tagKeys.has(p.key)) ? 1 : 0.35; g += w * 2 * Math.sqrt(cnt[2 * i] * cnt[2 * i + 1]); });
      const sf = ROLES.reduce((s2, r) => s2 + Math.max(0, (+S.targets[r] || 0) - (rc[r] || 0)), 0);
      return b + Wl * g - W.role * 2 * sf - W.curve * 8 * Math.max(0, Math.abs((n ? mv / n : T) - T) - 0.15);
    };

    /* imported as-is: drop whatever steps 2–7b added, so the deck is exactly the pasted list */
    if (env.asIs) { for (const e of deck.filter(x => !x.locked)) removeEntry(e); R.shortfalls = []; R.optimize = null; R.asIs = true; L('Imported as-is: ' + size() + ' card(s), no slots filled.'); }

    /* 8. validate + auto-repair */
    R._runBan = new Set();
    const ctx = { db, S, CI, lim, cap, pcap, cur, price, combos, comboForbidden, mainSize, cmin, cmax, excludeSet, cmds };
    for (let iter = 0; iter < (env.asIs ? 0 : 120); iter++) {
      const v = await validate(R, ctx);
      R.validation = v;
      const fail = v.rules.find(r => r.pass === false && !r.stuck);
      if (!fail) break;
      if (fail.id === 'count') {
        const n = size() + cmds.length;
        if (n < 100) { addBasics(100 - n, 'repair: deck short'); L('Repair: added ' + (100 - n) + ' basic(s) to reach 100.'); continue; }
        const victim = deck.filter(e => !e.locked).sort((a, b) => a.score - b.score)[0];
        if (!victim) { fail.stuck = true; continue; }
        if (victim.qty > 1) { victim.qty--; st.total -= (S.budget.inclBasics ? price(victim.c) || 0 : 0); } else removeEntry(victim);
        L('Repair: removed 1 ' + victim.c.n + ' (deck over 100).');
        continue;
      }
      const offenders = deck.filter(e => !e.locked && fail.offenders.includes(e.c.n)).sort((a, b) => a.score - b.score || (a.c.n < b.c.n ? -1 : 1));
      if (!offenders.length) { R.warnings.push('Validation "' + fail.label + '" fails on locked/include cards or commanders only: ' + fail.offenders.join(', ') + '. Not auto-repaired.'); fail.stuck = true; R._stuck = (R._stuck || new Set()).add(fail.id); if (R._stuck.size > 10) break; continue; }
      const victim = offenders[0];
      removeEntry(victim); R._runBan.add(victim.c.n);
      let rep = null;
      if (isBasic(victim.c)) { /* budget: basics are the floor; drop to fewer? keep count */ addBasics(victim.qty); L('Repair (' + fail.label + '): re-added basics.'); continue; }
      const va = analyze(victim.c);
      const filt = va.isLand ? (c => landOK(c)) : (ROLES.includes(victim.slot) ? (c => !analyze(c).isLand && analyze(c).roles[victim.slot]) : (c => !analyze(c).isLand));
      const cands = sortScored(pool.filter(c => !st.names.has(c.n) && filt(c)).map(c => ({ c, s: va.isLand ? landScore(c) : dyn(c) })));
      for (const x of cands) {
        if (fail.id === 'budget' && cap != null && (price(x.c) || 0) >= (price(victim.c) || 0)) continue;
        if (!canAdd(x.c)) { rep = x; break; }
      }
      if (!rep && !va.isLand && ROLES.includes(victim.slot)) {
        for (const x of sortScored(pool.filter(c => !st.names.has(c.n) && !analyze(c).isLand).map(c => ({ c, s: dyn(c) })))) { if (fail.id === 'budget' && cap != null && (price(x.c) || 0) >= (price(victim.c) || 0)) continue; if (!canAdd(x.c)) { rep = x; break; } }
      }
      if (rep) { add(rep.c, va.isLand ? 'land' : (ROLES.includes(victim.slot) && analyze(rep.c).roles[victim.slot] ? victim.slot : 'flex'), 1, rep.s, 'repair replacement'); L('Repair (' + fail.label + '): removed ' + victim.c.n + ' (score ' + victim.score.toFixed(2) + ') → ' + rep.c.n + ' (score ' + rep.s.toFixed(2) + ').'); }
      else { addBasics(victim.qty, 'repair: no eligible replacement'); L('Repair (' + fail.label + '): removed ' + victim.c.n + '; no eligible replacement, added basic land.'); }
    }
    R.validation = await validate(R, ctx);
    R.stats = stats(R, ctx);
    R.ok = R.validation.rules.every(r => r.pass !== false);

    /* session helpers for per-card actions */
    R.ctx = ctx;
    R.alternatives = function (entry, k) {
      k = k || 5;
      const a = analyze(entry.c);
      const filt = a.isLand ? (c => landOK(c)) : (ROLES.includes(entry.slot) ? (c => !analyze(c).isLand && analyze(c).roles[entry.slot]) : (c => !analyze(c).isLand));
      return sortScored(pool.filter(c => !st.names.has(c.n) && filt(c)).map(c => ({ c, s: a.isLand ? landScore(c) : dyn(c) })))
        .filter(x => !canAdd(x.c, { replacing: entry })).slice(0, k).map(x => ({ c: x.c, s: x.s, why: reason(x.c, a.isLand ? 'land' : entry.slot) }));
    };
    R.replace = async function (entry, card, locked) {
      removeEntry(entry);
      const a = analyze(card);
      const slot = a.isLand ? 'land' : (ROLES.includes(entry.slot) && a.roles[entry.slot] ? entry.slot : entry.slot === 'combo' ? 'flex' : entry.slot);
      const e = add(card, slot, 1, a.isLand ? landScore(card) : dyn(card), 'manual swap for ' + entry.c.n, { locked: !!locked });
      L('Manual swap: ' + entry.c.n + ' → ' + card.n + '.');
      R.validation = await validate(R, ctx); R.stats = stats(R, ctx); R.ok = R.validation.rules.every(r => r.pass !== false);
      return e;
    };
    // dry run of a replace: which validation rules would newly fail. The deck is put back exactly as it was.
    R.checkReplace = async function (entry, card) {
      const i = deck.indexOf(entry); if (i < 0) return null;
      const failed = new Set((R.validation ? R.validation.rules : []).filter(r => r.pass === false).map(r => r.id));
      removeEntry(entry);
      const e = add(card, entry.slot, 1, 0, 'check', { locked: true });
      const v = await validate(R, ctx);
      removeEntry(e);
      deck.splice(i, 0, entry); st.names.add(entry.c.n);
      st.total += (isBasic(entry.c) && !S.budget.inclBasics ? 0 : (price(entry.c) || 0)) * entry.qty;
      const ea = analyze(entry.c); for (const k of Object.keys(st.cnt)) if (ea.flags[k]) st.cnt[k] += entry.qty; if (ea.creature) st.creatures += entry.qty;
      R.validation = await validate(R, ctx); R.stats = stats(R, ctx); R.ok = R.validation.rules.every(r => r.pass !== false);
      return v.rules.filter(r => r.pass === false && !failed.has(r.id));
    };
    // several one-copy swaps at once (combo pieces, budget upgrades): pairs [{ entry, card }]. With dry, returns the
    // validation rules that would newly fail and puts the deck back exactly as it was; otherwise applies them, locked.
    R.replaceMany = async function (pairs, dry) {
      const failed = new Set((R.validation ? R.validation.rules : []).filter(r => r.pass === false).map(r => r.id));
      const snap = { deck: deck.map(e => Object.assign({}, e)), names: new Set(st.names), total: st.total, cnt: Object.assign({}, st.cnt), creatures: st.creatures };
      const objs = deck.slice();
      for (const { entry, card } of pairs) {
        if (deck.indexOf(entry) < 0) continue;
        const a = analyze(card);
        if ((entry.qty || 1) > 1) { entry.qty--; st.total -= (isBasic(entry.c) && !S.budget.inclBasics ? 0 : (price(entry.c) || 0)); for (const k of Object.keys(st.cnt)) if (analyze(entry.c).flags[k]) st.cnt[k]--; if (analyze(entry.c).creature) st.creatures--; }
        else removeEntry(entry);
        const slot = a.isLand ? 'land' : (ROLES.includes(entry.slot) && a.roles[entry.slot] ? entry.slot : entry.slot === 'combo' || entry.slot === 'land' ? 'flex' : entry.slot);
        add(card, slot, 1, a.isLand ? landScore(card) : dyn(card), dry ? 'check' : 'swap for ' + entry.c.n, { locked: true });
        if (!dry) L('Swap: ' + entry.c.n + ' → ' + card.n + '.');
      }
      const v = await validate(R, ctx);
      if (dry) {
        deck.splice(0, deck.length, ...objs); objs.forEach((e, i) => Object.assign(e, snap.deck[i]));
        st.names = snap.names; st.total = snap.total; st.cnt = snap.cnt; st.creatures = snap.creatures;
        return v.rules.filter(r => r.pass === false && !failed.has(r.id));
      }
      R.validation = v; R.stats = stats(R, ctx); R.ok = R.validation.rules.every(r => r.pass !== false);
      return [];
    };
    // one-copy swap (used by accepted recommendations): splits multi-copy entries such as basics
    R.swapOne = async function (entry, card) {
      if ((entry.qty || 1) > 1) {
        entry.qty--; st.total -= (isBasic(entry.c) && !S.budget.inclBasics ? 0 : (price(entry.c) || 0));
        const a = analyze(card);
        add(card, a.isLand ? 'land' : 'flex', 1, a.isLand ? landScore(card) : dyn(card), 'accepted recommendation (replaces one ' + entry.c.n + ')', { locked: true });
        L('Accepted recommendation: one ' + entry.c.n + ' → ' + card.n + '.');
        R.validation = await validate(R, ctx); R.stats = stats(R, ctx); R.ok = R.validation.rules.every(r => r.pass !== false);
        return;
      }
      await R.replace(entry, card, true);
    };
    R.remove = async function (entry) {
      const alts = R.alternatives(entry, 1);
      bans.add(entry.c.n); R.bans = [...bans];
      if (alts.length) return R.replace(entry, alts[0].c, false).then(e => { L('Removed ' + entry.c.n + ' by user; replaced with ' + e.c.n + '.'); return e; });
      removeEntry(entry); addBasics(entry.qty, 'replacement for removed card'); L('Removed ' + entry.c.n + ' by user; no eligible replacement, added basic land.');
      R.validation = await validate(R, ctx); R.stats = stats(R, ctx); R.ok = R.validation.rules.every(r => r.pass !== false);
      return null;
    };
    R.bans = [...bans];
    return R;
  }

  /* ---------- validation ---------- */
  async function validate(R, ctx) {
    const { CI, lim, cap, pcap, cur, price, combos, comboForbidden, S, cmin, cmax, excludeSet, cmds } = ctx;
    const rules = [];
    const all = cmds.map(c => ({ c, qty: 1, cmd: true })).concat(R.deck);
    const total = all.reduce((s, e) => s + e.qty, 0);
    rules.push({ id: 'count', label: '100 cards', pass: total === 100, detail: total + ' cards (' + cmds.length + ' commander' + (cmds.length > 1 ? 's' : '') + ' + ' + (total - cmds.length) + ')', offenders: [] });
    const counts = new Map(); for (const e of all) counts.set(e.c, (counts.get(e.c) || 0) + e.qty);
    const dup = [...counts.entries()].filter(([c, n]) => n > analyze(c).exempt).map(([c]) => c.n);
    const exemptUsed = [...counts.entries()].filter(([c, n]) => n > 1 && !isBasic(c)).map(([c, n]) => n + 'x ' + c.n);
    rules.push({ id: 'singleton', label: 'Singleton', pass: dup.length === 0, detail: dup.length ? 'Duplicates: ' + dup.join(', ') : 'No duplicates except basics' + (exemptUsed.length ? ' and exempt cards (' + exemptUsed.join(', ') + ')' : ''), offenders: dup });
    const offCI = R.deck.filter(e => !subsetCI(e.c.ci, CI)).map(e => e.c.n);
    rules.push({ id: 'identity', label: 'Color identity', pass: offCI.length === 0, detail: offCI.length ? 'Outside ' + (CI || 'C') + ': ' + offCI.join(', ') : 'All cards within ' + (CI || 'colorless'), offenders: offCI });
    const illegal = all.filter(e => e.c.leg !== 'legal').map(e => e.c.n + ' (' + e.c.leg + ')');
    rules.push({ id: 'legality', label: 'Legality (Commander, not banned)', pass: illegal.length === 0, detail: illegal.length ? illegal.join(', ') : 'All cards legal per Scryfall legalities.commander', offenders: all.filter(e => e.c.leg !== 'legal').map(e => e.c.n) });
    const ex = R.deck.filter(e => excludeSet.has(e.c.n)).map(e => e.c.n);
    rules.push({ id: 'exclude', label: 'Exclude list respected', pass: ex.length === 0, detail: ex.length ? ex.join(', ') : 'No excluded cards present', offenders: ex });
    let totalP = 0, unknown = [];
    for (const e of all) { if (isBasic(e.c) && !S.budget.inclBasics) continue; const p = price(e.c); if (p == null) { if (!isBasic(e.c)) unknown.push(e.c.n); continue; } totalP += p * e.qty; }
    R.totalPrice = totalP; R.unknownPrice = unknown;
    if (cap != null || pcap != null) {
      const overPer = pcap != null ? R.deck.filter(e => !isBasic(e.c) && price(e.c) != null && price(e.c) > pcap + 1e-9).map(e => e.c.n) : [];
      const overTotal = cap != null && totalP > cap + 1e-9;
      const offenders = overPer.length ? overPer : (overTotal ? R.deck.filter(e => !isBasic(e.c)).sort((a, b) => (price(b.c) || 0) - (price(a.c) || 0)).slice(0, 5).map(e => e.c.n) : []);
      rules.push({ id: 'budget', label: 'Budget', pass: !overTotal && !overPer.length, detail: 'Total ' + fmt(totalP, cur) + (cap != null ? ' / cap ' + fmt(cap, cur) + (overTotal ? ' (over by ' + fmt(totalP - cap, cur) + ')' : '') : '') + (pcap != null ? '; per-card cap ' + fmt(pcap, cur) + (overPer.length ? ' exceeded by ' + overPer.join(', ') : ' respected') : '') + (unknown.length ? '; ' + unknown.length + ' card(s) without price' : ''), offenders });
    } else rules.push({ id: 'budget', label: 'Budget', pass: true, detail: 'No cap set. Total ' + fmt(totalP, cur) + (unknown.length ? '; ' + unknown.length + ' card(s) without price' : ''), offenders: [] });
    const flagged = k => all.filter(e => analyze(e.c).flags[k]);
    const bparts = [], boff = [];
    let bpass = true;
    for (const k of ['gc', 'mld', 'xturn', 'tutor']) {
      const f = flagged(k), n = f.reduce((s, e) => s + e.qty, 0);
      const l = lim[k];
      bparts.push(FLAGS[k].label + ' ' + n + '/' + (l >= 999 ? '∞' : l));
      if (n > l) { bpass = false; f.forEach(e => { if (!e.cmd) boff.push(e.c.n); }); }
    }
    let comboPass = null, comboDetail = 'combo data unavailable (load the Commander Spellbook variants file)';
    R.combos = [];
    if (combos) {
      try {
        const found = await combos.find(all.map(e => e.c.n), cmds.map(c => c.n));
        R.combos = found; R.comboStatus = combos.kind;
        const twoInf = found.filter(v => v.inf && v.c.length <= 2);
        const forbidden = found.filter(v => comboForbidden(v));
        comboPass = twoInf.length <= lim.combo2 && !forbidden.length;
        comboDetail = '2-card infinite ' + twoInf.length + '/' + (lim.combo2 >= 999 ? '∞' : lim.combo2) + '; ' + found.length + ' combo(s) detected' + (forbidden.length ? '; ' + forbidden.length + ' blocked by combo filter' : '');
        if (!comboPass) { const bad = (forbidden.length ? forbidden : twoInf); for (const v of bad) for (const n of v.c) { const e = R.deck.find(x => nameKey(x.c.n) === nameKey(n) || nameKey(x.c.fn) === nameKey(n)); if (e && !boff.includes(e.c.n)) boff.push(e.c.n); } }
      } catch (err) { comboDetail = 'combo lookup failed: ' + (err && err.message || err); R.comboStatus = 'error'; }
    }
    if (comboPass === false) bpass = false;
    rules.push({ id: 'bracket', label: 'Bracket ' + S.bracket + ' limits', pass: bpass, detail: bparts.join('; ') + '; ' + comboDetail, offenders: boff, comboVerified: comboPass !== null });
    const cr = R.deck.filter(e => analyze(e.c).creature).reduce((s, e) => s + e.qty, 0) + 0;
    if (cmin != null || cmax != null) {
      const okC = (cmin == null || cr >= cmin) && (cmax == null || cr <= cmax);
      rules.push({ id: 'creatures', label: 'Creature count', pass: okC, detail: cr + ' creatures (range ' + (cmin != null ? cmin : 0) + '–' + (cmax != null ? cmax : '∞') + ')', offenders: cmax != null && cr > cmax ? R.deck.filter(e => analyze(e.c).creature).map(e => e.c.n) : [] });
    }
    return { rules, at: new Date().toISOString() };
  }

  /* ---------- stats ---------- */
  function typeGroup(c) { const t = c.ft; for (const g of ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment']) if (new RegExp('\\b' + g + '\\b').test(t)) return g; return 'Other'; }
  function stats(R, ctx) {
    const { S, price, cur } = ctx;
    const deck = R.deck;
    const curve = [0, 0, 0, 0, 0, 0, 0, 0];
    let mvSum = 0, mvN = 0;
    const pp = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const src = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    for (const c of R.commanders) { const p = pips(c.mc); for (const k in pp) pp[k] += p[k]; }
    for (const e of deck) {
      const a = analyze(e.c);
      if (!a.isLand) { curve[Math.min(7, Math.floor(e.c.cmc))] += e.qty; mvSum += e.c.cmc * e.qty; mvN += e.qty; const p = pips(e.c.mc); for (const k in pp) pp[k] += p[k] * e.qty; }
      if (a.isLand || a.roles.ramp) {
        let cols = e.c.pm.slice();
        if (a.land === 'fetch') { const map = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' }; cols = /basic land/.test(e.c.low) ? R.CI.split('') : (e.c.low.match(/plains|island|swamp|mountain|forest/g) || []).map(x => map[x]); }
        if (a.land === 'command' || /mana of any (?:one )?colou?r/.test(e.c.low)) cols = R.CI.split('');
        for (const x of new Set(cols)) if (src[x] != null && (R.CI.includes(x) || x === 'C')) src[x] += e.qty;
      }
    }
    const roles = {};
    for (const r of ROLES) roles[r] = { have: deck.filter(e => analyze(e.c).roles[r]).length, target: +S.targets[r] || 0 };
    roles.lands = { have: deck.reduce((s, e) => s + (analyze(e.c).isLand ? e.qty : 0), 0), target: +S.targets.lands || 0 };
    const gcs = R.commanders.concat(deck.map(e => e.c)).filter(c => c.gc).map(c => c.n);
    const creatures = deck.filter(e => analyze(e.c).creature).reduce((s, e) => s + e.qty, 0);
    return { curve, avgMV: mvN ? mvSum / mvN : 0, pips: pp, sources: src, roles, gcs, creatures, total: R.totalPrice, unknown: R.unknownPrice, cur };
  }

  function fmt(v, cur) { if (v == null) return '—'; const s = cur === 'eur' ? '€' : cur === 'tix' ? '' : '$'; return cur === 'tix' ? v.toFixed(2) + ' tix' : s + v.toFixed(2); }

  /* ---------- exports ---------- */
  function exportDeck(R, fmtName) {
    const cmds = R.commanders, deck = R.deck.slice().sort((a, b) => a.c.n < b.c.n ? -1 : 1);
    const front = n => n.split(' // ')[0];
    const lines = [];
    switch (fmtName) {
      case 'plain': cmds.forEach(c => lines.push('1 ' + c.n)); deck.forEach(e => lines.push(e.qty + ' ' + e.c.n)); break;
      case 'arena': lines.push('Commander'); cmds.forEach(c => lines.push('1 ' + c.n)); lines.push('', 'Deck'); deck.forEach(e => lines.push(e.qty + ' ' + e.c.n)); break;
      case 'archidekt': cmds.forEach(c => lines.push('1x ' + c.n + ' [Commander{top}]')); deck.forEach(e => lines.push(e.qty + 'x ' + e.c.n)); break;
      case 'mtgo': deck.forEach(e => lines.push(e.qty + ' ' + front(e.c.n))); lines.push(''); cmds.forEach(c => lines.push('1 ' + front(c.n))); break;
      case 'csv': {
        const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
        lines.push(['Quantity', 'Name', 'Section', 'ManaCost', 'MV', 'Type', 'Slot', 'Roles', 'Price', 'Currency', 'EDHRECRank', 'GameChanger', 'Reason'].join(','));
        const row = (c, qty, sec, slot, why) => lines.push([qty, q(c.n), sec, q(c.mc), c.cmc, q(c.tl), slot, q(Object.keys(analyze(c).roles).join(' ')), c.p[R.stats.cur] == null ? '' : c.p[R.stats.cur], R.stats.cur.toUpperCase(), c.rank == null ? '' : c.rank, c.gc ? 1 : 0, q(why)].join(','));
        cmds.forEach(c => row(c, 1, 'Commander', 'commander', ''));
        deck.forEach(e => row(e.c, e.qty, 'Main', e.slot, e.why));
        break;
      }
    }
    return lines.join('\n') + '\n';
  }

  /* ---------- enabler / payoff synergy pairs (used by the generator's optimiser and by the analysis) ---------- */
  const PAIRS = [
    { key: 'tokens', label: 'Tokens', en: c => /\bcreates? [^.]*tokens?/.test(c.low), pay: c => /tokens? you control|whenever (?:a|another|one or more) (?:nontoken )?(?:creature|token)s? (?:you control )?enters|\bpopulate|creatures you control get \+/.test(c.low), enDesc: 'creates tokens', payDesc: 'rewards tokens / creatures entering / anthem' },
    { key: 'aristocrats', label: 'Sacrifice', en: c => /sacrifice (?:a|another|an?(?: \w+)?) (?:creature|permanent|artifact)[^.:]*:/.test(c.low) || /\bcreates? [^.]*creature tokens?/.test(c.low), pay: c => /whenever [^.]{0,50}(?:dies|is put into a graveyard from the battlefield)|whenever you sacrifice/.test(c.low), enDesc: 'sacrifice outlet or creature-token fodder', payDesc: 'death / sacrifice triggers' },
    { key: 'counters', label: '+1/+1 counters', en: c => /put (?:a|one|two|three|x|that many|\w+) \+1\/\+1 counters?|\bproliferate|enters (?:the battlefield )?with [^.]*\+1\/\+1 counters?/.test(c.low), pay: c => /(?:with|has|have) (?:a|one or more) \+1\/\+1 counters? on (?:it|them)|for each \+1\/\+1 counter|whenever (?:one or more )?\+1\/\+1 counters? (?:are|is) put|double the number of [^.]*counters/.test(c.low), enDesc: 'places counters / proliferate', payDesc: 'rewards creatures with counters' },
    { key: 'spells', label: 'Instants & sorceries', en: c => /\b(?:Instant|Sorcery)\b/.test(c.ft), pay: c => /whenever you cast (?:an|a) (?:instant|sorcery|noncreature)|\bmagecraft|instant (?:or|and) sorcery spells? you cast|copy target (?:instant|sorcery)/.test(c.low), enDesc: 'instant or sorcery card', payDesc: 'cast/copy triggers for spells' },
    { key: 'landfall', label: 'Landfall', en: c => /play (?:an|two) additional lands?|search your library for [^.]*land cards?[\s\S]{0,120}?onto the battlefield|return [^.]*land cards? from your graveyard to the battlefield/.test(c.low) || analyze(c).land === 'fetch', pay: c => /\blandfall|whenever a land (?:you control )?enters|whenever one or more lands (?:you control )?enter/.test(c.low), enDesc: 'extra land drops / land to battlefield / fetch', payDesc: 'landfall triggers' },
    { key: 'graveyard', label: 'Graveyard', en: c => /\bmills?\b|\bsurveil|\bdiscard (?:a|two|x|that many|your hand)|put the top [^.]* into your graveyard|\bdredge/.test(c.low), pay: c => /from your graveyard|cards? in your graveyard|\bflashback|\bescape|\bdelve|\bunearth|\bembalm|\beternalize/.test(c.low) || ['flashback', 'escape', 'delve', 'unearth', 'embalm', 'eternalize'].some(k => c.kw.includes(k)), enDesc: 'fills your graveyard', payDesc: 'uses cards in your graveyard' },
    { key: 'artifacts', label: 'Artifacts', en: c => /\bArtifact\b/.test(c.ft) || /creates? [^.]*(?:treasure|clue|food|blood|map|powerstone)/.test(c.low), pay: c => /artifacts? you control|whenever (?:an|another|one or more) (?:nontoken )?artifacts?|for each artifact|artifact spells? you cast/.test(c.low), enDesc: 'artifact or artifact token maker', payDesc: 'artifact-count / artifact triggers' },
    { key: 'enchantments', label: 'Enchantments', en: c => /\bEnchantment\b/.test(c.ft), pay: c => /enchantments? you control|whenever you cast an enchantment|\bconstellation|whenever (?:an|another) enchantment/.test(c.low), enDesc: 'enchantment card', payDesc: 'enchantment triggers / count' },
    { key: 'lifegain', label: 'Lifegain', en: c => /\bgain (?:\d+|x|that much|life equal)[^.]*life|\blifelink/.test(c.low) || c.kw.includes('lifelink'), pay: c => /whenever you gain life|for each 1 life you gained|life you gained this turn/.test(c.low), enDesc: 'gains life', payDesc: 'lifegain triggers' },
    { key: 'blink', label: 'Blink / ETB', en: c => /\bexile [^.]*you control[^.]*\.?[^.]*return (?:it|that card|them|those cards) to the battlefield|\bflicker/.test(c.low), pay: c => analyze(c).creature && /when (?:~|this creature) enters/.test(c.low), enDesc: 'flickers permanents', payDesc: 'creature with enter trigger' },
    { key: 'draw', label: 'Draw triggers', en: c => !!analyze(c).roles.draw, pay: c => /whenever you draw/.test(c.low), enDesc: 'draws cards', payDesc: 'draw triggers' }
  ];

  return { cardPower, POWER_PREF, PAIRS, defaults, bracketDefaults, BRACKETS, ROLES, SLOT_LABEL, ROLE_RULES, FLAGS, TAGS, LAND_CLASS_DESC, BASIC_NAMES,
    norm, buildDB, addAliases, lookup, nameKey, parseList, parseLine, splitCSV, analyze, pips, typeGroup, commanderEligibility, pairCheck, cmdTraits,
    spellbookVariants, localComboProvider, generate, exportDeck, fmt, hashStr, stable, isBasic, creatureTypes, STYLES, inspire, styleProfile };
})();
if (typeof module !== 'undefined') module.exports = Engine;
