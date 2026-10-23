/* ===== Plan: what a commander asks its deck for, read from its own rules text (pure; uses Engine and Mech) =====
   A plan profile lists the commander's demands and scores every card against them, without popularity:
     keyword   a mechanic the commander has or names (ninjutsu, mutate, goad, offspring, energy …): cards with it or that name it
     type      a creature type named where the commander rewards it ("other Zombies you control", "whenever a Ninja …")
     card type a card type it rewards (instants and sorceries, artifacts, Equipment, Auras, Vehicles, legendaries, lands …)
     stat      a power or mana value bound it names ("power 2 or less", "mana value 5 or greater")
     mechanics a link in the mechanics graph (Mech.pairW) between the card and the commander
   score(c) sums the parts it meets (capped at 1.5); a card scoring 0.5 or more is a plan card. The profile also sets how many
   plan cards the deck should hold (quota) and an average mana value target from the plan cards' own curve. */
const Plan = (function () {
  'use strict';
  const E = (typeof Engine !== 'undefined') ? Engine : require('./engine.js');
  const M = (typeof Mech !== 'undefined') ? Mech : require('./mech.js');
  const PLAN_MIN = 0.5, CAP = 1.5;
  // keywords that every colour plays for their own sake; a commander having one does not make it a plan
  const EVERGREEN = new Set(['flying', 'first strike', 'double strike', 'deathtouch', 'haste', 'hexproof', 'indestructible', 'lifelink', 'menace',
    'reach', 'trample', 'vigilance', 'flash', 'ward', 'equip', 'enchant', 'protection', 'shroud', 'partner', 'partner with', 'friends forever',
    'choose a background', 'transform', 'kicker', 'fight', 'scry', 'mill', 'meld', 'daybound', 'nightbound', 'doctor\'s companion', 'cycling']);
  // ability words printed on commanders for their own sake: other cards with them are other commanders, not plan cards
  const COMMANDER_ONLY = new Set(['eminence', 'lieutenant', 'council\'s dilemma', 'will of the council', 'join forces', 'tempting offer', 'myriad', 'melee']);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // keywords in the card data on 5+ cards, longest first (so "basic landcycling" wins over "landcycling")
  function vocab(db) {
    if (db._kwVocab) return db._kwVocab;
    const n = new Map();
    for (const c of db.all) for (const k of c.kw) n.set(k, (n.get(k) || 0) + 1);
    db._kwVocab = [...n].filter(([k, v]) => v >= 5 && k.length >= 4 && !EVERGREEN.has(k)).map(([k]) => k).sort((a, b) => b.length - a.length);
    return db._kwVocab;
  }
  // card-type demands: [key, label, commander text that rewards it, cards that meet it]
  const CT = [
    ['spells', 'instants and sorceries', /instant (?:and|or) sorcery|instant spells?|sorcery spells?|noncreature spells?|\bmagecraft|whenever you cast your (?:second|first)/, c => /\b(?:Instant|Sorcery)\b/.test(c.ft)],
    ['artifacts', 'artifacts', /artifacts? you control|artifact spells?|whenever (?:an|another|one or more) (?:nontoken )?artifacts?|for each artifact|\bimprovise|affinity for artifacts/, c => /\bArtifact\b/.test(c.ft) || /create[^.]*(?:treasure|clue|food|blood|map|powerstone|gold|junk)[^.]*tokens?/.test(c.low)],
    ['enchantments', 'enchantments', /enchantments? you control|enchantment spells?|whenever (?:an|another) enchantment|\bconstellation|for each enchantment/, c => /\bEnchantment\b/.test(c.ft)],
    ['equipment', 'Equipment', /\bequipment\b|\bequipped\b|\bequip abilit/, c => /\bEquipment\b/.test(c.ft) || /\bequipped creature\b|\bequipment you control/.test(c.low)],
    ['auras', 'Auras', /\bauras?\b|enchanted creatures? you control|enchanted by/, c => /\bAura\b/.test(c.ft) && /enchant creature/.test(c.low)],
    ['vehicles', 'Vehicles', /\bvehicles?\b|\bcrews?\b/, c => /\bVehicle\b/.test(c.ft) || c.kw.includes('crew') || /\bvehicles? you control/.test(c.low)],
    ['legendary', 'legendary and historic', /legendary (?:spells?|creatures? you control|permanents? you control)|\bhistoric\b/, c => /\bLegendary\b/.test(c.ft) || /\b(?:Artifact|Saga)\b/.test(c.ft)],
    ['creatures', 'creature spells', /creature spells? (?:you cast|cost)|whenever you cast a creature spell/, c => /\bCreature\b/.test(c.ft)],
    ['lands', 'lands', /\blandfall|whenever a land (?:you control )?enters|lands? you control|play (?:an|two) additional lands?|land cards? (?:from|in) your graveyard|sacrifice a land/, c => /\bLand\b/.test(c.ft) ? false : /\blandfall|whenever a land|play (?:an|two|x) additional lands?|search your library for [^.]*land cards?[^.]*onto the battlefield|land cards? from your graveyard|sacrifice (?:a|an|another) lands?|return [^.]*lands?[^.]* to (?:its|their) owner/.test(c.low)],
    ['graveyard', 'graveyard', /cards? in your graveyard|from your graveyard|whenever [^.]{0,30}cards? (?:are|is) put into your graveyard|\bmills?\b|\bdescend|\bdelirium|\bthreshold/, c => /\bmills?\b|\bsurveil|from your graveyard|cards? in your graveyard|\bdredge|\bflashback|\bescape|\bunearth|\bdelve|discard (?:a|two|x|your hand)/.test(c.low) || ['flashback', 'escape', 'unearth', 'delve', 'dredge', 'embalm', 'eternalize', 'disturb', 'retrace', 'jump-start'].some(k => c.kw.includes(k))],
    ['tokens', 'tokens', /tokens? you control|whenever you create (?:a|one or more) tokens?|create (?:twice|that many plus)|for each token/, c => /\bcreates? [^.]*tokens?\b|\bpopulate|\bamass|\bincubate|\binvestigate/.test(c.low)],
    ['counters', '+1/+1 counters', /\+1\/\+1 counters? on|for each \+1\/\+1 counter|\bproliferate|whenever one or more \+1\/\+1 counters/, c => /put (?:a|one|two|three|x|that many|\w+) \+1\/\+1 counters?|\bproliferate|enters with [^.]*\+1\/\+1 counters?|\badapt\b|\bbolster|\bsupport\b/.test(c.low) || ['modular', 'riot', 'mentor', 'evolve', 'fabricate', 'outlast', 'graft', 'backup'].some(k => c.kw.includes(k))],
    ['lifegain', 'lifegain', /whenever you gain life|life you gained|you've gained life/, c => /\bgain (?:\d+|x|that much)[^.]*life|\blifelink/.test(c.low) || c.kw.includes('lifelink')],
    ['sacrifice', 'sacrifice and death', /whenever [^.]{0,40}(?:dies|you sacrifice)|sacrifice (?:a|another) creature/, c => /whenever [^.]{0,50}dies|whenever you sacrifice|sacrifice (?:a|another|an?(?: \w+)?) (?:creature|permanent|artifact)[^.:]*:/.test(c.low) || /\bcreates? [^.]*creature tokens?/.test(c.low)],
    ['draw', 'card draw', /whenever you draw|draw your second card/, c => !!E.analyze(c).roles.draw],
    ['attack', 'attacking', /whenever (?:a|an|one or more|another|each) [^.]{0,40}you control attacks?|attacking creatures? you control|whenever you attack|creatures? you control deals? combat damage|attacking causes|creatures you control (?:have|gain) [^.]{0,20}(?:can't be blocked|menace|flying)/, c => /\bCreature\b/.test(c.ft) && (/can't be blocked|\bmenace\b|\bflying\b|\btrample\b/.test(c.low) || ['flying', 'menace', 'trample', 'skulk', 'shadow', 'horsemanship', 'fear', 'intimidate'].some(k => c.kw.includes(k)))],
    ['opponents', 'opponents drawing or losing life', /whenever an opponent (?:draws|loses life)|each opponent draws/, c => /each (?:player|opponent) draws|target player draws|each opponent loses/.test(c.low)]
  ];
  // most card types qualify a card alone at 0.5; broad ones (any creature, any evasive attacker) need a second part
  const CT_W = { creatures: 0.3, attack: 0.35, legendary: 0.35 };
  // creature types the commander rewards (payoff wording), not types it merely mentions
  function typeDemands(db, cmd) {
    const out = [], low = cmd.low;
    for (const T of E.creatureTypes(db)) {
      if (T.length < 3) continue;
      const t = T.toLowerCase();
      const w = '(?:' + esc(t) + '(?:s|es)?|' + esc(t.replace(/f$/, 'ves').replace(/y$/, 'ies')) + ')';
      const pay = new RegExp('(?:other|another|each|target|nontoken|attacking) ' + w + '\\b|\\b' + w + ' (?:you control|spells?|cards?|creatures? you control|get|have|gain)|whenever (?:a|an|another|one or more) (?:nontoken )?' + w + '\\b|for each ' + w + '\\b|choose a creature type');
      if (!pay.test(low)) continue;
      if (/choose a creature type/.test(low) && !new RegExp('\\b' + w + '\\b').test(low)) continue; // changeling-style "choose a type" handled by the type count below
      out.push(T);
    }
    // "choose a creature type" (Kindred lords, Morophon): the commander's own types
    if (/choose a creature type/.test(low)) for (const T of (cmd.ft.split('—')[1] || '').trim().split(/\s+/)) if (T.length >= 3 && !out.includes(T)) out.push(T);
    return out;
  }
  function statDemands(cmd) {
    const out = [], low = cmd.low; let m;
    const re = /(?:with |has |have )?(?:base )?(power|mana value|toughness) (\d+)(?: or (less|greater))?/g;
    while ((m = re.exec(low))) if (m[3] || /with (?:base )?(?:power|toughness) \d/.test(m[0])) out.push({ stat: m[1], n: +m[2], dir: m[3] || 'eq' });
    if (/toughness greater than its power|assigns combat damage equal to its toughness/.test(low)) out.push({ stat: 'tough>pow' });
    return out;
  }
  function meetsStat(c, s) {
    const cr = /\bCreature\b/.test(c.ft);
    if (s.stat === 'power') return cr && c.pow != null && (s.dir === 'less' ? c.pow <= s.n : s.dir === 'eq' ? c.pow === s.n : c.pow >= s.n);
    if (s.stat === 'mana value') return !/\bLand\b/.test(c.ft) && (s.dir === 'less' ? c.cmc <= s.n : c.cmc >= s.n);
    if (s.stat === 'tough>pow') { const m = /^(\d+)\/(\d+)$/.exec(c.pt || ''); return cr && (c.kw.includes('defender') || (m && +m[2] > +m[1])); }
    return false;
  }
  function keywordDemands(db, cmd) {
    const out = new Set(), low = cmd.low;
    for (const k of cmd.kw) if (!EVERGREEN.has(k) && !COMMANDER_ONLY.has(k)) out.add(k);
    // an evergreen keyword counts when the commander rewards it ("creatures you control with flying", "have deathtouch")
    for (const k of EVERGREEN) if (k.length >= 4 && new RegExp('(?:creatures?|permanents?|attackers?)(?: you control)? with ' + esc(k) + '\\b|(?:gain|gains|have|has) ' + esc(k) + ' (?:and|until|as long)|each creature you control with ' + esc(k)).test(low)) out.add(k);
    for (const k of vocab(db)) if (!COMMANDER_ONLY.has(k) && new RegExp('\\b' + esc(k) + '\\b').test(low)) out.add(k);
    if (/\{e\}/.test(low) || /energy counters?/.test(low)) out.add('energy');
    return [...out];
  }
  const kwTest = k => k === 'energy' ? (c => /\{e\}|energy counter/.test(c.low)) : (c => c.kw.includes(k) || new RegExp('\\b' + esc(k) + '\\b').test(c.low));

  /* ---------- profile ---------- */
  // cmds: one or two commander cards. pool (optional): candidate cards, used for supply counts, quota and curve.
  function profile(db, cmds, pool) {
    const parts = [];
    const kws = [...new Set(cmds.flatMap(c => keywordDemands(db, c)))];
    for (const k of kws) parts.push({ kind: 'keyword', key: k, label: k, w: 1, test: kwTest(k) });
    for (const T of [...new Set(cmds.flatMap(c => typeDemands(db, c)))]) {
      const re = new RegExp('\\b' + esc(T) + '\\b');
      parts.push({ kind: 'type', key: T, label: T, w: 1, test: c => re.test(c.tl.split('—').slice(1).join(' ')) || c.kw.includes('changeling') || new RegExp('\\b' + esc(T.toLowerCase()) + 's?\\b').test(c.low) });
    }
    for (const [key, label, cre, test] of CT) if (cmds.some(c => cre.test(c.low))) parts.push({ kind: 'cardtype', key, label, w: CT_W[key] || 0.5, test });
    for (const s of cmds.flatMap(statDemands)) parts.push({ kind: 'stat', key: s.stat + (s.n != null ? ' ' + s.n + ' ' + s.dir : ''), label: s.stat === 'tough>pow' ? 'toughness over power' : s.stat + ' ' + s.n + (s.dir === 'eq' ? '' : ' or ' + s.dir), w: 0.5, test: c => meetsStat(c, s) });
    const cache = new Map();
    const mechW = c => { let w = 0; for (const k of cmds) if (k !== c) w = Math.max(w, M.pairW(c, k)); return w; };
    const detail = c => {
      let v = cache.get(c); if (v) return v;
      const hit = []; let s = 0;
      if (!cmds.includes(c) && !E.isBasic(c)) {
        for (const p of parts) if (p.test(c)) { s += p.w; hit.push(p.label); }
        // mechanics graph: nothing below the link threshold (type-only links), then up to 0.6 at pair weight 1.5
        const mw = mechW(c), mp = mw >= M.LINK ? 0.6 * Math.min(1, (mw - 0.25) / 1.25) : 0;
        if (mp > 0) { s += mp; hit.push('mechanics ' + mw.toFixed(1)); }
      }
      v = { s: Math.min(CAP, s), hit }; cache.set(c, v); return v;
    };
    const P = { cmds: cmds.map(c => c.n), parts: parts.map(p => ({ kind: p.kind, key: p.key, label: p.label, w: p.w })), score: c => detail(c).s, why: c => detail(c).hit, isPlan: c => detail(c).s >= PLAN_MIN, PLAN_MIN };
    if (pool) {
      const non = pool.filter(c => !E.analyze(c).isLand);
      const plan = non.filter(P.isPlan);
      P.supply = plan.length;
      P.partSupply = parts.map(p => ({ label: p.label, n: non.filter(p.test).length }));
      // quota: a quarter of the supply, 10–30 cards; a plan with fewer than 10 cards in the pool takes all of them
      P.quota = plan.length < 10 ? plan.length : Math.max(10, Math.min(30, Math.round(plan.length / 4)));
      // curve: the mean mana value of the 40 best plan cards, pulled halfway to 3.0, within 2.2–4.2
      const top = plan.slice().sort((a, b) => detail(b).s - detail(a).s || a.cmc - b.cmc || (a.n < b.n ? -1 : 1)).slice(0, 40);
      const mv = top.length ? top.reduce((s, c) => s + c.cmc, 0) / top.length : 3;
      P.avgMV = Math.round(Math.max(2.2, Math.min(4.2, 0.5 * 3 + 0.5 * mv)) * 10) / 10;
      P.strength = parts.some(p => p.kind !== 'cardtype') ? 'focused' : parts.length ? 'broad' : 'mechanics only';
    }
    return P;
  }
  // one line for the build log and the page
  function summary(P) {
    const by = k => P.parts.filter(p => p.kind === k).map(p => p.label);
    const bits = [];
    if (by('keyword').length) bits.push('mechanics: ' + by('keyword').join(', '));
    if (by('type').length) bits.push('types: ' + by('type').join(', '));
    if (by('cardtype').length) bits.push('card types: ' + by('cardtype').join(', '));
    if (by('stat').length) bits.push('stats: ' + by('stat').join(', '));
    if (!bits.length) bits.push('links in the mechanics graph only');
    return bits.join('; ');
  }

  /* ---------- card quality without popularity ----------
     A logistic model on rules-text features: P(a card is in a human-built deck | it is legal in that deck's colours).
     Weights come from tools/quality-fit.js on data/reference/ (EDHREC average and Archidekt decks); no EDHREC rank or
     other popularity field is a feature, so a card is judged by what it does, and new or unplayed cards score on text. */
  const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, x: 2, that: 2 };
  const QF = [
    ['ramp', c => +!!E.analyze(c).roles.ramp], ['draw', c => +!!E.analyze(c).roles.draw], ['removal', c => +!!E.analyze(c).roles.removal],
    ['wipes', c => +!!E.analyze(c).roles.wipes], ['protection', c => +!!E.analyze(c).roles.protection], ['recursion', c => +!!E.analyze(c).roles.recursion],
    ['wincon', c => +!!E.analyze(c).roles.wincon], ['tutor', c => +!!E.analyze(c).flags.tutor], ['fast', c => +(!!E.analyze(c).flags.fast && !/\{\d\}, \{t\}(?:, sacrifice ~)?: add/.test(c.low))],
    ['gc', c => +!!c.gc], ['stax', c => +!!E.analyze(c).flags.stax],
    ['mv', c => Math.min(10, c.cmc) / 10], ['mv0-2', c => +(c.cmc <= 2)], ['mv6+', c => +(c.cmc >= 6)],
    ['instant', c => +(/\bInstant\b/.test(c.ft) || c.kw.includes('flash'))], ['creature', c => +/\bCreature\b/.test(c.ft)],
    ['artifact', c => +/\bArtifact\b/.test(c.ft)], ['enchantment', c => +/\bEnchantment\b/.test(c.ft)], ['planeswalker', c => +/\bPlaneswalker\b/.test(c.ft)],
    ['sorcery', c => +/\bSorcery\b/.test(c.ft)], ['legendary', c => +/\bLegendary\b/.test(c.ft)],
    ['rate', c => { if (!/\bCreature\b/.test(c.ft) || c.pow == null) return 0; const m = /\/(\d+)$/.exec(c.pt || ''); const t = m ? +m[1] : c.pow; return Math.max(-3, Math.min(3, (c.pow + t) / 2 - c.cmc)) / 3; }],
    ['evasion', c => +c.kw.some(k => ['flying', 'trample', 'menace', 'shroud', 'hexproof', 'indestructible', 'ward'].includes(k))],
    ['repeat', c => +/\b(?:whenever|at the beginning of)\b/.test(c.low) && +/\b(?:Artifact|Creature|Enchantment|Planeswalker|Land|Battle)\b/.test(c.ft)],
    ['activated', c => +/^[^"\n]*\{[^}]+\}[^:\n]*:/m.test(c.low)],
    ['etb', c => +/when ~ enters|when this [a-z]+ enters/.test(c.low)],
    ['cards', c => { const m = c.low.match(/\bdraws? (a|an|one|two|three|four|five|six|seven|x|that) (?:additional )?cards?/); return m ? Math.min(4, NUM[m[1]] || 1) / 4 : 0; }],
    ['wide-removal', c => +/\b(?:destroy|exile) (?:up to one )?target (?:nonland )?permanent|\bexile target (?:artifact or enchantment|nonland permanent)/.test(c.low)],
    ['free', c => +/without paying (?:its|this spell's|their) mana cost|rather than pay (?:this spell's|its) mana cost/.test(c.low)],
    ['reduce', c => +/costs? \{\d\} less|cost \{\d\} less/.test(c.low)],
    ['modal', c => +/choose (?:one|two|one or more|any number)/.test(c.low)],
    ['each-opp', c => +/each opponent/.test(c.low)],
    ['drawback', c => +/\b(?:you lose|sacrifice ~|skip your|discard your hand|enters tapped|at the beginning of your upkeep, sacrifice|you can't)\b/.test(c.low)],
    ['makes', c => Math.min(6, M.parse(c).makes.size) / 6], ['needs', c => Math.min(6, M.parse(c).needs.size) / 6],
    ['abil', c => Math.min(5, M.parse(c).abil.length) / 5], ['text', c => Math.min(600, c.low.length) / 600],
    ['colors', c => (c.ci || '').length / 5], ['vanilla', c => +!c.low.trim()],
    ['rock', c => +(/^\{t\}: add /m.test(c.low) && !/\bLand\b/.test(c.ft))], ['paid-rock', c => +/^\{\d\}, \{t\}: add /m.test(c.low)],
    ['one-shot', c => +/sacrifice ~: add|sacrifice ~[^:]*: add|, sacrifice ~: draw/.test(c.low)], ['sac-self', c => +/sacrifice ~/.test(c.low)],
    ['cantrip', c => +/(?:^|\n|\. )draw a card\.?$/m.test(c.low) && +!/whenever|at the beginning/.test(c.low)],
    ['cheap-removal', c => +(!!E.analyze(c).roles.removal && c.cmc <= 2)], ['cheap-ramp', c => +(!!E.analyze(c).roles.ramp && c.cmc <= 2)],
    ['draw-engine', c => +(!!E.analyze(c).roles.draw && /whenever|at the beginning/.test(c.low))],
    ['counterspell', c => +/counter target (?:spell|noncreature spell)/.test(c.low)], ['tokens', c => +/create[^.]*tokens?/.test(c.low)],
    ['anthem', c => +/creatures you control get \+/.test(c.low)], ['double', c => +/\b(?:twice that many|double)\b/.test(c.low)],
    ['untap', c => +/\buntap (?:all|target|each)/.test(c.low)], ['copy', c => +/\bcopy (?:target|that|it)/.test(c.low)],
    ['restricted', c => +/spend this mana only|activate only as a sorcery|only during your turn/.test(c.low)],
    ['symmetric', c => +/\beach player\b/.test(c.low)], ['you-lose', c => +/\byou lose (?:\d|x)|pay (?:\d|x) life/.test(c.low)]
  ];
  // fitted by tools/quality-fit.js (held-out AUC 0.764; cardPower without rank 0.645; EDHREC rank alone 0.935); order matches QF, last = intercept
  const QW = [1.302, 0.36, 0.003, 0.518, 1.29, 0.768, 0.57, 1.412, 1.023, 2.494, 1.021, -0.644, 0.22, 0.34, 0.312, -0.072, 0.232, 0.147, -1.09, 0.155, 0.571, 0.224, 0.268, 0.219, -0.501, -0.06, 0.412, 1.092, 0.765, 0.574, -0.089, 0.296, -0.295, -0.36, -0.865, 1.451, 0.31, 2.066, -0.845, 0.733, 0.094, -0.018, -0.165, -0.782, 0.562, 0.728, 0.343, 0.723, 0.393, 0.051, 0.725, 0.433, 0.208, -0.331, 0.233, 0.593, -1.251];
  const QC = new WeakMap();
  function features(c) { return QF.map(f => +f[1](c) || 0); }
  // 0–1: the model's probability, or a neutral 0.3 when no weights are loaded
  function quality(c) {
    let v = QC.get(c); if (v != null) return v;
    if (!QW || E.analyze(c).isLand) v = 0.3;
    else { const x = features(c); let z = QW[QW.length - 1]; for (let i = 0; i < x.length; i++) z += QW[i] * x[i]; v = 1 / (1 + Math.exp(-z)); }
    QC.set(c, v); return v;
  }
  return { profile, summary, vocab, quality, features, QF, PLAN_MIN, EVERGREEN };
})();
if (typeof module !== 'undefined') module.exports = Plan;
