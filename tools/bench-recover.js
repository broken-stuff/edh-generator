#!/usr/bin/env node
/* Recovery benchmark for deep search. For each EDHREC average deck at a bracket (default 4, "optimized"), K nonland cards
   are swapped for filler: random Commander-legal nonland cards of the commander's identity with EDHREC rank 12,000–25,000
   (seeded, so every run uses the same damaged lists). Deep search then runs on the damaged list at that bracket.
     filler cut    share of the K filler cards that the package cuts (did it find the damage?)
     cut precision share of the package's cuts that are filler
     recovered     share of the K removed cards that the package adds back (exact card)
     in candidates share of the K removed cards that were among the screened candidates (the upper bound for recovered)
     gain          package gain on the search's own objective
   Usage: node tools/bench-recover.js [dataDir] [--bracket 4] [--k 10] [--mode standard|thorough] [--opts '{json}'] [--decks 60]
          [--shard i/n] [--json out.json]
   Shards run the same deck list split n ways, for parallel processes; merge with --merge a.json b.json … */
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
function summary(rows, meta) {
  const m = k => +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(3);
  return Object.assign({}, meta, { decks: rows.length, fillerCut: m('fillerCut'), cutPrecision: m('cutPrecision'), recovered: m('recovered'), evals: m('evals'), gainMean: m('gain'), inCandidates: m('inCandidates'), swaps: m('swaps'), gain: { median: q(rows.map(r => r.gain), 0.5), q25: q(rows.map(r => r.gain), 0.25), q75: q(rows.map(r => r.gain), 0.75) }, cpuS: m('cpuS') });
}
if (argv[0] === '--merge') {
  const parts = argv.slice(1).map(f => JSON.parse(fs.readFileSync(f, 'utf8'))), rows = [].concat(...parts.map(p => p.rows));
  console.log(JSON.stringify(summary(rows, parts[0].meta), null, 1)); process.exit(0);
}
const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data';
const BR = +opt('bracket', 4), K = +opt('k', 10), MODE = opt('mode', 'standard'), ND = +opt('decks', 60), JSON_OUT = opt('json', null);
const [si, sn] = opt('shard', '0/1').split('/').map(Number);
const { load, deckOf } = require('./ref-load.js');
const D = require('../src/deep.js');
const L = load(dir), { E, An, db, prov } = L;
// mulberry32, seeded from the deck id
const rng = s => { let a = 0; for (const ch of s) a = (a * 31 + ch.charCodeAt(0)) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pickK = (arr, k, r) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, k); };
const isLand = c => E.analyze(c).isLand;
const decks = L.decks.filter(d => d.src === 'edhrec-avg' && d.bracket === BR).slice(0, ND).filter((_, i) => i % sn === si);

(async () => {
  const rows = [], o = Object.assign({}, MODE === 'thorough' ? D.WIDE : D.DEF, JSON.parse(opt('opts', '{}')));
  for (const d of decks) {
    const { cmds, deck } = deckOf(L, d); if (!cmds.length) continue;
    const CI = [...new Set(cmds.map(c => c.ci).join(''))].join(''), r = rng(d.id), have = new Set(deck.map(e => e.c.n).concat(cmds.map(c => c.n)));
    const removed = pickK(deck.filter(e => !isLand(e.c) && e.qty === 1).map(e => e.c), K, r);
    const fillPool = db.all.filter(c => c.leg === 'legal' && c.rank >= 12000 && c.rank <= 25000 && !isLand(c) && !have.has(c.n) && [...c.ci].every(x => CI.includes(x)));
    const filler = pickK(fillPool, K, r);
    const rm = new Set(removed.map(c => c.n)), fl = new Set(filler.map(c => c.n));
    const dmg = deck.filter(e => !rm.has(e.c.n)).map(e => ({ c: e.c, qty: e.qty, locked: false })).concat(filler.map(c => ({ c, qty: 1, locked: false })));
    const names = dmg.map(e => e.c.n).concat(cmds.map(c => c.n)), combos = await prov.find(names, cmds.map(c => c.n));
    const S = Object.assign(E.defaults(), { bracket: BR, bl: E.bracketDefaults(BR) });
    const X = An.run(db, dmg, cmds, { settings: S, games: 5000, combos });
    const ctx = { deck: dmg, cmds, combos, prov, keep: new Set(cmds.map(c => c.n)), settings: S };
    const C = D.candidates(X, ctx, o), cand = new Set(C.adds.concat(C.lands).map(c => c.n));
    const t0 = process.cpuUsage();
    const res = await D.search(X, ctx, init => D.localExec(init), null, o);
    const cpu = process.cpuUsage(t0), pkg = res.pkg || [];
    const cutsF = pkg.filter(p => fl.has(p.cut.n)).length, addsR = pkg.filter(p => rm.has(p.add.n)).length;
    const row = { id: d.id, cmd: d.cmd.join(' + '), removed: [...rm], filler: [...fl], cuts: pkg.map(p => p.cut.n), adds: pkg.map(p => p.add.n), swaps: pkg.length,
      fillerCut: cutsF / K, cutPrecision: pkg.length ? cutsF / pkg.length : 0, recovered: addsR / K, inCandidates: removed.filter(c => cand.has(c.n)).length / K, inPool: removed.filter(c => X.planner.pool.includes(c)).length / K,
      missing: removed.filter(c => !cand.has(c.n)).map(c => c.n + (X.planner.pool.includes(c) ? '' : ' (not in pool)')),
      gain: pkg.length ? +pkg[pkg.length - 1].total.toFixed(2) : 0, evals: res.stats.evals, cpuS: +((cpu.user + cpu.system) / 1e6).toFixed(1) };
    rows.push(row);
    console.error([row.cmd, 'filler cut ' + cutsF + '/' + K, 'recovered ' + addsR + '/' + K, 'in cand ' + Math.round(row.inCandidates * K), 'in pool ' + Math.round(row.inPool * K), 'swaps ' + pkg.length, 'gain ' + row.gain, 'evals ' + row.evals, row.cpuS + ' s'].join(' | '));
  }
  const meta = { bracket: BR, k: K, mode: MODE, opts: opt('opts', null), cards: L.cardFile, spellbook: L.spellbook };
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ meta, rows }, null, 1));
  console.log(JSON.stringify(summary(rows, meta), null, 1));
})();
