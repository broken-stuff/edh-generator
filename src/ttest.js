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
