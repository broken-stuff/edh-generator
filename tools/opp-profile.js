#!/usr/bin/env node
/* Opponent profiles for the table simulation, from the EDHREC average decks in data/reference/ (one per commander and
   bracket): per bracket, the mean number of spot removal spells, counterspells and board wipes in a deck, and the
   quantiles (0, 5%, …, 100%) of the decks' projected goldfish win turn, averaged over decks (q). Prints the OPP table that src/analysis.js holds.
   Usage: node tools/opp-profile.js [dataDir] [--games 1000] */
'use strict';
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data', GAMES = +opt('games', 1000);
const { load, deckOf } = require('./ref-load.js');
const L = load(dir), { E, An, db, prov } = L, A = c => E.analyze(c);
const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
(async () => {
  const by = {};
  for (const d of L.decks.filter(d => d.src === 'edhrec-avg')) {
    const { cmds, deck } = deckOf(L, d); if (!cmds.length) continue;
    const names = deck.map(e => e.c.n).concat(cmds.map(c => c.n)), combos = await prov.find(names, cmds.map(c => c.n));
    const X = An.run(db, deck, cmds, { games: GAMES, combos, table: false });
    const n = f => deck.filter(e => f(e.c)).reduce((s, e) => s + e.qty, 0);
    const ctr = c => !!(A(c).rules.removal && A(c).rules.removal.includes('rm-counter'));
    const b = by[d.bracket] = by[d.bracket] || { removal: [], counter: [], wipes: [], win: [], cdf: [], q: [] };
    b.removal.push(n(c => A(c).roles.removal && !ctr(c))); b.counter.push(n(ctr)); b.wipes.push(n(c => A(c).roles.wipes));
    // the deck's win turn in its own goldfish: the earlier of the damage clock and an assembled combo line, as quantiles
    b.win.push(X.sim.win.median); b.cdf.push(X.sim.win.byT); b.q.push(X.sim.proj);
  }
  const mean = v => +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(1);
  const OPP = {};
  for (const k of Object.keys(by).sort()) { const b = by[k]; OPP[k] = { decks: b.win.length, removal: mean(b.removal), counter: mean(b.counter), wipes: mean(b.wipes), medianWin: q(b.win, 0.5), q: b.q[0].map((_, i) => +(b.q.reduce((s, x) => s + x[i], 0) / b.q.length).toFixed(2)) }; }
  console.log(JSON.stringify(OPP, null, 1));
})();
