#!/usr/bin/env node
/* Shrinks a Scryfall bulk file (Oracle Cards: https://scryfall.com/docs/api/bulk-data) to the fields the generator
   reads, and writes it as gzipped JSON Lines, one card per line.
   Usage: node tools/scryfall-slim.js <oracle-cards.json | .jsonl | .gz> <out.jsonl.gz>
   Input may be Scryfall's JSON array (one card per line) or JSON Lines, plain or gzip (detected from the bytes).
   Dropped: other formats' legalities, image sizes other than "normal", related parts, artist, flavour, ids of other
   services. Kept fields are exactly those Engine.norm() uses, so the page builds the same card data from either file. */
'use strict';
const fs = require('fs'), zlib = require('zlib'), readline = require('readline');

const TOP = ['object', 'id', 'oracle_id', 'name', 'lang', 'layout', 'released_at', 'mana_cost', 'cmc', 'type_line', 'oracle_text',
  'power', 'toughness', 'loyalty', 'defense', 'color_identity', 'keywords', 'produced_mana', 'game_changer', 'reserved', 'set',
  'set_type', 'border_color', 'security_stamp', 'edhrec_rank'];
const FACE = ['name', 'oracle_id', 'mana_cost', 'type_line', 'oracle_text', 'power', 'toughness', 'loyalty', 'defense'];
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] != null) r[k] = o[k]; return r; };
const img = u => u && u.normal ? { normal: u.normal } : undefined;

function slim(c) {
  const r = pick(c, TOP);
  if (c.scryfall_uri) r.scryfall_uri = String(c.scryfall_uri).replace(/\?utm_source=api$/, '');
  if (c.image_uris) r.image_uris = img(c.image_uris);
  if (c.legalities) r.legalities = { commander: c.legalities.commander };
  if (c.prices) r.prices = { usd: c.prices.usd, eur: c.prices.eur, tix: c.prices.tix };
  if (Array.isArray(c.card_faces)) r.card_faces = c.card_faces.map(f => { const x = pick(f, FACE); if (f.image_uris) x.image_uris = img(f.image_uris); return x; });
  return r;
}

async function main(inp, out) {
  if (!inp || !out) { console.error('Usage: node tools/scryfall-slim.js <in> <out.jsonl.gz>'); process.exit(2); }
  const fd = fs.openSync(inp, 'r'), head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  const raw = fs.createReadStream(inp), src = head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(zlib.createGunzip()) : raw;
  const gz = zlib.createGzip({ level: 9 }), dst = fs.createWriteStream(out); gz.pipe(dst);
  let n = 0, bad = 0, bytesIn = 0;
  for await (const line of readline.createInterface({ input: src, crlfDelay: Infinity })) {
    bytesIn += line.length + 1;
    let t = line.trim(); if (t.endsWith(',')) t = t.slice(0, -1);
    if (t[0] !== '{') continue;
    let c; try { c = JSON.parse(t); } catch (e) { bad++; continue; }
    if (c.object !== 'card') continue;
    if (!gz.write(JSON.stringify(slim(c)) + '\n')) await new Promise(r => gz.once('drain', r));
    n++;
  }
  gz.end(); await new Promise(r => dst.on('close', r));
  if (n < 1000) { console.error('Only ' + n + ' cards found; not a Scryfall bulk file?'); fs.unlinkSync(out); process.exit(1); }
  console.log(JSON.stringify({ cards: n, unparsed: bad, inBytes: bytesIn, outBytes: fs.statSync(out).size }));
}
if (require.main === module) main(process.argv[2], process.argv[3]).catch(e => { console.error(e); process.exit(1); });
module.exports = { slim };
