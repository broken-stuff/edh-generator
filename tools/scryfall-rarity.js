#!/usr/bin/env node
/* Writes data/rarity.json: the printed rarities Pauper Commander (PDH) legality rests on, from Scryfall's Default Cards
   bulk file (every printing). The Oracle Cards file the page loads carries one printing per card, so it cannot say
   whether a card was ever printed at common.
   PDH rules (pdhhomebase.com/rules): the 99 must be commons; the commander must be an uncommon creature, Vehicle or
   Spacecraft. "If a card has been printed at a specific rarity, it is classified under that rarity. This classification
   is based on paper and MTGO releases, excluding Arena." So only printings whose games include paper or mtgo count.
   Output: { common: [names with a common printing], uncommon: [creature, Vehicle or Spacecraft names with an uncommon
   printing], banned: [names Scryfall marks banned in paupercommander] }, Oracle names, sorted.
   Usage: node tools/scryfall-rarity.js <default-cards.json | .jsonl | .gz> <out.json> */
'use strict';
const fs = require('fs'), zlib = require('zlib'), readline = require('readline');

const SKIP_SETS = new Set(['memorabilia', 'token', 'minigame']); // gold-bordered, tokens, helper cards: not real printings
const CMD_TYPES = /\b(?:Creature|Vehicle|Spacecraft)\b/;

async function main(inp, out) {
  if (!inp || !out) { console.error('Usage: node tools/scryfall-rarity.js <in> <out.json>'); process.exit(2); }
  const fd = fs.openSync(inp, 'r'), head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  const raw = fs.createReadStream(inp), src = head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(zlib.createGunzip()) : raw;
  const common = new Set(), uncommon = new Set(), banned = new Set(); let n = 0, counted = 0;
  for await (const line of readline.createInterface({ input: src, crlfDelay: Infinity })) {
    let t = line.trim(); if (t.endsWith(',')) t = t.slice(0, -1);
    if (t[0] !== '{') continue;
    let c; try { c = JSON.parse(t); } catch (e) { continue; }
    if (c.object !== 'card' || !c.name) continue;
    n++;
    if (c.legalities && c.legalities.paupercommander === 'banned') banned.add(c.name);
    const games = Array.isArray(c.games) ? c.games : [];
    if (!games.includes('paper') && !games.includes('mtgo')) continue;
    if (SKIP_SETS.has(c.set_type) || c.oversized) continue;
    counted++;
    const front = String(c.type_line || (Array.isArray(c.card_faces) && c.card_faces[0] && c.card_faces[0].type_line) || '').split(' // ')[0];
    if (c.rarity === 'common') common.add(c.name);
    else if (c.rarity === 'uncommon' && CMD_TYPES.test(front)) uncommon.add(c.name);
  }
  if (n < 1000) { console.error('Only ' + n + ' cards found; not a Scryfall bulk file?'); process.exit(1); }
  const sort = s => [...s].sort();
  fs.writeFileSync(out, JSON.stringify({ format: 'edhgen-rarity/1', source: 'Scryfall Default Cards (paper and MTGO printings)', common: sort(common), uncommon: sort(uncommon), banned: sort(banned) }) + '\n');
  console.log(JSON.stringify({ printings: n, counted, common: common.size, uncommon: uncommon.size, banned: banned.size }));
}
if (require.main === module) main(process.argv[2], process.argv[3]).catch(e => { console.error(e); process.exit(1); });
