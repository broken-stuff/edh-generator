#!/usr/bin/env node
/* Probe: which deck-data endpoints answer from a GitHub runner, and what their JSON looks like (keys and a sample). */
'use strict';
const UA = 'broken-stuff-edh-generator/1.0 (GitHub Action; https://github.com/broken-stuff/edh-generator)';
const urls = [
  'https://json.edhrec.com/pages/commanders/krenko-mob-boss.json',
  'https://json.edhrec.com/pages/average-decks/krenko-mob-boss.json',
  'https://json.edhrec.com/pages/average-decks/krenko-mob-boss/core.json',
  'https://json.edhrec.com/pages/average-decks/krenko-mob-boss/optimized.json',
  'https://json.edhrec.com/pages/commanders/krenko-mob-boss/core.json',
  'https://json.edhrec.com/pages/decks/krenko-mob-boss.json',
  'https://json.edhrec.com/pages/decks/krenko-mob-boss/optimized.json',
  'https://archidekt.com/api/decks/v3/?commanderName=Krenko%2C%20Mob%20Boss&orderBy=-viewCount&pageSize=5',
  'https://archidekt.com/api/decks/v3/?commanders=Krenko%2C%20Mob%20Boss&pageSize=5',
  'https://api2.moxfield.com/v2/decks/search?q=krenko&fmt=commander&pageSize=5'
];
const shape = (v, d) => { if (d > 2) return typeof v; if (Array.isArray(v)) return '[' + v.length + ': ' + (v.length ? shape(v[0], d + 1) : '') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).slice(0, 25).map(k => k + ':' + shape(v[k], d + 1)).join(', ') + '}'; return typeof v; };
(async () => {
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); const t = await r.text();
      let s = ''; try { s = shape(JSON.parse(t), 0); } catch (e) { s = 'not JSON: ' + t.slice(0, 200).replace(/\s+/g, ' '); }
      console.log('### ' + r.status + ' ' + u + '\n' + s.slice(0, 3000) + '\nSAMPLE ' + t.slice(0, 1500).replace(/\s+/g, ' '));
    } catch (e) { console.log('### ERR ' + u + ' ' + e.message); }
    await new Promise(r => setTimeout(r, 1200));
  }
})();
