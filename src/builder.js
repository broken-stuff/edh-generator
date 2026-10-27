/* ===== Builder: collection breakdown and hand-built decks (pure; uses Engine and Analysis) ===== */
const Builder = (function () {
  'use strict';
  const E = (typeof Engine !== 'undefined') ? Engine : require('./engine.js');
  const An = (typeof Analysis !== 'undefined') ? Analysis : require('./analysis.js');
  const subsetCI = (ci, CI) => [...ci].every(x => CI.includes(x));
  const CI_ORDER = 'WUBRG';

  /* ---------- categories: the Deck › Counts roles, then the commander's synergy themes ---------- */
  const ROLE_CATS = An.COUNT_CATS.map(([k, label, test]) => ({ key: k, label, test }));
  // a theme tag as the generator reads it: one of Engine.TAGS, or tribal:<Type>
  function themeTag(key) {
    if (key.startsWith('tribal:')) { const t = E.tribalTag(key.slice(7)); return { key, label: t.label, test: t.test }; }
    const t = E.TAGS[key]; if (!t) return null;
    return { key, label: t.label, test: c => !!((t.re && t.re.test(c.low)) || (t.type && t.type.test(c.tl)) || (t.flag && E.analyze(c).flags[t.flag])) };
  }
  // themes the generator would read from the commanders' rules text (Engine.generate, "commander text" tags)
  function cmdThemes(db, cmds) {
    const out = [];
    const add = k => { if (!out.includes(k)) out.push(k); };
    for (const c of cmds) {
      for (const k of Object.keys(E.TAGS)) if (E.TAGS[k].re && E.TAGS[k].re.test(c.low)) add(k);
      for (const T of E.creatureTypes(db)) {
        const lt = T.toLowerCase(); if (lt.length < 3) continue;
        if (new RegExp('\\b(?:' + lt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '|' + E.plural(lt) + ')\\b').test(c.low)) add('tribal:' + T);
      }
    }
    return out;
  }
  // the role and theme categories a card is in; 'other' = a nonland card with no role
  function cardCats(c, tags) {
    const roles = ROLE_CATS.filter(x => x.test(c)).map(x => x.key);
    if (!roles.length) roles.push('other');
    return { roles, themes: (tags || []).filter(t => t.test(c)).map(t => t.key) };
  }

  /* ---------- the pool: Commander-legal cards inside the colour identity, owned ones only when a set is given.
     Basic lands are always in it. Sorted by EDHREC rank. ---------- */
  function pool(db, CI, owned, cmds) {
    const skip = new Set((cmds || []).map(c => c.n));
    return db.all.filter(c => c.leg === 'legal' && !skip.has(c.n) && subsetCI(c.ci, CI) && (!owned || owned.has(c.n) || E.isBasic(c)))
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9) || (a.n < b.n ? -1 : 1));
  }
  // commander-eligible cards in a list
  const commanders = cards => cards.filter(c => E.commanderEligibility(c).ok).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));

  /* ---------- collection breakdown: per role, per theme and per colour identity ---------- */
  function breakdown(cards, tags) {
    const roles = Object.fromEntries(ROLE_CATS.map(x => [x.key, 0]).concat([['other', 0]]));
    const themes = Object.fromEntries((tags || []).map(t => [t.key, 0]));
    const types = Object.fromEntries(An.TYPE_CATS.map(([k]) => [k, 0]));
    const G = Object.fromEntries(An.TYPE_CATS.map(([k, , g]) => [g, k]));
    const ci = {};
    for (const c of cards) {
      const k = cardCats(c, tags);
      for (const r of k.roles) if (r !== 'other' || !E.analyze(c).isLand) roles[r]++;
      for (const t of k.themes) themes[t]++;
      const g = G[E.typeGroup(c)]; if (g) types[g]++;
      const id = c.ci || 'C'; ci[id] = (ci[id] || 0) + 1;
    }
    return { n: cards.length, roles, themes, types, ci };
  }

  /* ---------- tracker: the deck so far against the reference ranges for its bracket ---------- */
  // entries: [{ c, qty }] without the commanders
  function tally(entries, cmds, bracket, CI) {
    const b = +bracket || 0, rr = An.ROLE_RANGES[b] || An.ROLE_RANGES[0], tr = An.TYPE_RANGES[b] || An.TYPE_RANGES[0];
    const main = entries.reduce((s, e) => s + e.qty, 0);
    const roles = An.roleCounts(entries), types = An.typeCounts(entries);
    const curve = [0, 0, 0, 0, 0, 0, 0, 0], pips = { W: 0, U: 0, B: 0, R: 0, G: 0 }, sources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const e of entries) if (!E.analyze(e.c).isLand) curve[Math.min(7, Math.floor(e.c.cmc))] += e.qty;
    // pips of the commanders and the nonland cards; sources = lands that make each colour (Analysis.colourCheck)
    for (const c of cmds.concat(entries.filter(e => !E.analyze(e.c).isLand).map(e => e.c))) { const p = E.pips(c.mc); for (const x in pips) pips[x] += p[x]; }
    Object.assign(sources, An.colourCheck(entries, cmds, CI || '').landSrc);
    return { main, size: 100 - cmds.length, total: main + cmds.length, roles, types, curve, pips, sources, ranges: { roles: rr, types: tr }, b };
  }
  // basic lands to add so the deck reaches `lands` lands, split by the colour pips of its spells (Wastes when colourless)
  function basicsFor(entries, cmds, CI, lands) {
    const have = entries.filter(e => E.analyze(e.c).isLand).reduce((s, e) => s + e.qty, 0), need = Math.max(0, lands - have);
    const out = {}; if (!need) return out;
    const cols = CI.split('').filter(x => CI_ORDER.includes(x));
    if (!cols.length) { out.C = need; return out; }
    const p = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const c of cmds.concat(entries.map(e => e.c))) { const q = E.pips(c.mc); for (const x in p) p[x] += q[x]; }
    const tot = cols.reduce((s, x) => s + p[x], 0);
    const share = cols.map(x => ({ x, v: tot ? p[x] / tot * need : need / cols.length }));
    for (const s of share) out[s.x] = Math.floor(s.v);
    let left = need - share.reduce((s, x) => s + out[x.x], 0);
    for (const s of share.slice().sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)))) { if (!left) break; out[s.x]++; left--; }
    return out;
  }
  // "Commander" and "Deck" sections, which the importer reads
  const exportList = (cmds, entries) => E.exportDeck({ commanders: cmds, deck: entries }, 'arena');

  return { ROLE_CATS, themeTag, cmdThemes, cardCats, pool, commanders, breakdown, tally, basicsFor, exportList };
})();
if (typeof module !== 'undefined') module.exports = Builder;
