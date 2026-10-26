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
