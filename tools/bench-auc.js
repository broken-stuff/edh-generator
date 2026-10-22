#!/usr/bin/env node
/* Does the swap objective tell weak cards from good ones? On the damaged decks of tools/bench-recover.js (same seeds), each
   nonland card is cut for a basic land and the objective change g is measured (common random numbers). AUC = probability that
   a planted filler card costs less to cut than an original card of the deck (0.5 = no better than chance). Reported for the
   full objective, its goldfish part (without the table win term), the table win alone, the planner's heuristic value and
   EDHREC rank.
   Usage: node tools/bench-auc.js [dataDir] [--decks 20] [--games 1500] [--bracket 4] [--k 10] */
'use strict';
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data';
const ND = +opt('decks', 20), GAMES = +opt('games', 1500), BR = +opt('bracket', 4), K = +opt('k', 10);
const { load, deckOf } = require('./ref-load.js');
const L = load(dir), { E, An, db, prov } = L, A = c => E.analyze(c);
const rng = s => { let a = 0; for (const ch of s) a = (a * 31 + ch.charCodeAt(0)) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pickK = (arr, k, r) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
const auc = (pos, neg) => { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return w / (pos.length * neg.length); };
const BASIC = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
(async () => {
  const keys = ['full', 'goldfish', 'table', 'value', 'rank'], per = Object.fromEntries(keys.map(k => [k, []]));
  for (const d of L.decks.filter(d => d.src === 'edhrec-avg' && d.bracket === BR).slice(0, ND)) {
    const { cmds, deck } = deckOf(L, d); if (!cmds.length) continue;
    const CI = [...new Set(cmds.map(c => c.ci).join(''))].join(''), r = rng(d.id), have = new Set(deck.map(e => e.c.n).concat(cmds.map(c => c.n)));
    const removed = pickK(deck.filter(e => !A(e.c).isLand && e.qty === 1).map(e => e.c), K, r);
    const filler = pickK(db.all.filter(c => c.leg === 'legal' && c.rank >= 12000 && c.rank <= 25000 && !A(c).isLand && !have.has(c.n) && [...c.ci].every(x => CI.includes(x))), K, r);
    const rm = new Set(removed.map(c => c.n)), fl = new Set(filler.map(c => c.n));
    const dmg = deck.filter(e => !rm.has(e.c.n)).concat(filler.map(c => ({ c, qty: 1 })));
    const names = dmg.map(e => e.c.n).concat(cmds.map(c => c.n)), combos = await prov.find(names, cmds.map(c => c.n));
    const settings = Object.assign(E.defaults(), { bracket: BR, bl: E.bracketDefaults(BR) });
    const basic = E.lookup(db, CI ? BASIC[CI[0]] : 'Wastes');
    const prep = An.impactPrep(db, dmg, cmds, { settings, combos, impactGames: GAMES });
    const X = An.run(db, dmg, cmds, { settings, combos, games: 500, table: false }), P = X.planner;
    const sc = { full: {}, goldfish: {}, table: {}, value: {}, rank: {} };
    for (const e of dmg) {
      if (A(e.c).isLand) continue;
      const res = An.impactSwaps(prep, [{ cut: e.c, add: basic }], combos), a = res.after, b = prep.base;
      const tw = (a.table || 0) - (b.table || 0);
      sc.full[e.c.n] = res.g; sc.table[e.c.n] = tw; sc.goldfish[e.c.n] = res.g - An.TABLE_W * 100 * tw;
      sc.value[e.c.n] = -P.value(e.c); sc.rank[e.c.n] = e.c.rank || 1e6;
    }
    const line = [d.cmd.join(' + ')];
    for (const k of keys) { const pos = [...fl].filter(n => n in sc[k]).map(n => sc[k][n]), neg = Object.keys(sc[k]).filter(n => !fl.has(n)).map(n => sc[k][n]); const v = auc(pos, neg); per[k].push(v); line.push(k + ' ' + v.toFixed(2)); }
    console.error(line.join(' | '));
  }
  const mean = v => +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(3), se = v => { const m = mean(v); return +Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1) / v.length).toFixed(3); };
  console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, { auc: mean(per[k]), se: se(per[k]) }])), null, 1));
})();
