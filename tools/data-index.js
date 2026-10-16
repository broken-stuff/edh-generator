#!/usr/bin/env node
/* Writes data/index.json: the files in data/ with size and SHA-256, so the page can find the newest card file
   and tell whether its stored copy is current by reading one static file instead of calling the GitHub API.
   Usage: node tools/data-index.js [dataDir]  (run by .github/workflows/data.yml after every push to data/) */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = process.argv[2] || 'data';
const files = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && !d.name.startsWith('.') && d.name !== 'index.json').map(d => {
  const p = path.join(dir, d.name), buf = fs.readFileSync(p);
  return { name: d.name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}).sort((a, b) => (a.name < b.name ? -1 : 1));
let spellbook = null;
try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'spellbook', 'manifest.json'), 'utf8')); spellbook = { manifest: 'spellbook/manifest.json', variants: m.variants, timestamp: m.timestamp }; } catch (e) { }
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ format: 'edhgen-data/1', files, spellbook }, null, 1) + '\n');
console.log('Indexed ' + files.length + ' file(s) in ' + dir + (spellbook ? '; Spellbook ' + spellbook.variants + ' variants' : '') + '.');
