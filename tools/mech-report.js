#!/usr/bin/env node
/* Mechanics coverage report: how much of the card pool src/mech.js reads, and how well its links find known combos.
   Prints one line per measure; with --newest N also lists the most common unread ability lines among the N newest cards.
   Usage: node tools/mech-report.js [dataDir] [--newest N]  (run by .github/workflows/data.yml after each data update) */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const E = require('../src/engine.js'), M = require('../src/mech.js');
const args = process.argv.slice(2), dir = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'data';
const ni = args.indexOf('--newest'), newest = ni >= 0 ? +args[ni + 1] || 300 : 0;
const card = fs.readdirSync(dir).filter(f => /^oracle-cards-.*\.jsonl\.gz$/.test(f)).sort().pop();
if (!card) { console.error('no oracle-cards file in ' + dir); process.exit(1); }
const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, card))).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
const db = E.buildDB(raw.map(E.norm).filter(Boolean), {});
const cards = db.all.filter(c => !E.isBasic(c) && c.leg === 'legal' && c.low && c.low.trim());
const pct = x => (x * 100).toFixed(1) + '%', share = l => l.length ? l.filter(c => M.parse(c).parsed).length / l.length : 0;
const top = cards.filter(c => c.rank).sort((a, b) => a.rank - b.rank).slice(0, 2000);
console.log('Mechanics: ' + pct(share(cards)) + ' of ' + cards.length + ' Commander-legal cards with rules text have a parsed ability; ' + pct(share(top)) + ' of the 2,000 most played.');
const sb = path.join(dir, 'spellbook');
if (fs.existsSync(path.join(sb, 'tables.json'))) {
  const tables = JSON.parse(fs.readFileSync(path.join(sb, 'tables.json')));
  let rows = []; for (const f of fs.readdirSync(sb).filter(f => /^variants-\d+\.json$/.test(f)).sort()) { const j = JSON.parse(fs.readFileSync(path.join(sb, f))); rows = rows.concat(j.rows || j); }
  const two = E.spellbookVariants(tables, rows, db).filter(v => v.r === 0 && v.c.length === 2).map(v => v.c.map(n => E.lookup(db, n))).filter(p => p.every(Boolean));
  const hit = ([a, b]) => M.pairW(a, b) >= M.LINK, pool = [...new Set(two.flat())];
  let s = 7, base = 0; const r = () => (s = (s * 16807) % 2147483647) / 2147483647, N = 20000;
  for (let i = 0; i < N; i++) if (hit([pool[Math.floor(r() * pool.length)], pool[Math.floor(r() * pool.length)]])) base++;
  console.log('Mechanics: ' + pct(two.filter(hit).length / two.length) + ' of ' + two.length + ' Spellbook 2-card combos are linked pairs; random pairs of the same cards: ' + pct(base / N) + '.');
}
if (newest) {
  const recent = cards.slice().sort((a, b) => (b.first || '') < (a.first || '') ? -1 : 1).slice(0, newest), miss = new Map();
  for (const c of recent) { const got = new Set(M.parse(c).abil.map(a => a.text)); for (const l of M.split(M.norm(c))) if (!got.has(l) && !/^[a-z ,]+$/.test(l)) { const k = l.replace(/\d+/g, 'N').replace(/\{[^}]+\}/g, '{M}').slice(0, 80); miss.set(k, (miss.get(k) || 0) + 1); } }
  console.log('Mechanics: ' + pct(share(recent)) + ' of the ' + recent.length + ' newest cards parsed. Most common unread lines:');
  for (const [k, n] of [...miss].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log('  ' + n + '  ' + k);
}
