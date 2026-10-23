#!/usr/bin/env node
/* Role counts across the reference decks in data/reference/decks.jsonl.gz (see tools/ref-decks.js): 25th percentile,
   median and 75th percentile of each Analysis.roleCounts category, by Commander Bracket and overall. Prints the
   ROLE_RANGES table that src/analysis.js embeds for the Deck › Counts view. Counterspells are taken over decks
   with blue in their colour identity only (nU), since other colours have almost none.
   Usage: node tools/ref-roles.js [dataDir] [--src archidekt|edhrec-avg|all] [--min 95] */
'use strict';
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data';
const SRC = opt('src', 'archidekt'), MIN = +opt('min', 95);
const { load, deckOf } = require('./ref-load.js');
const L = load(dir), An = L.An;
const q = (v, p) => { const s = [...v].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const by = { 0: [] };
for (const d of L.decks) {
  if (SRC !== 'all' && d.src !== SRC) continue;
  const { cmds, deck } = deckOf(L, d);
  if (!cmds.length || deck.reduce((s, e) => s + e.qty, 0) + cmds.length < MIN) continue;
  const rc = An.roleCounts(deck), row = Object.fromEntries(Object.keys(rc).map(k => [k, rc[k].n]));
  row.blue = cmds.some(c => c.ci.includes('U'));
  by[0].push(row); (by[d.bracket] = by[d.bracket] || []).push(row);
}
const out = {};
for (const b of Object.keys(by).sort()) {
  const rows = by[b]; out[b] = { n: rows.length, nU: rows.filter(r => r.blue).length };
  for (const [k] of An.COUNT_CATS) { const v = rows.filter(r => k !== 'counters' || r.blue).map(r => r[k]); out[b][k] = [q(v, 0.25), q(v, 0.5), q(v, 0.75)].map(x => Math.round(x * 2) / 2); }
}
console.log('  const ROLE_RANGES = {');
const keys = Object.keys(out);
keys.forEach((b, i) => console.log('    ' + b + ': { n: ' + out[b].n + ', nU: ' + out[b].nU + ', ' + An.COUNT_CATS.map(([k]) => k + ': [' + out[b][k].join(', ') + ']').join(', ') + ' }' + (i < keys.length - 1 ? ',' : '')));
console.log('  };');
