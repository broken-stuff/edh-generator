#!/usr/bin/env node
/* Downloads bracket-labelled reference decklists for the most-played commanders, for calibrating the power-level and
   bracket estimates against real decks. Two sources, one request every 1.2 s:
    - EDHREC average decks, one per commander per bracket (exhibition, core, upgraded, optimized, cedh = Brackets 1–5),
      with the number of EDHREC decks behind each bracket;
    - Archidekt public decks per commander and bracket (the bracket the deck's owner set), most viewed first.
   Writes data/reference/decks.jsonl.gz: one JSON object per line,
     { src, id, cmd: [names], bracket, n?, views?, cards: [[name, qty], ...] }   (cards exclude the commanders)
   Usage: node tools/ref-decks.js [outDir] [--commanders 60] [--per-bracket 3] */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? +argv[i + 1] : d; };
const out = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data/reference';
const N = opt('commanders', 60), PER = opt('per-bracket', 3);
const UA = 'broken-stuff-edh-generator/1.0 (GitHub Action; https://github.com/broken-stuff/edh-generator)';
const SLUG = ['', 'exhibition', 'core', 'upgraded', 'optimized', 'cedh'];
const wait = ms => new Promise(r => setTimeout(r, ms));
let calls = 0, fails = 0;
async function get(u) {
  for (let a = 0; a < 3; a++) {
    await wait(1200 + a * 4000); calls++;
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (r.ok) return await r.json();
      if (r.status === 404 || r.status === 403) { fails++; return null; }
    } catch (e) { }
  }
  fails++; return null;
}
const isCommanderCat = c => /^commanders?$/i.test(c);

(async () => {
  const year = await get('https://json.edhrec.com/pages/commanders/year.json');
  const views = ((((year || {}).container || {}).json_dict || {}).cardlists || []).flatMap(l => l.cardviews || []);
  const cmdrs = views.map(v => ({ name: v.name, slug: v.sanitized || String(v.url || '').split('/').pop() })).filter(v => v.name && v.slug).slice(0, N);
  if (!cmdrs.length) { console.error('No commander ranking from EDHREC: ' + JSON.stringify(year).slice(0, 1500)); process.exit(1); }
  console.log('Commanders: ' + cmdrs.length + ' (' + cmdrs.slice(0, 5).map(c => c.name).join('; ') + ' …)');
  const rows = [];
  for (const c of cmdrs) {
    let got = 0;
    for (let b = 1; b <= 5; b++) {
      const j = await get('https://json.edhrec.com/pages/average-decks/' + c.slug + '/' + SLUG[b] + '.json');
      const d = j && j.deck; if (!d || !d.cards) continue;
      const cards = Object.values(d.cards).flat().filter(x => Array.isArray(x) && x[0]).map(x => [x[0], x[1] || 1]);
      const cmd = d.commander && d.commander.length ? d.commander : [c.name];
      const n = j.bracket_counts ? j.bracket_counts[b] || 0 : null;
      if (cards.length >= 60) { rows.push({ src: 'edhrec-avg', id: c.slug + '/' + SLUG[b], cmd, bracket: b, n, cards }); got++; }
    }
    for (let b = 1; b <= 5; b++) {
      const q = 'https://archidekt.com/api/decks/v3/?commanderName=' + encodeURIComponent(c.name) + '&edhBracket=' + b + '&orderBy=-viewCount&pageSize=' + Math.max(5, PER * 2);
      const j = await get(q); if (!j || !j.results) continue;
      let k = 0;
      for (const r of j.results) {
        if (k >= PER) break;
        if (r.edhBracket !== b || r.private || r.theorycrafted || r.size < 98 || r.size > 101) continue;
        const d = await get('https://archidekt.com/api/decks/' + r.id + '/'); if (!d || !d.cards) continue;
        const skip = new Set((d.categories || []).filter(x => !x.includedInDeck).map(x => x.name));
        const cmd = [], cards = [];
        for (const e of d.cards) {
          const nm = e.card && e.card.oracleCard && e.card.oracleCard.name; if (!nm) continue;
          const cats = e.categories || [];
          if (cats.length && skip.has(cats[0])) continue;
          if (cats.some(isCommanderCat)) cmd.push(nm); else cards.push([nm, e.quantity || 1]);
        }
        const total = cmd.length + cards.reduce((s, x) => s + x[1], 0);
        if (!cmd.length || total < 98 || total > 101) continue;
        rows.push({ src: 'archidekt', id: String(r.id), cmd, bracket: b, views: r.viewCount, cards }); k++; got++;
      }
    }
    console.log(c.name + ': ' + got + ' decks');
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'decks.jsonl.gz'), zlib.gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n', { level: 9 }));
  const by = (k) => rows.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
  const meta = { generated: new Date().toISOString(), commanders: cmdrs.length, decks: rows.length, bySource: by('src'), byBracket: by('bracket'), requests: calls, failed: fails };
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  console.log(JSON.stringify(meta));
})();
