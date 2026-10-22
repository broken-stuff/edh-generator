/* Shared loader for the Node tools that run the analysis on real card data: card database, Commander Spellbook combo
   provider and the reference decks in data/reference/ (see tools/ref-decks.js). */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const E = require('../src/engine.js'), An = require('../src/analysis.js');
function load(dir) {
  const cardFile = fs.readdirSync(dir).filter(f => /^oracle-cards-.*\.jsonl\.gz$/.test(f)).sort().pop();
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, cardFile))).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const db = E.buildDB(raw.map(E.norm).filter(Boolean), {});
  const sb = path.join(dir, 'spellbook'), manifest = JSON.parse(fs.readFileSync(path.join(sb, 'manifest.json'), 'utf8'));
  const tables = JSON.parse(fs.readFileSync(path.join(sb, 'tables.json'), 'utf8'));
  let rows = [];
  for (const f of fs.readdirSync(sb).filter(f => /^variants-\d+\.json$/.test(f)).sort()) { const j = JSON.parse(fs.readFileSync(path.join(sb, f), 'utf8')); rows = rows.concat(j.rows || j); }
  const prov = E.localComboProvider(E.spellbookVariants(tables, rows, db), {});
  const refFile = path.join(dir, 'reference', 'decks.jsonl.gz');
  const decks = fs.existsSync(refFile) ? zlib.gunzipSync(fs.readFileSync(refFile)).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { E, An, db, prov, decks, cardFile, spellbook: manifest.timestamp };
}
// A reference deck as analysis input: commanders and { c, qty } entries; cards the database does not know are dropped.
function deckOf(L, d) {
  const cmds = d.cmd.map(n => L.E.lookup(L.db, n)).filter(Boolean);
  const deck = d.cards.map(([n, qty]) => ({ c: L.E.lookup(L.db, n), qty })).filter(e => e.c);
  return { cmds, deck };
}
module.exports = { load, deckOf };
