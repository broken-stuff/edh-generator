#!/usr/bin/env node
/* Fits the card-quality model in src/plan.js (Plan.QF features, no popularity field among them).
   Data: every nonland card of each reference deck in data/reference/ (positive) against as many random Commander-legal
   nonland cards in the deck's colour identity that the deck does not play (negative). Logistic regression by gradient
   descent; commanders are split 80/20 (by name hash) and the held-out AUC is printed beside the AUC of EDHREC rank alone
   and of Engine.cardPower without its rank term.
   Usage: node tools/quality-fit.js [dataDir]   → prints the weight array to paste into QW in src/plan.js */
'use strict';
const { load, deckOf } = require('./ref-load.js');
const P = require('../src/plan.js');
const L = load(process.argv[2] || 'data'), { E, db } = L;
let seed = 99; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const h = s => { let a = 7; for (const ch of s) a = (a * 31 + ch.charCodeAt(0)) >>> 0; return a; };
const nonland = db.all.filter(c => c.leg === 'legal' && !E.isBasic(c) && !E.analyze(c).isLand);
const byCI = new Map();
const poolOf = ci => { if (!byCI.has(ci)) byCI.set(ci, nonland.filter(c => [...c.ci].every(x => ci.includes(x)))); return byCI.get(ci); };
const rows = [];
for (const d of L.decks) {
  const { cmds, deck } = deckOf(L, d); if (!cmds.length) continue;
  const ci = [...new Set(cmds.map(c => c.ci).join(''))].join(''), have = new Set(deck.map(e => e.c.n).concat(cmds.map(c => c.n))), test = h(d.cmd.join('+')) % 5 === 0;
  const pos = deck.map(e => e.c).filter(c => !E.analyze(c).isLand && !E.isBasic(c)), pool = poolOf(ci);
  for (const c of pos) rows.push({ c, y: 1, test });
  for (let i = 0, n = 0; n < pos.length && i < pos.length * 20; i++) { const c = pool[Math.floor(rnd() * pool.length)]; if (have.has(c.n)) continue; rows.push({ c, y: 0, test }); n++; }
}
const X = rows.map(r => P.features(r.c)), K = X[0].length, tr = rows.map((r, i) => i).filter(i => !rows[i].test), te = rows.map((r, i) => i).filter(i => rows[i].test);
const w = new Float64Array(K + 1), lr = 1, l2 = 1e-4;
for (let ep = 0; ep < 1500; ep++) {
  const g = new Float64Array(K + 1);
  for (const i of tr) { let z = w[K]; for (let k = 0; k < K; k++) z += w[k] * X[i][k]; const e = 1 / (1 + Math.exp(-z)) - rows[i].y; for (let k = 0; k < K; k++) g[k] += e * X[i][k]; g[K] += e; }
  for (let k = 0; k <= K; k++) w[k] -= lr * (g[k] / tr.length + (k < K ? l2 * w[k] : 0));
}
const auc = (idx, f) => { const s = idx.map(i => [f(i), rows[i].y]).sort((a, b) => a[0] - b[0]); let r = 0, np = 0; s.forEach(([, y], j) => { if (y) { r += j + 1; np++; } }); const nn = s.length - np; return (r - np * (np + 1) / 2) / (np * nn); };
const model = i => { let z = w[K]; for (let k = 0; k < K; k++) z += w[k] * X[i][k]; return z; };
const pop = i => rows[i].c.rank ? -Math.log(rows[i].c.rank) : -12;
const cp = i => { const c = rows[i].c, v = E.cardPower(c), p = c.rank ? Math.max(0, 1 - Math.log10(c.rank) / Math.log10(40000)) : 0; return v - 0.25 * p; };
console.error('rows ' + rows.length + ' (train ' + tr.length + ', held out ' + te.length + ')');
console.error('held-out AUC: quality model ' + auc(te, model).toFixed(3) + ', cardPower without rank ' + auc(te, cp).toFixed(3) + ', EDHREC rank alone ' + auc(te, pop).toFixed(3));
console.error(P.QF.map((f, k) => f[0] + ' ' + w[k].toFixed(2)).join(', ') + ', intercept ' + w[K].toFixed(2));
console.log('[' + [...w].map(x => +x.toFixed(3)).join(', ') + ']');
