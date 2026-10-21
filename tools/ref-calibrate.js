#!/usr/bin/env node
/* Compares the analysis' bracket and power-level estimates with the brackets of the reference decks in
   data/reference/decks.jsonl.gz (see tools/ref-decks.js), and fits power-level cut points between brackets with
   leave-one-commander-out cross-validation.
   Usage: node tools/ref-calibrate.js [dataDir] [--games 1000] [--json out.json] [--limit n] */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data';
const GAMES = +opt('games', 1000), LIMIT = +opt('limit', 1e9), JSON_OUT = opt('json', null);
const E = require('../src/engine.js'), An = require('../src/analysis.js');

const cardFile = fs.readdirSync(dir).filter(f => /^oracle-cards-.*\.jsonl\.gz$/.test(f)).sort().pop();
const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, cardFile))).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
const db = E.buildDB(raw.map(E.norm).filter(Boolean), {});
const sb = path.join(dir, 'spellbook'), man = JSON.parse(fs.readFileSync(path.join(sb, 'manifest.json'), 'utf8'));
const tables = JSON.parse(fs.readFileSync(path.join(sb, 'tables.json'), 'utf8'));
let vrows = [];
for (const f of fs.readdirSync(sb).filter(f => /^variants-\d+\.json$/.test(f)).sort()) { const j = JSON.parse(fs.readFileSync(path.join(sb, f), 'utf8')); vrows = vrows.concat(j.rows || j); }
const prov = E.localComboProvider(E.spellbookVariants(tables, vrows, db), {});
const decks = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'reference', 'decks.jsonl.gz'))).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(0, LIMIT);

const spearman = (a, b) => { const rk = v => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]), r = Array(v.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1; } return r; }; const x = rk(a), y = rk(b), n = a.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const markerB = s => s === '1–2' ? 2 : +s;
// Cut points t1..t4 on a score: bracket = 1 + number of cut points the score reaches. Fitted by coordinate search to
// maximise exact agreement, ties broken by mean absolute error.
function fitCuts(rows, key) {
  const vals = [...new Set(rows.map(r => r[key]))].sort((a, b) => a - b), grid = vals.filter((_, i) => i % Math.max(1, Math.floor(vals.length / 120)) === 0);
  const pred = (c, x) => 1 + c.filter(t => x >= t).length;
  const loss = c => { let ok = 0, ae = 0; for (const r of rows) { const p = pred(c, r[key]); ok += p === r.bracket; ae += Math.abs(p - r.bracket); } return -ok + ae / (rows.length + 1); };
  let c = [1, 2, 3, 4].map(k => q(rows.map(r => r[key]), k / 5)), best = loss(c);
  for (let it = 0; it < 4; it++) for (let k = 0; k < 4; k++) for (const g of grid) { if ((k && g < c[k - 1]) || (k < 3 && g > c[k + 1])) continue; const t = c.slice(); t[k] = g; const l = loss(t); if (l < best) { best = l; c = t; } }
  return { cuts: c, pred: x => pred(c, x) };
}
const confusion = (rows, f) => { const m = [1, 2, 3, 4, 5].map(() => [0, 0, 0, 0, 0]); for (const r of rows) m[r.bracket - 1][f(r) - 1]++; return m; };
const score = (rows, f) => { let ok = 0, w1 = 0, ae = 0; for (const r of rows) { const p = f(r), d = Math.abs(p - r.bracket); ok += !d; w1 += d <= 1; ae += d; } return { n: rows.length, exact: +(ok / rows.length).toFixed(3), within1: +(w1 / rows.length).toFixed(3), mae: +(ae / rows.length).toFixed(2) }; };

(async () => {
  const res = [], t0 = Date.now();
  for (const d of decks) {
    const cmds = d.cmd.map(n => E.lookup(db, n)).filter(Boolean);
    const deck = d.cards.map(([n, qty]) => ({ c: E.lookup(db, n), qty })).filter(e => e.c);
    if (!cmds.length || deck.length < 50) continue;
    const names = deck.map(e => e.c.n).concat(cmds.map(c => c.n));
    const combos = await prov.find(names, cmds.map(c => c.n));
    const X = An.run(db, deck, cmds, { combos, games: GAMES }), P = X.power;
    res.push({ src: d.src, id: d.id, cmd: d.cmd.join(' + '), bracket: d.bracket, n: d.n, size: deck.reduce((s, e) => s + e.qty, 0) + cmds.length, unmatched: d.cards.length - deck.length,
      pl: P.plExact, plRaw: P.plRaw, ceiling: P.ceiling, marker: markerB(X.bracket.estimate), minB: P.minBracket, typical: P.win.typical, gc: X.bracket.counts.gc, twoInf: X.bracket.twoInf, tutor: X.bracket.counts.tutor, fast: X.bracket.counts.fast, xturn: X.bracket.counts.xturn });
    if (res.length % 100 === 0) console.error(res.length + ' decks, ' + Math.round((Date.now() - t0) / 1000) + ' s');
  }
  const out = { decks: res.length, games: GAMES, cards: cardFile, spellbook: man.timestamp, sources: {} };
  for (const src of ['all', ...new Set(res.map(r => r.src))]) {
    const R = src === 'all' ? res : res.filter(r => r.src === src);
    if (R.length < 10) continue;
    const s = { n: R.length, plByBracket: {}, spearman: { pl: +spearman(R.map(r => r.pl), R.map(r => r.bracket)).toFixed(3), minB: +spearman(R.map(r => r.minB), R.map(r => r.bracket)).toFixed(3) } };
    for (let b = 1; b <= 5; b++) { const v = R.filter(r => r.bracket === b).map(r => r.pl); if (v.length) s.plByBracket[b] = { n: v.length, q25: +q(v, 0.25).toFixed(2), median: +q(v, 0.5).toFixed(2), q75: +q(v, 0.75).toFixed(2) }; }
    s.minBracket = Object.assign(score(R, r => r.minB), { confusion: confusion(R, r => r.minB) });
    s.markers = score(R, r => r.marker);
    // Cut points on power level, cross-validated: each commander's decks are predicted from cut points fitted without it.
    const fit = fitCuts(R, 'pl'); s.plCuts = { cuts: fit.cuts.map(x => +x.toFixed(2)), inSample: score(R, r => fit.pred(r.pl)) };
    const byCmd = [...new Set(R.map(r => r.cmd))], cv = new Map();
    for (const c of byCmd) { const f = fitCuts(R.filter(r => r.cmd !== c), 'pl'); for (const r of R) if (r.cmd === c) cv.set(r, f.pred(r.pl)); }
    s.plCuts.crossValidated = Object.assign(score(R, r => cv.get(r)), { confusion: confusion(R, r => cv.get(r)) });
    // Combined rule: the higher of card markers and fitted power-level bracket (card limits are hard floors).
    s.combined = score(R, r => Math.max(r.marker, cv.get(r)));
    out.sources[src] = s;
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ summary: out, rows: res }, null, 1));
  console.log(JSON.stringify(out, null, 1));
})();
