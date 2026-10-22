// Engine tests on a SYNTHETIC Scryfall-format fixture (fake card names "Synth ..."). Logic tests only.
const E = require('./engine.js');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('pass', m); };
let seq = 0;
const COLS = 'WUBRG';
const TEXTS = [
  ['{T}: Add {C}{C}.', 'Artifact', 1], ['{T}: Add one mana of any color.', 'Artifact', 2],
  ['Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.', 'Sorcery', 2],
  ['Draw two cards.', 'Sorcery', 2], ['Draw three cards.', 'Instant', 4],
  ['Destroy target creature.', 'Instant', 2], ['Exile target nonland permanent.', 'Instant', 3],
  ['Destroy all creatures.', 'Sorcery', 4], ['Counter target spell.', 'Instant', 2],
  ['Creatures you control gain hexproof and indestructible until end of turn.', 'Instant', 2],
  ['Return target creature card from your graveyard to your hand.', 'Sorcery', 2],
  ['Each opponent loses 3 life and you gain 3 life.', 'Sorcery', 4],
  ['Whenever a creature you control dies, each opponent loses 1 life.', 'Enchantment', 3],
  ['Create two 1/1 white Soldier creature tokens.', 'Sorcery', 3],
  ['Put a +1/+1 counter on target creature.', 'Instant', 1],
  ['Search your library for a card, put it into your hand, then shuffle.', 'Sorcery', 2],
  ['Take an extra turn after this one.', 'Sorcery', 5],
  ['Destroy all lands.', 'Sorcery', 4],
  ['Flying', 'Creature — Elf Warrior', 3], ['Trample', 'Creature — Beast', 5], ['Haste', 'Creature — Human Soldier', 2],
  ['When this enters, draw a card.', 'Creature — Human Wizard', 3], ['Vigilance', 'Creature — Giant', 7]
];
const raw = [];
function card(o) { seq++; return Object.assign({ object: 'card', id: 'id' + seq, oracle_id: 'o' + seq, lang: 'en', layout: 'normal', cmc: 0, mana_cost: '', type_line: 'Sorcery', oracle_text: '', color_identity: [], legalities: { commander: 'legal' }, prices: { usd: '0.50', eur: '0.40', tix: '0.02' }, edhrec_rank: seq * 3, set: 'syn', set_type: 'expansion', border_color: 'black', released_at: '2020-01-01', keywords: [], produced_mana: [] }, o); }
// basics
for (const [x, n] of Object.entries({ W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' })) raw.push(card({ name: n, type_line: 'Basic Land — ' + n, oracle_text: '({T}: Add {' + x + '}.)', produced_mana: [x], prices: { usd: '0.10', eur: '0.10', tix: '0.01' }, edhrec_rank: null }));
raw.push(card({ name: 'Wastes', type_line: 'Basic Land', oracle_text: '{T}: Add {C}.', produced_mana: ['C'], prices: { usd: '0.10' } }));
// spells per color identity subsets (mono + pairs + colorless)
const idents = ['', 'W', 'U', 'B', 'R', 'G', 'WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU', 'WUBRG'];
for (const ci of idents) for (let k = 0; k < 2; k++) TEXTS.forEach(([t, ty, mv], i) => {
  const pips = ci ? ci.split('').map(x => '{' + x + '}').join('') : '';
  const generic = Math.max(0, mv - ci.length);
  raw.push(card({ name: 'Synth ' + (ci || 'C') + ' ' + k + '-' + i, mana_cost: (generic ? '{' + generic + '}' : '') + pips, cmc: Math.max(mv, ci.length), type_line: ty.startsWith('Creature') ? ty : ty, oracle_text: t, color_identity: ci.split('').filter(Boolean), power: ty.startsWith('Creature') ? String(mv) : undefined, toughness: ty.startsWith('Creature') ? String(mv) : undefined, game_changer: (i === 15 || i === 0) && k === 0, prices: { usd: (0.2 + ((seq * 7) % 50) / 5).toFixed(2), eur: '1.00', tix: '0.10' } }));
});
// lands
for (const p of ['WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU']) {
  raw.push(card({ name: 'Synth Dual ' + p, type_line: 'Land', oracle_text: '{T}: Add {' + p[0] + '} or {' + p[1] + '}.', produced_mana: p.split(''), color_identity: p.split(''), prices: { usd: '3.00' } }));
  raw.push(card({ name: 'Synth Shock ' + p, type_line: 'Land — Plains Island', oracle_text: 'As this land enters, you may pay 2 life. If you don\'t, it enters tapped.', produced_mana: p.split(''), color_identity: p.split(''), prices: { usd: '9.00' } }));
}
raw.push(card({ name: 'Synth Tower', type_line: 'Land', oracle_text: '{T}: Add one mana of any color in your commander\'s color identity.', produced_mana: ['W', 'U', 'B', 'R', 'G'], prices: { usd: '0.25' } }));
for (let i = 0; i < 6; i++) raw.push(card({ name: 'Synth Utility ' + i, type_line: 'Land', oracle_text: '{T}: Add {C}.\n{2}, {T}: Scry 1.', produced_mana: ['C'], prices: { usd: '0.30' } }));
// banned + not legal + any-number
raw.push(card({ name: 'Synth Banned Rock', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}{C}.', cmc: 0, legalities: { commander: 'banned' }, edhrec_rank: 1 }));
raw.push(card({ name: 'Synth Rats', type_line: 'Creature — Rat', mana_cost: '{1}{B}{B}', cmc: 3, color_identity: ['B'], oracle_text: 'A deck can have any number of cards named Synth Rats.' }));
// commanders
raw.push(card({ name: 'Synth Mono Lord', type_line: 'Legendary Creature — Elf Druid', mana_cost: '{2}{G}', cmc: 3, color_identity: ['G'], oracle_text: 'Whenever another Elf you control enters, put a +1/+1 counter on it.', prices: { usd: '2.00' } }));
raw.push(card({ name: 'Synth Rainbow', type_line: 'Legendary Creature — Dragon', mana_cost: '{W}{U}{B}{R}{G}', cmc: 5, color_identity: ['W', 'U', 'B', 'R', 'G'], oracle_text: 'Flying\nWhenever you cast a spell, create a 1/1 Soldier token.', prices: { usd: '5.00' } }));
raw.push(card({ name: 'Synth Partner A', type_line: 'Legendary Creature — Human', mana_cost: '{2}{W}', cmc: 3, color_identity: ['W'], oracle_text: 'Lifelink\nPartner (You can have two commanders if both have partner.)', keywords: ['Partner'] }));
raw.push(card({ name: 'Synth Partner B', type_line: 'Legendary Creature — Human', mana_cost: '{2}{U}', cmc: 3, color_identity: ['U'], oracle_text: 'Flying\nPartner (You can have two commanders if both have partner.)', keywords: ['Partner'] }));
raw.push(card({ name: 'Synth Bg Hero', type_line: 'Legendary Creature — Elf', mana_cost: '{1}{B}', cmc: 2, color_identity: ['B'], oracle_text: 'Choose a Background (You can have a Background as a second commander.)' }));
raw.push(card({ name: 'Synth Bg', type_line: 'Legendary Enchantment — Background', mana_cost: '{1}{R}', cmc: 2, color_identity: ['R'], oracle_text: 'Commander creatures you own have haste.' }));
raw.push(card({ name: 'Synth Solo', type_line: 'Legendary Creature — Human', mana_cost: '{1}{R}', cmc: 2, color_identity: ['R'], oracle_text: 'Haste' }));

const db = E.buildDB(raw.map(E.norm).filter(Boolean), { source: 'synthetic' });
console.log('fixture cards:', db.all.length);

function legalCheck(R, label) {
  const v = R.validation.rules; const get = id => v.find(r => r.id === id);
  const n = R.commanders.length + R.deck.reduce((s, e) => s + e.qty, 0);
  assert(n === 100, label + ': 100 cards (' + n + ')');
  assert(get('singleton').pass, label + ': singleton');
  assert(get('identity').pass && R.deck.every(e => [...e.c.ci].every(x => R.CI.includes(x))), label + ': identity');
  assert(R.deck.every(e => e.c.leg === 'legal'), label + ': no banned/illegal');
  assert(R.ok, label + ': all validation rules pass ' + JSON.stringify(v.filter(r => r.pass === false).map(r => r.label + ': ' + r.detail)));
}
(async () => {
  const base = { seed: 'acceptance', bracket: 4, bl: E.bracketDefaults(4) };
  let R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Mono Lord', ''] }));
  if (R.errors.length) console.log(R.errors);
  legalCheck(R, 'mono');
  console.log(R.log.join('\n'));
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'] }));
  legalCheck(R, '5-color');
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Partner A', 'Synth Partner B'] }));
  legalCheck(R, 'partner'); assert(R.CI === 'WU', 'partner CI WU');
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Bg Hero', 'Synth Bg'] }));
  legalCheck(R, 'background'); assert(R.CI === 'BR', 'background CI BR');
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Solo', 'Synth Partner A'] }));
  assert(R.errors.length && /cannot be paired/.test(R.errors[0]), 'invalid pair rejected');
  // budget
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'], budget: { total: 60, perCard: 3, cur: 'usd', inclBasics: true, unknown: 'exclude' } }));
  legalCheck(R, 'budget 60'); assert(R.totalPrice <= 60, 'budget total ' + R.totalPrice.toFixed(2) + ' <= 60');
  assert(R.deck.every(e => E.isBasic(e.c) || e.c.p.usd <= 3), 'per-card cap respected');
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'], budget: { total: 4, cur: 'usd', inclBasics: true } }));
  assert(R.errors.length && /Budget infeasible/.test(R.errors[0]), 'infeasible budget message: ' + R.errors[0]);
  // determinism
  const a = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'], variance: 0.6 }));
  const b = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'], variance: 0.6 }));
  assert(E.exportDeck(a, 'plain') === E.exportDeck(b, 'plain'), 'same seed + settings = identical');
  const c = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'], variance: 0.6, seed: 'other' }));
  console.log('different seed differs:', E.exportDeck(a, 'plain') !== E.exportDeck(c, 'plain'));
  // bracket 2
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'], bracket: 2, bl: E.bracketDefaults(2) }));
  legalCheck(R, 'bracket 2'); assert(R.stats.gcs.length === 0, 'bracket 2: 0 game changers');
  assert(R.deck.filter(e => E.analyze(e.c).flags.tutor).length <= 3, 'bracket 2 tutors <=3');
  // includes with any-number + bracket violation include
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Rainbow'], include: '20 Synth Rats\nSynth Banned Rock\nNope Card' }));
  legalCheck(R, 'any-number include'); console.log(R.warnings);
  // swap/remove
  const e = R.deck.find(x => x.slot === 'ramp'); const alts = R.alternatives(e, 5); console.log('alts', alts.map(x => x.c.n));
  await R.remove(e); legalCheck(R, 'after remove');
  // owned only
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Mono Lord'], owned: { mode: 'only', list: '1 Synth G 0-0\n1 Synth G 0-3' } }));
  legalCheck(R, 'owned only'); console.log(R.warnings);
  // combos local
  // Spellbook rows as written by tools/spellbook-shard.js: [id, cards, features, templates, identity, mv, bracketTag, popularity, flags]
  const sbTables = { cards: ['Synth G 1-0', 'Synth G 1-3', 'Synth Mono Lord', 'Synth G 0-0'], features: ['Infinite mana', 'Infinite lifegain'], templates: ['Sacrifice outlet'] };
  const sbVars = E.spellbookVariants(sbTables, [['x', [0, 1], [0], [], 'G', 2, 'S', 10, 0], ['t', [0, 3], [1], [0], 'G', 2, 'O', 5, 0], ['c', [-3, 3], [1], [], 'G', 3, 'O', 5, 0]], db);
  const prov = E.localComboProvider(sbVars);
  assert(sbVars[0].inf && sbVars[0].c.join('+') === 'Synth G 1-0+Synth G 1-3' && sbVars[2].cmd[0] === 'Synth Mono Lord', 'spellbook rows decode');
  assert((await prov.find(['Synth G 1-0', 'Synth G 0-0'])).length === 0, 'template variant never counted as assembled');
  assert((await prov.find(['Synth Mono Lord', 'Synth G 0-0'], [])).length === 0, 'must-be-commander variant needs that commander');
  assert((await prov.find(['Synth Mono Lord', 'Synth G 0-0'], ['Synth Mono Lord'])).map(v => v.id).join() === 'c', 'must-be-commander variant found with that commander');
  assert(prov.completes('Synth G 1-3', n => n === 'Synth G 1-0').length === 1 && prov.completes('Synth G 1-3', []).length === 0, 'completes with predicate');
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Mono Lord'], bracket: 2, bl: E.bracketDefaults(2), include: 'Synth G 1-0' }), { combos: prov });
  legalCheck(R, 'combo bracket 2'); assert(!R.deck.some(e => e.c.n === 'Synth G 1-3'), 'combo partner excluded at bracket 2');
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Mono Lord'], filters: { combos: 'prefer' }, exclude: 'Synth G 1-3' }), { combos: prov });
  legalCheck(R, 'combo prefer w/ exclude');
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Mono Lord'], filters: { combos: 'prefer' } }), { combos: prov });
  console.log('combos found', R.combos.map(v => v.c.join('+')));
  // dry-run replace: reports the rule a combo add would break and leaves the deck unchanged
  R = await E.generate(db, Object.assign({}, base, { commanders: ['Synth Mono Lord'], bracket: 2, bl: E.bracketDefaults(2), include: 'Synth G 1-0' }), { combos: prov });
  const before = R.deck.map(e => e.qty + e.c.n + e.locked).join('|'), tot = R.stats.total, cutE = R.deck.find(e => !E.analyze(e.c).isLand && !e.inc);
  const fails = await R.checkReplace(cutE, E.lookup(db, 'Synth G 1-3'));
  assert(fails.length && fails[0].id === 'bracket', 'checkReplace flags the 2-card infinite at bracket 2: ' + fails.map(r => r.id));
  assert(R.deck.map(e => e.qty + e.c.n + e.locked).join('|') === before && Math.abs(R.stats.total - tot) < 1e-9 && R.ok, 'checkReplace leaves the deck as it was');
  const altE = R.deck.map(e => ({ e, a: R.alternatives(e, 1)[0] })).find(x => x.a && !E.analyze(x.e.c).isLand);
  assert(altE && (await R.checkReplace(altE.e, altE.a.c)).length === 0, 'checkReplace passes a legal swap');
  // Scryfall slimmer keeps everything norm() reads; norm() keeps P/T and the image path
  const { slim } = require('../tools/scryfall-slim.js');
  const full = card({ name: 'Slim Test', power: '2', toughness: '3', scryfall_uri: 'https://scryfall.com/card/x/1/slim-test?utm_source=api', image_uris: { small: 'https://cards.scryfall.io/small/front/a/b/ab12-cd.jpg?1', normal: 'https://cards.scryfall.io/normal/front/a/b/ab12-cd.jpg?1' }, legalities: { commander: 'legal', modern: 'legal' }, artist: 'X', all_parts: [] });
  const n1 = E.norm(full), n2 = E.norm(slim(full));
  assert(n1.pt === '2/3' && n1.img === 'front/a/b/ab12-cd.jpg', 'norm keeps P/T and image path');
  assert(JSON.stringify(Object.assign({}, n1, { uri: '' })) === JSON.stringify(Object.assign({}, n2, { uri: '' })) && n2.uri === 'https://scryfall.com/card/x/1/slim-test', 'slimmed card normalises the same');
  assert(E.norm(card({ name: 'Bad Img', image_uris: { normal: 'https://evil.example/x.jpg' } })).img === '', 'image path only from cards.scryfall.io');
  // Inspire me: quiz answers rank commanders, with reasons
  {
    const L = (name, tl, ot, ci, o) => E.norm(card(Object.assign({ name, type_line: 'Legendary Creature — ' + tl, oracle_text: ot, color_identity: ci.split(''), cmc: 3, power: '3', toughness: '3' }, o || {})));
    const cs = [L('Insp Elf Lord', 'Elf Warrior', 'Haste\nWhenever Insp Elf Lord attacks, other Elves you control get +1/+1 until end of turn.', 'G', { keywords: ['Haste'], edhrec_rank: 900 }),
      L('Insp Counter Sage', 'Human Wizard', 'Flash\nWhenever you cast an instant spell, counter target spell. Draw a card.', 'U', { keywords: ['Flash'], edhrec_rank: 100 }),
      L('Insp Big Beast', 'Beast', 'Creature spells you cast with mana value 6 or greater cost {2} less.', 'G', { cmc: 7, power: '8', toughness: '8', edhrec_rank: 5000 })];
    const idb = E.buildDB(cs.concat(raw.map(E.norm).filter(Boolean)), {});
    const top = A => E.inspire(idb, A).list[0];
    assert(top({ style: 'aggro', tribe: 'Elf' }).c.n === 'Insp Elf Lord', 'inspire: aggressive Elf → the Elf lord');
    assert(top({ style: 'control' }).c.n === 'Insp Counter Sage', 'inspire: control → the counterspell commander');
    assert(top({ style: 'big', cols: 'G' }).c.n === 'Insp Big Beast', 'inspire: go big in green → the big beast');
    assert(E.inspire(idb, { cols: 'U' }).list.every(r => /^U?$/.test(r.c.ci)), 'inspire: colours filter is within the chosen colours');
    const r = top({ style: 'aggro', tribe: 'Elf' });
    assert(r.why.some(w => /Elves/.test(w.t)) && r.why.some(w => /attack trigger/.test(w.t)) && r.pct > 0 && r.pct <= 1, 'inspire: reasons name the matched signals, match between 0 and 1');
    assert(E.styleProfile(cs[1]).some(s => s.key === 'control'), 'styleProfile: counterspell commander leans control');
  }
  // Import: a full list passed as locks comes back unchanged, even when settings would build something else
  {
    const base = await E.generate(db, { commanders: ['Synth Rainbow'], seed: 'imp', bracket: 4, bl: E.bracketDefaults(4) });
    const locks = base.deck.map(e => ({ name: e.c.n, qty: e.qty }));
    const key = d => d.map(e => e.qty + ' ' + e.c.n).sort().join('|');
    const S2 = { commanders: ['Synth Rainbow'], seed: 'other', bracket: 4, bl: E.bracketDefaults(4), targets: { lands: 30 }, budget: { total: 1 } };
    const R2 = await E.generate(db, S2, { locks, imported: true });
    assert(!R2.errors.length && key(R2.deck) === key(base.deck) && R2.deck.every(e => e.locked), 'import: full list kept as-is, all locked');
    assert(R2.warnings.some(w => /imported list costs/.test(w)) && R2.validation.rules.some(r => r.pass === false), 'import: over-budget list is kept, budget rule fails');
    assert((await E.generate(db, S2, { locks })).errors.some(e => /Budget infeasible/.test(e)), 'rebuild around locks still refuses an infeasible budget');
    const R3 = await E.generate(db, { commanders: ['Synth Rainbow'], seed: 'imp', bracket: 4, bl: E.bracketDefaults(4) }, { locks: locks.slice(0, 60), imported: true });
    assert(R3.deck.reduce((s, e) => s + e.qty, 0) === 99 && R3.deck.filter(e => e.locked).length === 60, 'import: short list is filled to 100, filled cards unlocked');
    const R4 = await E.generate(db, { commanders: ['Synth Rainbow'], seed: 'imp' }, { locks: locks.concat([{ name: 'Synth C 1-0' }, { name: 'Synth C 1-1' }]).filter((l, i, a) => a.findIndex(x => x.name === l.name) === i), imported: true });
    assert(R4.errors.some(e => /^Imported list has/.test(e)), 'import: more than 99 cards is an error');
    const R5 = await E.generate(db, { commanders: ['Synth Rainbow'], seed: 'imp', bracket: 4, bl: E.bracketDefaults(4) }, { locks: locks.slice(0, 60), imported: true, asIs: true });
    assert(R5.deck.length === 60 && R5.deck.every(e => e.locked) && R5.validation.rules.some(r => r.id === 'count' && r.pass === false), 'import as-is: short list is not filled, count rule fails');
    const An = require('./analysis.js');
    const P1 = An.parseDecklist('// COMMANDER\n1 Synth Rainbow (LTC) 498\n\n1 Sol Ring (LTC) 284\n26 Forest (SOS) 280\n// Sideboard\n1 Opt');
    assert(P1.cmd.length === 1 && P1.cmd[0].name === 'Synth Rainbow' && P1.main.length === 2 && P1.main[1].qty === 26, 'parse: "// COMMANDER" header, blank line ends the commander section');
    const P2 = An.parseDecklist('Commander (1)\n1 A\n1 B\nDeck\n1 C\n\nSideboard:\n1 D');
    assert(P2.cmd.length === 2 && P2.main.length === 1, 'parse: "Commander (1)" header with partners, sideboard skipped');
    // export formats seen in the wild: each must read back as the same 99 cards and commander
    const PL = l => JSON.stringify(E.parseLine(l));
    assert(PL('1 Sol Ring (PLST) C21-263 *F*') === PL('1x Sol Ring (cmm) 400 [Ramp] ^Have,#37d67a^') && PL('1 Sol Ring #Ramp #!Staple') === PL('Sol Ring x1') && PL('1 Sol Ring') === '{"qty":1,"name":"Sol Ring"}', 'parseLine: set codes, foil marks, Archidekt categories and ^tags^, Moxfield #tags, "Name x1"');
    assert(E.parseLine('B.F.M. (Big Furry Monster)').name === 'B.F.M. (Big Furry Monster)' && E.parseLine('26 Forest (SOS) 280').qty === 26, 'parseLine: a name in parentheses is kept; quantities are read');
    const rows = base.deck.map(e => [e.qty, e.c.n]), body = (f, sep) => rows.map(([q, n]) => f(q, n)).join(sep || '\n');
    const FMT = {
      'Moxfield, commander last': body((q, n) => q + ' ' + n) + '\n\n1 Synth Rainbow',
      'plain, commander first, no header': '1 Synth Rainbow\n' + body((q, n) => q + ' ' + n),
      'MTGO, commander in sideboard': body((q, n) => q + ' ' + n) + '\n\nSideboard\n1 Synth Rainbow',
      'SB: line': body((q, n) => q + ' ' + n) + '\nSB: 1 Synth Rainbow',
      'Archidekt with maybeboard': body((q, n) => q + 'x ' + n + ' (syn) 1 [Ramp] ^Have,#37d67a^') + '\n1x Synth Rainbow [Commander{top}]\n1x Synth C 1-0 [Maybeboard{noDeck}{noPrice}]',
      'Moxfield #tags, #!Commander': body((q, n) => q + ' ' + n + ' (SYN) 1 #Staple') + '\n1 Synth Rainbow #!Commander',
      'CSV without a commander column': '"Count","Name","Edition"\n' + body((q, n) => '"' + q + '","' + n + '","syn"') + '\n"1","Synth Rainbow","syn"',
      'groups split by blank lines after 90+ cards': 'Commander\n1 Synth Rainbow\n\n' + body((q, n) => q + ' ' + n, '\n\n')
    };
    for (const [k, t] of Object.entries(FMT)) {
      const K = An.pickCommanders(An.parseDecklist(t), db), n = K.main.filter(x => x.name !== 'Synth Rainbow').reduce((s, x) => s + x.qty, 0);
      assert(K.cmds.length === 1 && K.cmds[0].n === 'Synth Rainbow' && n === 99, 'import format: ' + k + ' (commander ' + (K.cmds[0] ? K.cmds[0].n : 'none') + ', ' + n + ' cards)');
    }
    const K0 = An.pickCommanders(An.parseDecklist(body((q, n) => q + ' ' + n)), db);
    assert(!K0.cmds.length && Array.isArray(K0.candidates), 'pickCommanders: a list without a commander finds none and returns candidates');
    const db2 = E.buildDB(raw.map(E.norm).filter(Boolean), {});
    assert(E.addAliases(db2, [['Synth Flavour Name', 'Synth Rainbow'], ['Synth Mono Lord', 'Synth Rainbow']]) === 1 && E.lookup(db2, 'Synth Flavour Name').n === 'Synth Rainbow' && E.lookup(db2, 'Synth Mono Lord').n === 'Synth Mono Lord', 'addAliases: an alternate name maps to its card, never over a real card name');
    // swap planner: combo adds and budget upgrades
    const rb = E.lookup(db, 'Synth Rainbow'), pdeck = base.deck.map(e => Object.assign({}, e, { locked: false }));
    const PX = An.run(db, pdeck, [rb], { settings: base.settings, games: 300 });
    const adds = PX.planner.pool.filter(c => !E.analyze(c).isLand).slice(0, 2), pc = An.pairCuts(PX.planner, adds, new Set([pdeck[0].c.n]));
    assert(pc.length === 2 && pc.every(x => x.cut && !E.analyze(x.cut).isLand && x.cut !== pdeck[0].c) && pc[0].cut !== pc[1].cut, 'pairCuts: one distinct nonland cut per add, never a kept card');
    const prep = An.impactPrep(db, pdeck, [rb], { settings: base.settings, impactGames: 300 });
    const UP = await An.upgradePlan(prep, PX.planner, 5, { maxCuts: 4 });
    const inDeckN = new Set(pdeck.map(e => e.c.n)), nonCuts = UP.swaps.filter(x => !E.analyze(x.add).isLand).map(x => x.cut);
    assert(UP.spent <= 5 + 1e-9 && UP.swaps.every(x => !inDeckN.has(x.add.n) && x.add.leg === 'legal' && inDeckN.has(x.cut.n) && x.g > 0) && new Set(nonCuts).size === nonCuts.length, 'upgradePlan: adds fit the amount, are legal and new, cuts are distinct deck cards (' + UP.swaps.length + ' swaps, ' + UP.spent + ')');
    // deep search: same shuffles give the same score; the package only holds measured gains, distinct cuts, new legal adds
    const Dp = require('./deep.js'), keepN = new Set([rb.n]);
    const v2 = PX.planner.pool.filter(c => !E.analyze(c).isLand).slice(3, 5), prov2 = E.localComboProvider([{ id: 'syn-pair', c: [v2[0].n, v2[1].n, pdeck[5].c.n], cmd: [], p: ['Win the game'], t: [], r: 0, pop: 9 }], {});
    const dctx = { deck: pdeck, cmds: [rb], combos: [], prov: prov2, keep: keepN, settings: base.settings };
    const init = Dp.makeInit(PX, dctx, v2, { settings: base.settings });
    const ev = Dp.evaluator(typeof structuredClone === 'function' ? structuredClone(init) : JSON.parse(JSON.stringify(init)));
    const cutN = pdeck.find(e => !E.analyze(e.c).isLand && e.c.n !== pdeck[5].c.n).c.n, t1 = { id: 1, games: 300, swaps: [{ cut: cutN, add: v2[0].n }] };
    assert(ev({ id: 0, games: 300, swaps: [] }).g === 0 && ev(t1).g === ev(Object.assign({}, t1, { id: 2 })).g, 'deep evaluator: no swap scores 0, the same swap twice scores the same (common random numbers, structured-cloned input)');
    assert(init.comp[v2[0].n] && init.comp[v2[0].n].length === 1, 'deep: a candidate that completes a Spellbook line with another candidate carries that line');
    let ticks = 0;
    const DS = await Dp.search(PX, dctx, Dp.localExec, async () => { ticks++; }, { g1: 200, g2: 300, cuts: 6, nonland: 10, popular: 2, perRole: 1, perVector: 1, lands: 3, single: 2, pairs: 2, confirm: 14, rounds: 3, lead: 4, altFor: 1, altCuts: 2 });
    const pc2 = DS.pkg.map(x => x.cut);
    assert(DS.stats.evals > 10 && ticks === DS.stats.evals + 1 && DS.pkg.every(x => !inDeckN.has(x.add.n) && x.add.leg === 'legal' && inDeckN.has(x.cut.n) && !keepN.has(x.cut.n)) && new Set(pc2).size === pc2.length && (!DS.pkg.length || DS.pkg[DS.pkg.length - 1].total >= Dp.MIN_GAIN * DS.pkg.length), 'deep search: ' + DS.stats.evals + ' measured lists; package of ' + DS.pkg.length + ' with new legal adds, distinct cuts, total gain ≥ ' + Dp.MIN_GAIN + ' per swap (' + DS.stats.refined + ' refined)');
    const DR = Dp.rows(PX, DS);
    const pkgAdds = new Set(DS.pkg.map(p => p.add.n));
    assert(DR.length === DS.pkg.length + DS.singles.filter(it => !it.adds.some(a => pkgAdds.has(a.n))).reduce((s, it) => s + it.adds.length, 0) && !DR.some(r => r.group === 'Deep search' && pkgAdds.has(r.add.n)) && DR.every(r => r.d && r.after && r.cut && r.add && /^(Package|Deep search)$/.test(r.group)), 'deep rows: one accept/deny row per swap, with the measured effect; no single repeats a package card');
    // mechanics graph: Oracle text → needs/makes; linked pairs
    const Mh = require('./mech.js'), mk = (n, low, ft, cmc, kw) => ({ n, low, ft: ft || 'Creature — Test', cmc: cmc == null ? 2 : cmc, kw: kw || [] });
    const outlet = mk('Synth Altar', 'sacrifice a creature: add {c}{c}.', 'Artifact', 3), drain = mk('Synth Artist', 'whenever this creature or another creature dies, target player loses 1 life and you gain 1 life.');
    const maker = mk('Synth Mob', '{t}: create a 1/1 red goblin creature token.'), landfall = mk('Synth Cobra', 'landfall — whenever a land you control enters, add one mana of any color.', 'Creature — Snake', 2, ['landfall']);
    const ramp = mk('Synth Growth', 'search your library for a basic land card, put it onto the battlefield tapped, then shuffle.', 'Sorcery'), flier = mk('Synth Bird', 'flying'), counter = mk('Synth Denial', 'counter target spell.', 'Instant');
    assert(Mh.parse(outlet).needs.has('fodder.creature') && Mh.parse(drain).needs.has('creature.dies') && Mh.parse(maker).makes.has('token.creature') && Mh.parse(landfall).needs.has('land.enters') && Mh.parse(ramp).makes.has('land.drop'), 'mech parse: sacrifice cost, dies trigger, token maker, landfall, land ramp');
    assert(Mh.pairW(outlet, drain) >= Mh.LINK && Mh.pairW(maker, outlet) >= Mh.LINK && Mh.pairW(landfall, ramp) >= Mh.LINK, 'mech links: sac outlet ↔ death trigger, token maker ↔ sac outlet, landfall ↔ land ramp');
    assert(Mh.pairW(flier, counter) < Mh.LINK && Mh.pairW(drain, ramp) < Mh.LINK && Mh.pairW(outlet, outlet) === 0, 'mech links: unrelated cards stay unlinked; a card is not linked to itself');
    assert(Mh.norm(mk('Synth Krenko, Mob Boss', 'synth krenko deals 2 damage. when synth krenko, mob boss enters, draw a card.')).split('~').length === 3, 'mech norm: full and short card name become ~');
    // colour check: Karsten's definition (colour given land drops); his 99-card figures 19 (C, T1) and 30 (CC, T2) at 37 lands
    assert(Math.abs(An.castOdds(99, 37, 19, 7, 1, 1) - 0.813) < 0.002 && Math.abs(An.castOdds(99, 37, 30, 8, 2, 2) - 0.872) < 0.002, 'castOdds: 19 sources C on T1 = 81.3%, 30 sources CC on T2 = 87.2%');
    assert(An.castOdds(99, 37, 37, 9, 3, 3) === 1 && An.castOdds(99, 37, 0, 9, 1, 3) === 0, 'castOdds: all lands of the colour → 1, none → 0');
    const ck = An.castCheck([{ c: { n: 'X', mc: '{X}{W}{W}', cmc: 2 } }, { c: { n: 'Y', mc: '{W}', cmc: 1 } }], 99, 37, { W: 20 });
    assert(ck.length === 2 && ck.find(r => r.n === 'X').t === 4 && ck[0].p <= ck[1].p, 'castCheck: X spells judged at X = 2, rows sorted worst first');
    assert(Math.abs(An.karstenLands(3, 10) - 36.66) < 0.01, 'karstenLands: 31.42 + 3.13 × 3 − 0.28 × 10 − 1.35 = 36.66');
    // goldfish: lands pay coloured pips; combo lines assemble from drawn pieces
    const L = n => E.lookup(db, n), Wsp = db.all.filter(c => c.ci === 'W' && !E.analyze(c).isLand && /\{W\}/.test(c.mc) && !E.analyze(c).roles.ramp).slice(0, 2);
    const offColour = An.simulate([{ c: L('Island'), qty: 40 }, { c: Wsp[0], qty: 59 }], [], 300, 7, { CI: 'W' });
    const onColour = An.simulate([{ c: L('Plains'), qty: 40 }, { c: Wsp[0], qty: 59 }], [], 300, 7, { CI: 'W' });
    assert(offColour.perTurn.every(r => r.spells === 0) && onColour.perTurn[5].spells > 0, 'simulate: Islands cannot cast a white spell, Plains can');
    const cb = An.simulate([{ c: L('Plains'), qty: 39 }, { c: Wsp[0], qty: 30 }, { c: Wsp[1], qty: 30 }], [], 300, 7, { CI: 'W', lines: [{ cards: [Wsp[0].n, Wsp[1].n], cost: 2 }] });
    assert(cb.combo && cb.combo.byT[4] > 0.9 && cb.lines[0].median <= 3, 'simulate: a 2-card line with 30 copies of each piece assembles by turn 3');
    // trigger economy: events fire triggered abilities (mechanics graph); sacrificed tokens feed death triggers
    const nc = (name, text, ty) => E.norm(card({ name, mana_cost: '{W}', cmc: 1, type_line: ty || 'Enchantment', oracle_text: text, color_identity: ['W'], colors: ['W'] }));
    const seer = nc('Synth Land Seer', 'Whenever a land you control enters, draw a card.'), pebble = nc('Synth Pebble', 'Flash');
    const tSeer = An.simulate([{ c: L('Plains'), qty: 40 }, { c: seer, qty: 59 }], [], 300, 7, { CI: 'W' }).trig, tPeb = An.simulate([{ c: L('Plains'), qty: 40 }, { c: pebble, qty: 59 }], [], 300, 7, { CI: 'W' }).trig;
    assert(tSeer.cards > 1 && tPeb.cards === 0 && tPeb.fires === 0, 'simulate: a landfall draw trigger draws cards (' + tSeer.cards.toFixed(2) + ' by T6); a card without triggers fires none');
    const upMaker = nc('Synth Upkeep Maker', 'At the beginning of your upkeep, create a 1/1 white Soldier creature token.'), outlet2 = nc('Synth Outlet', 'Sacrifice a creature: Scry 1.', 'Artifact'), payoff = nc('Synth Mourner', 'Whenever a creature you control dies, each opponent loses 1 life.');
    const aris = k => An.simulate([{ c: L('Plains'), qty: 40 }, { c: upMaker, qty: 20 }, { c: k, qty: 20 }, { c: payoff, qty: 19 }], [], 300, 7, { CI: 'W' }).trig;
    const withO = aris(outlet2), noO = aris(pebble);
    assert(withO.dmg > 0 && noO.dmg === 0 && withO.tok > 0, 'simulate: tokens + sacrifice outlet + death trigger drain (' + withO.dmg.toFixed(2) + ' damage by T6); without the outlet nothing dies');
    assert(onColour.keep7 > 0 && onColour.keep7 + onColour.mulligan <= 1.0001, 'simulate: keep and mulligan rates are shares of games');
    // mana model: activation cost netted, one-shot mana, conditional and card-cost moxen
    const rock = (name, text, cmc, ty) => E.norm(card({ name, cmc, type_line: ty || 'Artifact', oracle_text: text, produced_mana: ['W'] }));
    const mm = c => An.manaModel(c);
    const sig = mm(rock('Synth Signet', '{1}, {T}: Add {W}{W}.', 2)), filt = mm(rock('Synth Filter', '{1}, {T}: Add one mana of any color.', 1)), petal = mm(rock('Synth Petal', '{T}, Sacrifice this artifact: Add one mana of any color.', 0));
    const opal = mm(rock('Synth Opal', 'Metalcraft — {T}: Add one mana of any color. Activate only if you control three or more artifacts.', 0)), rit = mm(rock('Synth Ritual', 'Add {W}{W}{W}.', 1, 'Instant'));
    const vault = mm(rock('Synth Vault', "This artifact doesn't untap during your untap step.\n{T}: Add {C}{C}{C}.", 1));
    assert(sig.rampPerm === 1 && filt.rampPerm === 0 && petal.burst === 1 && !petal.rampPerm && opal.cond === 'metal' && rit.burst === 3 && vault.burst === 3 && !vault.rampPerm, 'mana model: Signet nets 1, a {1} filter 0, Petal, rituals and Mana Vault are one-shot, metalcraft is conditional');
    const ritDeck = k => An.simulate([{ c: L('Plains'), qty: 36 }, { c: E.norm(card({ name: 'Synth Six', cmc: 6, mana_cost: '{5}{W}', type_line: 'Creature — Test', oracle_text: '', power: '6', toughness: '6', color_identity: ['W'] })), qty: 30 }, { c: k, qty: 33 }], [], 300, 7, { CI: 'W' });
    const withR = ritDeck(rock('Synth Ritual', 'Add {W}{W}{W}.', 1, 'Instant')), noR = ritDeck(pebble);
    assert(withR.perTurn[4].dmg > 0.5 && noR.perTurn[4].dmg === 0, 'simulate: a ritual casts a 6-drop early (damage by T5 ' + withR.perTurn[4].dmg.toFixed(2) + ' vs ' + noR.perTurn[4].dmg.toFixed(2) + ' without)');
  }
})();
