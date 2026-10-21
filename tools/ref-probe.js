#!/usr/bin/env node
/* Probe (temporary): deck-data endpoint shapes from a GitHub runner. Round 2: card-list structure, single-deck endpoints, commander ranking. */
'use strict';
const UA = 'broken-stuff-edh-generator/1.0 (GitHub Action; https://github.com/broken-stuff/edh-generator)';
const wait = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { await wait(1200); const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} console.log('### ' + r.status + ' ' + u + (j ? '' : ' not JSON: ' + t.slice(0, 200).replace(/\s+/g, ' '))); return j; };
const shape = (v, d) => { if (d > 3) return typeof v; if (Array.isArray(v)) return '[' + v.length + ': ' + (v.length ? shape(v[0], d + 1) : '') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).slice(0, 30).map(k => k + ':' + shape(v[k], d + 1)).join(', ') + '}'; return typeof v; };
const show = (label, v, n) => console.log(label + ' ' + JSON.stringify(v).slice(0, n || 1500));
(async () => {
  let j = await get('https://json.edhrec.com/pages/average-decks/krenko-mob-boss/core.json');
  if (j) { show('DECK.cards keys', Object.keys(j.deck.cards)); show('DECK.Creature', j.deck.cards.Creature, 800); show('DECK.commander', j.deck.commander); show('ARCHIDEKT', j.archidekt.slice(0, 5)); show('JSONDICT', Object.keys(j.container.json_dict.cardlists || {})); }
  for (const b of ['exhibition', 'upgraded', 'cedh']) await get('https://json.edhrec.com/pages/average-decks/krenko-mob-boss/' + b + '.json');
  j = await get('https://json.edhrec.com/pages/decks/krenko-mob-boss/core.json');
  let hash = null;
  if (j) { show('TABLE[0..2]', j.table.slice(0, 3)); hash = j.table[0].urlhash; }
  if (hash) { const d = await get('https://json.edhrec.com/pages/deckpreview/' + hash + '.json'); if (d) { console.log(shape(d, 0).slice(0, 3000)); show('DECKPREVIEW', d, 2500); } }
  j = await get('https://json.edhrec.com/pages/commanders/year.json');
  if (j) { console.log(shape(j, 0).slice(0, 2000)); show('YEAR', j, 1500); }
  j = await get('https://archidekt.com/api/decks/3047743/');
  if (j) { console.log(shape(j, 0).slice(0, 2500)); show('ARCH.cards[0]', (j.cards || [])[0], 1500); show('ARCH.bracket', { edhBracket: j.edhBracket, categories: (j.categories || []).map(c => c.name) }); }
  j = await get('https://archidekt.com/api/decks/v3/?commanderName=Krenko%2C%20Mob%20Boss&edhBracket=4&pageSize=5');
  if (j) show('ARCH.filter b4', { count: j.count, brackets: j.results.map(r => r.edhBracket) });
  j = await get('https://api2.moxfield.com/v2/decks/search?commanderCardName=Krenko%2C%20Mob%20Boss&fmt=commander&pageSize=5&sortType=views');
  let pid = null;
  if (j) { show('MOX.search', j.data.map(d => [d.name, d.bracket, d.autoBracket, d.viewCount]), 800); pid = j.data[0] && j.data[0].publicId; }
  if (pid) { const d = await get('https://api2.moxfield.com/v3/decks/all/' + pid); if (d) { console.log(shape(d, 0).slice(0, 2500)); show('MOX.boards.commanders', d.boards && d.boards.commanders, 800); } }
})();
