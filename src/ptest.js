// Pauper Commander (PDH) tests on the SYNTHETIC fixture plus a made-up rarity file. Logic tests only.
const E = require('./engine.js'), An = require('./analysis.js'), B = require('./builder.js'), raw = require('./fixture.js');
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('pass', m); };
const db = E.buildDB(raw.map(E.norm).filter(Boolean), {});
const L = n => E.lookup(db, n);
// commons: every "k = 0" synthetic card and every land; uncommon: the legendary commanders and one plain creature
const common = db.all.filter(c => / 0-\d+$/.test(c.n) || /\bLand\b/.test(c.ft) || c.n === 'Synth Rats').map(c => c.n);
const RAR = { format: 'edhgen-rarity/1', common, uncommon: ['Synth Mono Lord', 'Synth Partner A', 'Synth Partner B', 'Synth G 1-18', 'Synth G 1-19'], banned: ['Synth G 0-3'] };
E.addRarity(db, RAR);

(async () => {
  E.setFormat(db, '');
  assert(E.commanderEligibility(L('Synth Rainbow')).ok && !E.commanderEligibility(L('Synth G 1-18')).ok, 'Commander: legendary commanders only');
  E.setFormat(db, 'pdh');
  assert(E.commanderEligibility(L('Synth Mono Lord')).ok && E.commanderEligibility(L('Synth G 1-18')).ok, 'PDH: uncommon creatures are commanders, legendary or not');
  assert(!E.commanderEligibility(L('Synth Rainbow')).ok && !E.commanderEligibility(L('Synth G 0-18')).ok, 'PDH: a rare or a common-only creature is not a commander');
  assert(L('Synth G 1-3').leg === 'not_legal' && L('Synth G 0-3').leg === 'banned' && L('Synth G 0-4').leg === 'legal' && L('Synth Banned Rock').leg === 'banned', 'PDH: 99 legality from common printings and bans');
  const cmd = L('Synth G 1-18');
  assert(B.pool(db, cmd.ci, null, [cmd]).every(c => c.rar.includes('common') && c.leg === 'legal'), 'PDH: Builder pool has commons only');

  const R = await E.generate(db, { commanders: ['Synth G 1-18', ''], seed: 'pdh', format: 'pdh' });
  assert(!R.errors.length, 'PDH: generates with a non-legendary uncommon commander ' + R.errors.join(' '));
  const n = R.commanders.length + R.deck.reduce((s, e) => s + e.qty, 0);
  assert(n === 100 && R.deck.every(e => e.c.rar.includes('common') && e.c.leg === 'legal'), 'PDH: 100 cards, every one with a common printing');
  const leg = R.validation.rules.find(r => r.id === 'legality');
  assert(leg.pass && /Pauper/.test(leg.label), 'PDH: legality rule passes and names the format');
  assert(R.excluded['Synth G 1-3'] === 'no common printing' && R.excluded['Synth G 0-3'] === 'banned', 'PDH: build log names why cards were left out');

  const bad = await E.generate(db, { commanders: ['Synth G 1-18', ''], format: '' });
  assert(bad.errors.length && L('Synth G 1-3').leg === 'legal', 'Commander again: the same commander is refused and legality is restored');

  const locks = R.deck.filter(e => !E.isBasic(e.c)).slice(0, 20).map(e => ({ name: e.c.n, qty: 1 })).concat([{ name: 'Synth G 1-3', qty: 1 }]);
  const I = await E.generate(db, { commanders: ['Synth G 1-18', ''], format: 'pdh' }, { locks, imported: true, asIs: true });
  const li = I.validation.rules.find(r => r.id === 'legality');
  assert(I.deck.some(e => e.c.n === 'Synth G 1-3') && !li.pass && li.offenders.includes('Synth G 1-3') && li.offenders.length === 1, 'PDH import: a card with no common printing is kept and flagged');
  const X = An.run(db, I.deck, I.commanders, { settings: I.settings, games: 200 });
  assert(X.recs.some(r => r.sev === 'high' && /not legal in Pauper Commander/.test(r.text) && /Synth G 1-3/.test(r.text)), 'PDH import: Analysis lists it as a high problem');
  assert(X.planner.pool.every(c => c.leg === 'legal' && c.rar.includes('common')), 'PDH: suggested adds are commons only');
  const I2 = await E.generate(db, { commanders: ['Synth G 1-18', ''], format: 'pdh' }, { locks, imported: true });
  assert(I2.deck.some(e => e.c.n === 'Synth G 1-3'), 'PDH: Fill to 100 keeps the flagged card');
  const G = await E.generate(db, { commanders: ['Synth G 1-18', ''], format: 'pdh', include: '1 Synth G 1-3' });
  assert(!G.deck.some(e => e.c.n === 'Synth G 1-3') && G.warnings.some(w => /Synth G 1-3 is not printed at common/.test(w)), 'PDH: a must-include card with no common printing is rejected');

  const s1 = await E.generate(db, { commanders: ['Synth Mono Lord', ''] }), s2 = await E.generate(db, { commanders: ['Synth Mono Lord', ''], format: '' });
  assert(s1.seedUsed === s2.seedUsed && s1.deck.map(e => e.c.n).join() === s2.deck.map(e => e.c.n).join(), 'Commander: an empty format leaves the seed and deck as before');

  // tools/scryfall-rarity.js on a made-up Default Cards file: paper and MTGO printings count, Arena does not
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdh-')), inp = path.join(dir, 'd.jsonl'), out = path.join(dir, 'r.json');
  const pr = (name, rarity, games, type_line, extra) => JSON.stringify(Object.assign({ object: 'card', name, rarity, games, type_line: type_line || 'Instant', set_type: 'expansion' }, extra || {}));
  const lines = [pr('Paper Common', 'common', ['paper']), pr('Mtgo Common', 'common', ['mtgo']), pr('Arena Common', 'common', ['arena']), pr('Arena Common', 'rare', ['paper']),
    pr('Unc Beast', 'uncommon', ['paper', 'mtgo'], 'Creature — Beast'), pr('Unc Spell', 'uncommon', ['paper']), pr('Gold Common', 'common', ['paper'], 'Instant', { set_type: 'memorabilia' }),
    pr('Unc Ship', 'uncommon', ['paper'], 'Artifact — Vehicle'), pr('Remora', 'common', ['paper'], 'Enchantment', { legalities: { paupercommander: 'banned' } })];
  for (let i = 0; i < 1000; i++) lines.push(pr('Filler ' + i, 'rare', ['paper']));
  fs.writeFileSync(inp, lines.join('\n') + '\n');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'scryfall-rarity.js'), inp, out]);
  const J = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert(J.common.join() === 'Mtgo Common,Paper Common,Remora' && J.uncommon.join() === 'Unc Beast,Unc Ship' && J.banned.join() === 'Remora', 'rarity tool: commons on paper/MTGO, uncommon creatures and Vehicles, Scryfall bans');
  fs.rmSync(dir, { recursive: true, force: true });
  E.setFormat(db, '');
})();
