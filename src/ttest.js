// Tagging tests on the REAL card data in ../data (the file data/index.json names). Checks that well-known staples get the
// roles they are played for, and that most of EDHREC's top 500 nonland cards get at least one role or flag.
const E = require('./engine.js'), fs = require('fs'), zlib = require('zlib'), path = require('path');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('pass', m); };
const dir = path.join(__dirname, '..', 'data');
const file = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).files.find(f => /\.jsonl\.gz$/.test(f.name));
if (!file) { console.log('skip: no card data file in data/'); process.exit(0); }
const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, file.name))).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
const db = E.buildDB(raw.map(E.norm).filter(Boolean), {});
const STAPLES = {
  ramp: ['Sol Ring', 'Arcane Signet', 'Llanowar Elves', 'Cultivate', "Kodama's Reach", 'Rampant Growth', 'Farseek', "Nature's Lore", 'Three Visits', 'Skyshroud Claim', 'Wild Growth', 'Utopia Sprawl', 'Smothering Tithe', 'Birds of Paradise', 'Exploration', 'Talisman of Dominance'],
  draw: ['Rhystic Study', 'Phyrexian Arena', 'Skullclamp', 'Harmonize', 'Night\'s Whisper', 'Esper Sentinel', 'The One Ring', 'Augur of Autumn', 'Mystic Remora', 'Jeska\'s Will', 'Tireless Tracker'],
  removal: ['Swords to Plowshares', 'Path to Exile', 'Beast Within', 'Chaos Warp', 'Counterspell', 'Swan Song', 'Generous Gift', 'Anguished Unmaking', 'Lightning Bolt', 'Pongify', 'Negate', 'Feed the Swarm', 'Red Elemental Blast'],
  wipes: ['Wrath of God', 'Toxic Deluge', 'Blasphemous Act', 'Damnation', 'Farewell', 'Austere Command', 'Blasphemous Edict', 'Evacuation'],
  protection: ['Lightning Greaves', 'Swiftfoot Boots', 'Whispersilk Cloak', "Teferi's Protection", 'Heroic Intervention', 'Flawless Maneuver', "Akroma's Will", 'Snakeskin Veil', 'Ephemerate', 'Deflecting Swat', 'Boros Charm'],
  recursion: ['Eternal Witness', 'Animate Dead', 'Reanimate', 'Victimize', 'Sun Titan', "Sevinne's Reclamation", 'Regrowth', 'Meren of Clan Nel Toth'],
  wincon: ['Craterhoof Behemoth', 'Overrun', "Thassa's Oracle", 'Torment of Hailfire', 'Approach of the Second Sun', 'Aetherflux Reservoir', 'Insurrection']
};
for (const [role, list] of Object.entries(STAPLES)) {
  const missing = [], absent = [];
  for (const n of list) { const c = E.lookup(db, n); if (!c) absent.push(n); else if (!E.analyze(c).roles[role]) missing.push(n); }
  assert(!missing.length, role + ': ' + (list.length - absent.length) + ' staples tagged' + (missing.length ? '; missing ' + missing.join(', ') : '') + (absent.length ? ' (not in data: ' + absent.join(', ') + ')' : ''));
}
const top = db.all.filter(c => c.leg === 'legal' && c.rank && c.rank <= 500 && !E.analyze(c).isLand);
const bare = top.filter(c => { const a = E.analyze(c); return !Object.keys(a.roles).length && !Object.keys(a.flags).some(k => a.flags[k]); });
assert(bare.length / top.length <= 0.2, 'EDHREC top 500: ' + bare.length + ' of ' + top.length + ' nonland cards (' + Math.round(100 * bare.length / top.length) + '%) have no role or flag; limit 20%');
// Deck › Counts categories: the removal role splits into spot removal and counterspells; tutors and lands are counted too
{
  const An = require('./analysis.js');
  const CASES = { removal: ['Swords to Plowshares', 'Beast Within', 'Lightning Bolt'], counters: ['Counterspell', 'Swan Song', 'Negate', 'Red Elemental Blast'], tutors: ['Demonic Tutor', 'Vampiric Tutor', 'Enlightened Tutor'], lands: ['Command Tower', 'Forest'] };
  const deck = Object.values(CASES).flat().map(n => ({ c: E.lookup(db, n), qty: 1 })).filter(e => e.c), rc = An.roleCounts(deck);
  for (const [k, list] of Object.entries(CASES)) {
    const got = new Set(rc[k].cards.map(c => c.n)), miss = list.filter(n => E.lookup(db, n) && !got.has(E.lookup(db, n).n));
    assert(!miss.length, 'counts ' + k + ': ' + list.length + ' cards' + (miss.length ? '; missing ' + miss.join(', ') : ''));
  }
  const pure = ['Counterspell', 'Negate'].map(n => E.lookup(db, n)).filter(Boolean);
  assert(pure.every(c => !rc.removal.cards.includes(c)), 'counts: pure counterspells are not spot removal');
  assert([0, 1, 2, 3, 4, 5].every(b => An.ROLE_RANGES[b] && An.COUNT_CATS.every(([k]) => An.ROLE_RANGES[b][k][0] <= An.ROLE_RANGES[b][k][2])), 'counts: reference ranges for every bracket and category');
}
// a name shared by a real card and a playtest or Un card (Mystery Booster 2's Pick Your Poison, Dragon Egg) looks up the Commander-legal one
{
  const shared = new Map(); for (const c of db.all) { const k = c.n.toLowerCase(); shared.set(k, (shared.get(k) || []).concat(c)); }
  const wrong = [...shared.values()].filter(l => l.length > 1 && l.some(c => c.leg === 'legal') && E.lookup(db, l[0].n).leg !== 'legal').map(l => l[0].n);
  assert(E.lookup(db, 'Pick Your Poison').leg === 'legal' && !wrong.length, 'shared names look up the legal card' + (wrong.length ? '; wrong: ' + wrong.slice(0, 10).join(', ') : ''));
}
// regressions from the once-over audit: bracket markers, tutor and draw tags, split and MDFC costs, import edge cases
{
  const An = require('./analysis.js'), fl = (n, f) => !!E.analyze(E.lookup(db, n)).flags[f], role = (n, r) => !!E.analyze(E.lookup(db, n)).roles[r];
  assert(['Jokulhaups', 'Global Ruin', 'Winter Orb', 'Static Orb', 'Blood Moon', 'Cataclysm', 'Armageddon'].every(n => fl(n, 'mld')) && !fl('Elspeth Tirel', 'mld') && !fl('Cataclysmic Gearhulk', 'mld'), 'mld: land destruction, Orbs and Blood Moon flagged; "except lands" and nonland choices not');
  assert(['Beseech the Queen', 'Finale of Devastation', 'Demonic Tutor'].every(n => fl(n, 'tutor')) && !['Cultivate', 'Scapeshift', 'Path to Exile', 'Farseek'].some(n => fl(n, 'tutor')), 'tutor: card tutors flagged, land searches not');
  assert(['Fact or Fiction', 'Dig Through Time', 'Necropotence', 'Ad Nauseam'].every(n => role(n, 'draw')) && !role('Impulse', 'draw'), 'draw: card selection that keeps 2+ cards and life-for-cards engines');
  const P = t => An.pickCommanders(An.parseDecklist(t), db), cn = K => K.cmds.map(c => c.n).join(' + ');
  assert(cn(P("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1x Sol Ring [Commander Staples]\n1 Arcane Signet #commander-staple")) === "Atraxa, Praetors' Voice", 'import: a "Commander …" category or tag does not make a commander');
  assert(cn(P("Commander\n1 Atraxa, Praetors' Voice\n1 Sol Ring\n30 Forest")) === "Atraxa, Praetors' Voice", 'import: a Commander header without a blank line keeps the rest in the deck');
  assert(cn(P("Commander: Atraxa, Praetors' Voice\n1 Sol Ring")) === "Atraxa, Praetors' Voice", 'import: "Commander: Name" on one line');
  const csv = An.parseDecklist('sep=,\nQuantity,Card Name,Tags\n1,Burning Wish,Wishes\n2,Sol Ring,\n1,Opt,Maybeboard');
  assert(csv.main.map(x => x.name).join('|') === 'Burning Wish|Sol Ring' && csv.skipped === 1, 'import: CSV with "Card Name" and sep= line, whole-word board tags, skipped cards counted');
  assert(An.parseDecklist('Quantity,Name of card\n1,Sol Ring').error, 'import: a CSV with no name column says so');
  const v = E.spellbookVariants({ cards: ["Thassa's Oracle", 'Demonic Consultation'], features: ['Win the game'], templates: [] }, [[1, [0, 1], [0], [], 'UB', 0, '', 1, 0]], db);
  assert(v.length === 1 && v[0].inf, "combos: a two-card win (Thassa's Oracle + Demonic Consultation) counts as a two-card infinite for the brackets");
  const isl = { c: E.lookup(db, 'Island'), qty: 36 }, X1 = An.run(db, [isl, { c: E.lookup(db, 'Sea Gate Restoration'), qty: 4 }, { c: E.lookup(db, 'Fire // Ice'), qty: 1 }], [E.lookup(db, 'Talrand, Sky Summoner')], { games: 500 });
  assert(X1.nLands === 40 && Math.abs(X1.avgMV - 2) < 1e-9, 'analysis: an MDFC land counts as a land; a split card costs its cheaper half');
}
