#!/usr/bin/env node
/* Fits each opponent profile's shift (turns added to the opponents' win turn) so that the table is fair: an EDHREC average
   deck of a bracket, against three opponents of the same bracket, wins 1 game in 4 (mean over that bracket's decks).
   The shift stands for what the profiles leave out: opponents' answers to each other, and to us beyond the modelled ones.
   Usage: node tools/opp-shift.js [dataDir] [--decks 20] [--games 1000] */
'use strict';
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data', ND = +opt('decks', 20), GAMES = +opt('games', 1000);
const { load, deckOf } = require('./ref-load.js');
const L = load(dir), { An, db, prov } = L;
(async () => {
  const out = {};
  for (let b = 1; b <= 5; b++) {
    const ds = [];
    for (const d of L.decks.filter(d => d.src === 'edhrec-avg' && d.bracket === b).slice(0, ND)) { const x = deckOf(L, d); if (!x.cmds.length) continue; const names = x.deck.map(e => e.c.n).concat(x.cmds.map(c => c.n)); ds.push(Object.assign(x, { combos: await prov.find(names, x.cmds.map(c => c.n)) })); }
    const win = shift => { const prof = Object.assign({}, An.OPP[b], { shift }); return ds.reduce((s, x) => s + An.run(db, x.deck, x.cmds, { games: GAMES, combos: x.combos, settings: { bracket: b }, oppProfile: prof }).sim.table.win, 0) / ds.length; };
    let lo = -6, hi = 2; // win rate falls as the shift falls (faster opponents)
    for (let it = 0; it < 7; it++) { const mid = (lo + hi) / 2; if (win(mid) > 0.25) hi = mid; else lo = mid; }
    const sh = +((lo + hi) / 2).toFixed(2); out[b] = { shift: sh, win: +win(sh).toFixed(3), decks: ds.length };
    console.error('B' + b, JSON.stringify(out[b]));
  }
  console.log(JSON.stringify(out));
})();
