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


module.exports=raw;