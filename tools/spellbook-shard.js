#!/usr/bin/env node
/* Converts Commander Spellbook's variants.json (https://json.commanderspellbook.com/variants.json) into compact
   files the site can load without calling any API:
     data/spellbook/manifest.json        source, timestamp, counts, shard list
     data/spellbook/tables.json          card, feature and template name tables
     data/spellbook/variants-NNN.json    rows that reference the tables by index
   Usage: node tools/spellbook-shard.js <variants.json | variants.json.gz> [outDir] [rowsPerShard]
   The input is streamed (the full file is several hundred MB), and gzip is detected from the file's bytes,
   not its name, because the published .gz is served with Content-Encoding: gzip and often arrives already unpacked.

   Row layout (one array per variant):
     [id, cards, features, templates, identity, manaValueNeeded, bracketTag, popularity, flags]
     cards      card-table indices; a negative index -(i+1) marks a card that must be the commander
     features   feature-table indices (what the combo produces)
     templates  template-table indices (non-card requirements such as "a sacrifice outlet")
     flags      bit 1 = status "E" (example variant) */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const FORMAT = 'edhgen-spellbook/1';

function openInput(file) {
  const fd = fs.openSync(file, 'r'), head = Buffer.alloc(2); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
  const raw = fs.createReadStream(file);
  return head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(zlib.createGunzip()) : raw;
}

/* Streams the top-level document: reports "timestamp" and "version", and every object inside the "variants" array. */
function streamVariants(stream, onVariant, onMeta) {
  return new Promise((resolve, reject) => {
    let state = 'seek', pending = '', depth = 0, inStr = false, esc = false, buf = [], meta = {};
    const metaRe = /"(timestamp|version)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      let i = 0;
      if (state === 'seek') {
        pending += chunk;
        let m; metaRe.lastIndex = 0; while ((m = metaRe.exec(pending))) meta[m[1]] = JSON.parse(m[2]);
        const k = pending.search(/"variants"\s*:\s*\[/);
        if (k < 0) { if (pending.length > 1e6) pending = pending.slice(-1000); return; }
        onMeta(meta);
        chunk = pending.slice(pending.indexOf('[', k) + 1); pending = ''; state = 'array';
      }
      if (state !== 'array') return;
      let start = depth > 0 ? 0 : -1;
      for (i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') { if (depth === 0) start = i; depth++; }
        else if (ch === '}') {
          depth--;
          if (depth === 0) { buf.push(chunk.slice(start, i + 1)); onVariant(JSON.parse(buf.join(''))); buf = []; start = -1; }
        } else if (ch === ']' && depth === 0) { state = 'done'; stream.destroy(); resolve(meta); return; }
      }
      if (depth > 0) buf.push(chunk.slice(start));
    });
    stream.on('end', () => state === 'done' ? resolve(meta) : reject(new Error(state === 'seek' ? 'No "variants" array found: is this variants.json from Commander Spellbook?' : 'File ended inside the variants array (truncated download?)')));
    stream.on('close', () => { if (state === 'done') resolve(meta); });
    stream.on('error', reject);
  });
}

async function main() {
  const [input, outDir = 'data/spellbook', perShardArg] = process.argv.slice(2);
  if (!input) { console.error('Usage: node tools/spellbook-shard.js <variants.json[.gz]> [outDir] [rowsPerShard]'); process.exit(2); }
  const perShard = +perShardArg || 20000;
  const tables = { cards: [], features: [], templates: [] }, ix = { cards: new Map(), features: new Map(), templates: new Map() };
  const idx = (t, name) => { let i = ix[t].get(name); if (i == null) { i = tables[t].length; tables[t].push(name); ix[t].set(name, i); } return i; };
  const rows = []; let read = 0, skipped = { status: 0, legality: 0, noCards: 0 };
  const meta = await streamVariants(openInput(input), v => {
    read++;
    if (v.status && v.status !== 'OK' && v.status !== 'E') { skipped.status++; return; }
    if (v.legalities && v.legalities.commander === false) { skipped.legality++; return; }
    const cards = (v.uses || []).map(u => u && u.card && u.card.name ? (u.mustBeCommander ? -(idx('cards', u.card.name) + 1) : idx('cards', u.card.name)) : null).filter(x => x != null);
    if (!cards.length) { skipped.noCards++; return; }
    const feats = (v.produces || []).map(p => p && p.feature && p.feature.name).filter(Boolean).map(n => idx('features', n));
    const tmpl = (v.requires || []).map(r => r && r.template && r.template.name).filter(Boolean).map(n => idx('templates', n));
    rows.push([String(v.id), cards, feats, tmpl, v.identity || '', typeof v.manaValueNeeded === 'number' ? v.manaValueNeeded : null, v.bracketTag || '', typeof v.popularity === 'number' ? v.popularity : null, v.status === 'E' ? 1 : 0]);
    if (read % 20000 === 0) console.error('  read ' + read + ' variants');
  }, () => {});
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // stable output: unchanged data gives identical files
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/^variants-\d+\.json$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  const shards = [];
  for (let s = 0; s * perShard < rows.length; s++) {
    const file = 'variants-' + String(s).padStart(3, '0') + '.json', body = JSON.stringify({ format: FORMAT, rows: rows.slice(s * perShard, (s + 1) * perShard) });
    fs.writeFileSync(path.join(outDir, file), body); shards.push({ file, count: Math.min(perShard, rows.length - s * perShard), bytes: Buffer.byteLength(body) });
  }
  const tablesBody = JSON.stringify(Object.assign({ format: FORMAT }, tables));
  fs.writeFileSync(path.join(outDir, 'tables.json'), tablesBody);
  const manifest = { format: FORMAT, source: 'https://json.commanderspellbook.com/variants.json', timestamp: meta.timestamp || null, version: meta.version || null,
    variants: rows.length, read, skipped, cards: tables.cards.length, features: tables.features.length, templates: tables.templates.length,
    tables: { file: 'tables.json', bytes: Buffer.byteLength(tablesBody) }, shards };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log('Wrote ' + rows.length + ' variants (' + read + ' read; skipped ' + JSON.stringify(skipped) + ') in ' + shards.length + ' shards to ' + outDir +
    '; largest shard ' + Math.max(...shards.map(s => s.bytes)).toLocaleString() + ' bytes; tables ' + manifest.tables.bytes.toLocaleString() + ' bytes.');
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
