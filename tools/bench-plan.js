#!/usr/bin/env node
/* Plan benchmark: measures deck building on what popularity cannot explain. For each commander with an EDHREC average deck
   at the bracket (60 in data/reference/), it generates a deck in the standard mode and in the mechanics-only mode, then reports:
     plan        nonland cards that meet the commander's plan profile (src/plan.js), against the profile's quota
     niche       of the human deck's nonland cards with EDHREC rank above 5,000 (picks made for this commander, not staples),
                 the share the generated deck also plays; human = the EDHREC average deck plus the Archidekt decks
     overlap     share of the EDHREC average deck's nonland cards in the generated deck
     link        share of nonland cards linked to the commander in the mechanics graph (Mech.pairW ≥ Mech.LINK)
     mvErr       |average MV − the EDHREC average deck's average MV|
     power, win  analysis power level and typical win turn (1,500 games), the same for the human deck; the analysis runs
                 with mode 'mech' for every deck, so the power level's card-quality term carries no EDHREC rank
     medRank     median EDHREC rank of the nonland cards (descriptive only)
   Usage: node tools/bench-plan.js [dataDir] [--bracket 3] [--decks 60] [--modes standard,mech] [--games 1500]
          [--shard i/n] [--json out.json] [--set '{settings for mech}'];  merge shards with --merge a.json b.json … */
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null, med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
function summary(rows) {
  const modes = [...new Set(rows.flatMap(r => Object.keys(r.m)))], out = {};
  const keys = ['plan', 'planQuota', 'niche', 'overlap', 'link', 'mvErr', 'power', 'win', 'medRank'];
  for (const m of modes) { out[m] = {}; for (const k of keys) { const v = rows.map(r => r.m[m] && r.m[m][k]).filter(x => x != null); out[m][k] = +(k === 'medRank' ? med(v) : mean(v)).toFixed(3); } }
  out.human = { power: +mean(rows.map(r => r.human.power)).toFixed(3), win: +mean(rows.map(r => r.human.win)).toFixed(3), link: +mean(rows.map(r => r.human.link)).toFixed(3), plan: +mean(rows.map(r => r.human.plan)).toFixed(3) };
  return { decks: rows.length, modes: out };
}
if (argv[0] === '--merge') { const rows = [].concat(...argv.slice(1).map(f => JSON.parse(fs.readFileSync(f, 'utf8')).rows)); console.log(JSON.stringify(summary(rows), null, 1)); process.exit(0); }
const dir = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'data';
const BR = +opt('bracket', 3), ND = +opt('decks', 60), MODES = opt('modes', 'standard,mech').split(','), GAMES = +opt('games', 1500), JSON_OUT = opt('json', null);
const SET = JSON.parse(opt('set', '{}')); // extra settings for the mech mode, e.g. '{"weights":{"plan":2}}'
const [si, sn] = opt('shard', '0/1').split('/').map(Number);
const { load, deckOf } = require('./ref-load.js');
const L = load(dir), { E, An, db, prov } = L, M = require('../src/mech.js'), PL = require('../src/plan.js');
const avg = L.decks.filter(d => d.src === 'edhrec-avg' && d.bracket === BR).slice(0, ND).filter((_, i) => i % sn === si);
const nl = c => !E.analyze(c).isLand && !E.isBasic(c);
(async () => {
  const rows = [];
  for (const d of avg) {
    const { cmds, deck } = deckOf(L, d); if (!cmds.length) continue;
    const key = d.cmd.join('+'), human = deck.map(e => e.c).filter(nl);
    const arch = L.decks.filter(x => x.src === 'archidekt' && x.cmd.join('+') === key).flatMap(x => deckOf(L, x).deck.map(e => e.c)).filter(nl);
    const niche = new Set(human.concat(arch).filter(c => c.rank != null && c.rank > 5000).map(c => c.n));
    const CI = [...new Set(cmds.map(c => c.ci).join(''))].join('');
    const plan = PL.profile(db, cmds, db.all.filter(c => c.leg === 'legal' && !E.isBasic(c) && [...c.ci].every(x => CI.includes(x))));
    const humanN = new Set(human.map(c => c.n));
    const stats = async list => {
      const cards = list.map(e => e.c), non = cards.filter(nl);
      const mv = non.reduce((s, c) => s + c.cmc, 0) / non.length;
      const combos = await prov.find(cards.map(c => c.n).concat(cmds.map(c => c.n)), cmds.map(c => c.n));
      const X = An.run(db, list, cmds, { settings: Object.assign(E.defaults(), { bracket: BR, bl: E.bracketDefaults(BR), mode: 'mech' }), games: GAMES, combos });
      return { plan: non.filter(plan.isPlan).length, link: non.filter(c => cmds.some(k => M.pairW(c, k) >= M.LINK)).length / non.length, mv, power: X.power.pl, win: X.power.win ? X.power.win.typical : null, medRank: med(non.map(c => c.rank || 99999)), non };
    };
    const H = await stats(deck);
    const row = { id: d.id, cmd: key, quota: plan.quota, nicheN: niche.size, human: { power: H.power, win: H.win, link: H.link, plan: H.plan, mv: H.mv }, m: {} };
    for (const mode of MODES) {
      const R = await E.generate(db, Object.assign({ commanders: cmds.map(c => c.n), bracket: BR, bl: E.bracketDefaults(BR), mode: mode === 'mech' ? 'mech' : '' }, mode === 'mech' ? SET : {}), { combos: prov });
      if (R.errors.length) { row.m[mode] = null; continue; }
      const G = await stats(R.deck);
      row.m[mode] = { plan: G.plan, planQuota: plan.quota ? Math.min(1, G.plan / plan.quota) : null, niche: niche.size ? G.non.filter(c => niche.has(c.n)).length / niche.size : null,
        overlap: G.non.filter(c => humanN.has(c.n)).length / humanN.size, link: G.link, mvErr: Math.abs(G.mv - H.mv), power: G.power, win: G.win, medRank: G.medRank };
    }
    rows.push(row);
    console.error(key + ' | ' + MODES.map(m => row.m[m] ? m + ' plan ' + row.m[m].plan + '/' + plan.quota + ' niche ' + (row.m[m].niche == null ? '-' : (100 * row.m[m].niche).toFixed(0) + '%') + ' power ' + row.m[m].power : m + ' error').join(' | ') + ' | human power ' + H.power + ' plan ' + H.plan);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ meta: { bracket: BR, modes: MODES, games: GAMES, cards: L.cardFile }, rows }, null, 1));
  console.log(JSON.stringify(summary(rows), null, 1));
})();
