#!/usr/bin/env node
/* Writes data/aliases.json: alternate printed names that map to a card's Oracle name, from Scryfall's Default Cards
   bulk file (every printing). These are names the Oracle Cards file does not carry, so a pasted list that uses them
   would otherwise not match: Universes Beyond flavour names (Secret Lair "Rick, Steadfast Leader" is the Oracle card
   "Greymond, Avacyn's Stalwart"; Godzilla series names) and their per-face forms.
   Usage: node tools/scryfall-aliases.js <default-cards.json | .jsonl | .gz> <out.json> */
'use strict';
const fs = require('fs'), zlib = require('zlib'), readline = require('readline');

async function main(inp, out) {
  if (!inp || !out) { console.error('Usage: node tools/scryfall-aliases.js <in> <out.json>'); process.exit(2); }
  const fd = fs.openSync(inp, 'r'), head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  const raw = fs.createReadStream(inp), src = head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(zlib.createGunzip()) : raw;
  const map = new Map(), oracle = new Set(); let n = 0;
  for await (const line of readline.createInterface({ input: src, crlfDelay: Infinity })) {
    let t = line.trim(); if (t.endsWith(',')) t = t.slice(0, -1);
    if (t[0] !== '{') continue;
    let c; try { c = JSON.parse(t); } catch (e) { continue; }
    if (c.object !== 'card' || !c.name) continue;
    n++; oracle.add(c.name);
    if (c.lang && c.lang !== 'en') continue;
    const names = [c.flavor_name].concat(Array.isArray(c.card_faces) ? c.card_faces.map(f => f.flavor_name) : []);
    for (const a of names) if (a && a !== c.name && !map.has(a)) map.set(a, c.name);
  }
  if (n < 1000) { console.error('Only ' + n + ' cards found; not a Scryfall bulk file?'); process.exit(1); }
  const names = [...map].filter(([a]) => !oracle.has(a)).sort((x, y) => (x[0] < y[0] ? -1 : 1));
  fs.writeFileSync(out, JSON.stringify({ format: 'edhgen-aliases/1', source: 'Scryfall Default Cards', count: names.length, names }) + '\n');
  console.log(JSON.stringify({ printings: n, aliases: names.length }));
}
if (require.main === module) main(process.argv[2], process.argv[3]).catch(e => { console.error(e); process.exit(1); });
