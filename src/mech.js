/* ===== Mech: card abilities parsed from Oracle text, and the synergy graph between cards (pure; uses Engine) ===== */
// Each card is split into abilities (triggered, activated, static/spell). Each ability is read into tags:
//   needs: what the card triggers on, pays as a cost, or counts (e.g. 'creature.dies', 'fodder.creature', 'count.creature')
//   makes: what its effects produce (e.g. 'token.creature', 'mana', 'card', 'counter') and the events those effects cause
// Two cards are linked when one makes what the other needs; the link weight is the product of both tags' weights.
// Self-references ("this creature", the card's name, "~") are normalised to "~". Reminder text in parentheses is dropped.
const Mech = (function () {
  'use strict';
  const E = (typeof Engine !== 'undefined') ? Engine : require('./engine.js');

  /* ---------- text ---------- */
  const SELF = /\b(?:this (?:creature|artifact|enchantment|land|permanent|spell|card|planeswalker|vehicle|equipment|aura|saga|battle|siege|class|case|room))\b/g;
  function norm(c) {
    let t = (c.low || '').replace(/\([^)]*\)/g, '').replace(SELF, '~');
    const nm = (c.n || '').toLowerCase().split(' // ');
    for (const n of nm) if (n.length > 2) { t = t.split(n).join('~'); const first = n.split(',')[0]; if (first.length > 3 && first !== n) t = t.split(first).join('~'); }
    return t;
  }
  // abilities: one per line; modal bullets join the line above
  function split(t) {
    const out = [];
    for (const raw of t.split('\n')) { const l = raw.trim(); if (!l) continue; if (/^•/.test(l) && out.length) out[out.length - 1] += ' ' + l.slice(1); else out.push(l); }
    return out;
  }

  /* ---------- vocabulary ---------- */
  // [tag, regex, weight]; a clause can match several
  const YOU = "(?:you control |under your control )?";
  const EVENTS = [ // trigger condition → needs
    ['self.enters', /^~ enters|^~ is turned face up|^~ or another [^,]* enters/, 1],
    ['creature.enters', new RegExp('(?:a|an|another|one or more|each) (?:nontoken |non-human |other )?(?:[a-z]+ )?creatures? ' + YOU + '(?:enter|enters)'), 1],
    ['token.enters', /tokens? (?:you control )?(?:enters?|you control enter)|you create (?:one or more |a )?(?:[a-z ]+ )?tokens?/, 1],
    ['land.enters', /lands? (?:you control )?enters?|landfall/, 1],
    ['artifact.enters', /artifacts? (?:you control )?enters?|you create (?:one or more |a )?(?:[a-z]+ )?artifact tokens?/, 1],
    ['enchantment.enters', /enchantments? (?:you control )?enters?/, 1],
    ['self.dies', /^~ dies|^~ is put into a graveyard from the battlefield|^~ or another creature dies/, 1],
    ['creature.dies', /creatures? (?:you control |an opponent controls |card )?(?:other than ~ )?(?:dies|die)|creature (?:card )?is put into (?:a|your|an opponent's) graveyard from the battlefield|another creature dies|creature you control dies/, 1],
    ['artifact.dies', /artifacts? (?:you control )?(?:is|are) put into a graveyard from the battlefield|you sacrifice (?:an|one or more) artifacts?/, 1],
    ['sacrifice', /you sacrifice (?:a|an|one or more|another)/, 1],
    ['self.leaves', /^~ leaves the battlefield/, 0.5],
    ['spell.noncreature', /casts? (?:(?:a|an|your (?:first|second)|their (?:first|second)) )?(?:instant or sorcery|noncreature|instant|sorcery|kicked|multicolored)(?: or [a-z]+)? spell|cast or copy an instant or sorcery|magecraft/, 1],
    ['spell.creature', /casts? (?:a|an) (?:[a-z]+ )?creature spell/, 1],
    ['spell.any', /casts? (?:(?:a|your (?:first|second)|their (?:first|second)) )?spell|casts? (?:a|an) (?:historic|artifact|enchantment|legendary|colorless|multicolored|white|blue|black|red|green) spell/, 0.8],
    ['self.cast', /^(?:when )?you cast (?:~|this spell)/, 0.5],
    ['attack', /attacks?\b|attack with/, 0.6],
    ['damage.player', /deals? combat damage to (?:a player|an opponent|one or more players|that player)/, 0.8],
    ['card.draw', /you draw (?:a|your second|one or more) cards?|draws? (?:a|your second) card each turn/, 1],
    ['discard', /(?:you )?discards? (?:a|one or more) cards?|cycle or discard/, 1],
    ['gy.enter', /cards? (?:are|is) put into (?:your|an opponent's|a) graveyard|cards? leave your graveyard|mill/, 1],
    ['life.gain', /you gain life|gain life for the first time/, 1],
    ['life.loss', /(?:an )?opponents? loses? life|loses life/, 0.8],
    ['counter.placed', /counters? (?:is|are) put on|put one or more (?:[+-]1\/[+-]1 )?counters|counters on (?:it|~) (?:is|are)/, 1],
    ['tapped', /becomes tapped|you tap an untapped|tap an untapped/, 0.5],
    ['mana.tapped', /tap (?:a|an|another)? ?(?:nonland |untapped )?(?:permanent|land|artifact|creature|[a-z]+)s? for (?:mana|\{)/, 1],
    ['ability.activated', /you activate an ability|activate an ability that isn't a mana ability/, 1],
    ['opp.draw', /(?:an|each) opponent draws (?:a|their)|a player draws a card/, 1],
    ['damage.dealt', /deals (?:combat )?damage(?: to (?:an opponent|a player|one or more))?|is dealt damage/, 0.8],
    ['creature.damaged', /a creature is dealt damage|is dealt damage/, 0.8],
    ['targeted', /becomes the target/, 0.6],
    ['upkeep', /beginning of (?:your|each) upkeep/, 0.3],
    ['end', /beginning of (?:your|each) end step/, 0.3],
    ['combat', /beginning of combat/, 0.3]
  ];
  const EFFECTS = [ // effect → makes
    ['mana', /\badd (?:\{|one|two|three|x |an amount|that much|mana)|adds? an additional|spells? (?:you cast )?costs? \{\d\} less|costs? \{\d\} less to cast/, 1],
    ['card', /\bdraws? (?:a|an|one|two|three|four|five|x|that many|cards?|seven)|exile the top [^.]* you may (?:play|cast) (?:it|them|that card)|put (?:it|that card|those cards|one of them|them) into your hand/, 1],
    ['token.creature', /create[^.]*creature tokens?|create[^.]*tokens? that'?s? (?:a )?cop(?:y|ies)|tokens that are copies|create (?:a|x|that many|[a-z]+) [^.]*\d+\/\d+[^.]*tokens?|amass|populate|afterlife/, 1],
    ['token.copy', /create[^.]*tokens? that'?s? (?:a )?cop(?:y|ies)|tokens that are copies|create a copy of/, 1],
    ['card.opp', /(?:target player|each player|each opponent|that player|target opponent) draws/, 1],
    ['library.exile', /exile (?:the top [^.]*of )?your library|until you reveal a card with the chosen name|exile[^.]*cards? from the top of your library[^.]*repeat/, 1],
    ['token.treasure', /create[^.]*treasure tokens?|create (?:a|x|that many|two|three) gold tokens?/, 1],
    ['token.artifact', /create[^.]*(?:treasure|clue|food|blood|map|powerstone|gold|incubator|junk|artifact)[^.]*tokens?|investigate/, 1],
    ['counter', /put[^.]*counters? on|proliferate|enters with[^.]*counters?|bolster|adapt|support|amass|incubate/, 1],
    ['life', /\bgains? (?:\d+|x|that much|life equal|twice|life)|double (?:target player's|your) life total|(?:has|have|gains?) lifelink/, 1],
    ['drain', /(?:each opponent|target player|target opponent|that player|defending player) loses (?:\d+|x|that much|life)|\bloses? (?:half|\d+|x|that much)[^.]* life/, 1],
    ['damage', /deals (?:\d+|x|that much|damage equal)[^.]*damage/, 0.6],
    ['gy.fill', /\bmill|put the top [^.]* into your graveyard|surveil|you may discard|discard (?:a|two|x|your hand|that many)|dredge/, 1],
    ['reanimate', /return[^.]*from (?:your|a) graveyard to the battlefield|return enchanted creature card to the battlefield|put[^.]*from (?:your|a) graveyard onto the battlefield/, 1],
    ['regrowth', /return[^.]*from your graveyard to your hand/, 1],
    ['cast.gy', /(?:cast|play)[^.]*from your graveyard/, 1],
    ['blink', /exile [^.]*(?:\. |, then )return (?:it|that card|them|those cards|the exiled card)[^.]* to the battlefield|exile (?:target|another|up to)[^.]*creature[^.]*return[^.]*battlefield/, 1],
    ['bounce.own', /return (?:target |a |another )?(?:creature|permanent|nonland permanent)s? you control to (?:its|their) owner'?s?'? hand/, 0.6],
    ['land.drop', /(?:put|puts) (?:a|up to \w+|that|those|x|any number of)? ?(?:basic )?lands? cards?[^.]* onto the battlefield|play an additional land|play (?:up to )?(?:two|three) additional lands|search your library for [^.]*lands? cards?[^.]*(?:onto|put (?:it|them) onto) the battlefield/, 1],
    ['untap', /\buntap (?:target|all|each|another|up to|~|it|those|that|x|two)|\{q\}/, 1],
    ['deathtouch', /(?:has|have|gains?) deathtouch/, 0.8],
    ['tutor', /search your library for (?:a|an|up to \w+|any number of|x)? ?(?!basic land|land|[a-z]* ?land card)(?:[a-z ]*)card/, 1],
    ['extra.combat', /additional combat phase/, 1],
    ['extra.turn', /extra turn/, 1],
    ['copy', /copy (?:target|that|it|the next)[^.]*(?:spell|ability)|copy (?:target|that) (?:instant|sorcery)/, 1],
    ['sac.outlet', /sacrifice (?:a|an|another|any number of|x) (?:other )?(?:nontoken |non-[a-z]+ )?(?:creatures?|permanents?|artifacts?)(?! (?:an opponent|they|that player))/, 0.6],
    ['edict', /(?:each opponent|target player|target opponent|each player) sacrifices/, 0.6],
    ['removal', /destroy target|exile target (?:creature|artifact|enchantment|nonland|permanent|planeswalker)|deals \d+ damage to (?:target|any target)|return target (?:creature|nonland permanent|permanent)[^.]* to (?:its|their) owner's hand|counter target/, 0.5],
    ['wipe', /destroy all|exile all (?:creatures|nonland|permanents)|each creature gets -|deals \d+ damage to each creature|all creatures get -/, 1],
    ['anthem', /creatures you control get \+|other [a-z ]*creatures you control get \+|creature tokens you control get \+/, 1],
    ['evasion', /creatures you control (?:gain|have) (?:flying|trample|menace|unblockable)|can't be blocked/, 0.4],
    ['free.cast', /without paying (?:its|their) mana costs?/, 1],
    ['top', /\bscry|look at the top|surveil|reveal the top/, 0.4],
    ['haste', /(?:creatures you control |it |they )?(?:gain|have|has) haste/, 0.4],
    ['protect', /(?:gain|have|has) (?:hexproof|indestructible|shroud|protection)|phase out/, 0.4],
    ['discard.opp', /(?:each opponent|target player|target opponent|each player) discards/, 0.6]
  ];
  const COSTS = [ // activated-ability cost → needs
    ['fodder.creature', /sacrifice (?:a|an|another|two|x|one or more) (?:other )?(?:nontoken )?(?:[a-z]+ )?creatures?/, 1],
    ['fodder.artifact', /sacrifice (?:a|an|another|two|x) (?:other )?(?:nontoken )?artifacts?|sacrifice (?:a|an) (?:treasure|clue|food|blood)/, 1],
    ['fodder.land', /sacrifice (?:a|an|another) lands?/, 0.6],
    ['fodder.permanent', /sacrifice (?:a|an|another) (?:nonland )?permanents?/, 1],
    ['fodder.self', /sacrifice ~/, 0.2],
    ['fodder.creature', /exile (?:a|another) creature you control/, 1],
    ['discard', /\bdiscard/, 0.6],
    ['life', /pay \d+ life|pay x life/, 0.3],
    ['counter.remove', /remove[^:]*counters?/, 0.8],
    ['gy.cards', /exile[^:]*from your graveyard/, 1],
    ['untap.self', /\{t\}/, 0.6],
    ['tap.creatures', /tap (?:an?|two|three|four|five|x|one or more) untapped (?:[a-z]+ )?creatures?(?: you control)?/, 1],
    ['tap.artifacts', /tap (?:an?|two|three|x) untapped artifacts?/, 1],
    ['mana.sink', /\{x\}|\{[4-9]\}|\{1\d\}/, 0.4],
    ['untap.self', /\{q\}/, 0.3]
  ];
  const COUNTS = [ // static scaling or condition → needs (go-wide, graveyard size, etc.)
    ['count.creature', /for each (?:other )?(?:[a-z]+ )?creatures? (?:you control|on the battlefield)|number of (?:[a-z]+ )?creatures (?:you control|on the battlefield)|equal to the number of creatures|convoke|you control (?:three|four|five|seven|ten) or more creatures/, 1],
    ['count.artifact', /for each artifact|number of artifacts|affinity for artifacts|improvise|metalcraft|you control (?:three|five) or more artifacts/, 1],
    ['count.enchantment', /for each enchantment|number of enchantments|constellation/, 1],
    ['count.land', /for each land you control|number of lands you control|equal to the number of lands/, 0.6],
    ['gy.cards', /cards? in your graveyard|for each (?:[a-z]+ )?card in your graveyard|threshold|delirium|descend|escape|delve|flashback|unearth|embalm|eternalize|disturb|encore|scavenge|jump-start|retrace|aftermath/, 1],
    ['count.counter', /for each [^.]*counter|number of [^.]*counters|with (?:a|one or more) [+-]1\/[+-]1 counters? on (?:it|them)/, 1],
    ['count.spell', /for each (?:instant(?: and|,| or) sorcery|noncreature)|storm|number of instant and sorcery cards/, 1],
    ['count.hand', /cards? in your hand|no cards in hand|maximum hand size/, 0.6],
    ['life.total', /life total|you have \d+ or more life/, 0.5],
    ['amp.token', /would create one or more tokens|create twice that many|tokens? (?:would be )?created[^.]*instead|creates? that many plus one/, 1],
    ['amp.counter', /would (?:put|be put) one or more counters|twice that many (?:of those )?counters|that many plus one [^.]*counters/, 1],
    ['amp.life', /if you would gain life|gain twice that much/, 1],
    ['amp.mill', /would mill/, 1],
    ['amp.damage', /would deal (?:noncombat )?damage|deals? double that damage|twice that much damage|would lose life[^.]*(?:twice|double)/, 1],
    ['library.small', /number of cards in your library|no cards in your library|library has no cards|draw a card while your library|cards in your library/, 1],
    ['amp.trigger', /triggers? an additional time/, 1],
    ['amp.etb', /entering the battlefield causes a triggered ability/, 1],
    ['mana.sink', /\{x\}[^.]*(?:deals x|draw x|create x|x target)|spend this mana/, 0.3]
  ];
  // keywords Scryfall lists that carry a mechanic but whose text is reminder-only
  const KW = {
    convoke: ['needs', 'count.creature'], improvise: ['needs', 'count.artifact'], delve: ['needs', 'gy.cards'], flashback: ['needs', 'gy.cards'],
    escape: ['needs', 'gy.cards'], unearth: ['makes', 'self.reenter'], embalm: ['makes', 'token.creature'], eternalize: ['makes', 'token.creature'],
    afterlife: ['makes', 'token.creature'], persist: ['makes', 'self.reenter'], undying: ['makes', 'self.reenter'], proliferate: ['makes', 'counter'],
    investigate: ['makes', 'token.artifact'], populate: ['makes', 'token.creature'], amass: ['makes', 'token.creature'], fabricate: ['makes', 'counter'],
    exploit: ['needs', 'fodder.creature'], devour: ['needs', 'fodder.creature'], emerge: ['needs', 'fodder.creature'], casualty: ['needs', 'fodder.creature'],
    storm: ['needs', 'count.spell'], cascade: ['makes', 'free.cast'], prowess: ['needs', 'spell.noncreature'], 'jump-start': ['needs', 'gy.cards'],
    retrace: ['needs', 'gy.cards'], dredge: ['makes', 'gy.fill'], cycling: ['makes', 'card'], connive: ['makes', 'gy.fill'], explore: ['makes', 'counter'],
    mentor: ['makes', 'counter'], training: ['needs', 'attack'], evolve: ['needs', 'creature.enters'], modular: ['makes', 'counter'], riot: ['makes', 'counter'],
    adapt: ['makes', 'counter'], bolster: ['makes', 'counter'], incubate: ['makes', 'token.artifact'], 'living weapon': ['makes', 'token.creature'],
    affinity: ['needs', 'count.artifact'], metalcraft: ['needs', 'count.artifact'], landfall: ['needs', 'land.enters'], 'for mirrodin!': ['makes', 'token.creature'],
    magecraft: ['needs', 'spell.noncreature'], constellation: ['needs', 'enchantment.enters'], threshold: ['needs', 'gy.cards'], delirium: ['needs', 'gy.cards'],
    mill: ['makes', 'gy.fill'], surveil: ['makes', 'gy.fill'], scry: ['makes', 'top'], treasure: ['makes', 'token.artifact'], blitz: ['makes', 'self.dies']
  };
  // what each produced tag also causes, as an event other cards can need
  const CAUSES = {
    'token.creature': ['creature.enters', 'token.enters', 'fodder.creature', 'fodder.permanent', 'count.creature', 'tap.creatures'],
    'token.treasure': ['mana', 'artifact.enters', 'token.enters', 'fodder.artifact', 'count.artifact', 'artifact.dies'],
    'token.artifact': ['artifact.enters', 'token.enters', 'fodder.artifact', 'fodder.permanent', 'count.artifact', 'tap.artifacts', 'artifact.dies'],
    'sac.outlet': ['creature.dies', 'self.dies', 'sacrifice', 'artifact.dies'], wipe: ['creature.dies', 'self.dies', 'creature.damaged'], edict: ['creature.dies'],
    counter: ['counter.placed', 'count.counter', 'counter.remove'], card: ['card.draw', 'count.hand'], life: ['life.gain', 'life.total'],
    drain: ['life.loss'], damage: ['life.loss', 'creature.damaged', 'damage.dealt'], deathtouch: ['deathtouch'], 'card.opp': ['opp.draw'], 'library.exile': ['library.small'],
    'token.copy': ['self.reenter', 'creature.enters', 'token.enters', 'fodder.creature', 'count.creature'], 'gy.fill': ['gy.enter', 'gy.cards', 'discard'], reanimate: ['creature.enters', 'self.reenter'], blink: ['creature.enters', 'self.reenter', 'self.enters', 'self.leaves'],
    'bounce.own': ['self.reenter'], 'mana.tap': ['mana.tapped'], activation: ['ability.activated'], 'land.drop': ['land.enters', 'count.land'], 'extra.combat': ['attack', 'damage.player', 'combat'], copy: ['spell.noncreature', 'spell.any'],
    'free.cast': ['spell.any'], mana: ['mana.sink'], untap: ['untap.self'], 'discard.opp': [], 'cast.gy': ['spell.any', 'fodder.creature', 'creature.enters'], regrowth: [], haste: ['attack']
  };
  // needs that a card meets just by being a card of a type (weak: many cards qualify)
  const TYPE_MAKES = [
    [c => /\bCreature\b/.test(c.ft), [['creature.enters', 0.15], ['fodder.creature', 0.15], ['count.creature', 0.1], ['creature.dies', 0.05]]],
    [c => /\bArtifact\b/.test(c.ft), [['artifact.enters', 0.15], ['fodder.artifact', 0.15], ['count.artifact', 0.15]]],
    [c => /\bEnchantment\b/.test(c.ft), [['enchantment.enters', 0.15], ['count.enchantment', 0.15]]],
    [c => /\b(?:Instant|Sorcery)\b/.test(c.ft), [['spell.noncreature', 0.2], ['spell.any', 0.1], ['count.spell', 0.1]]],
    [c => !/\bLand\b/.test(c.ft) && c.cmc <= 1, [['spell.any', 0.7]]],
    [c => !/\b(?:Land|Creature)\b/.test(c.ft) && c.cmc <= 1, [['spell.noncreature', 0.5]]],
    [c => /\bLand\b/.test(c.ft) && !/\bBasic\b/.test(c.ft), [['land.enters', 0.05]]]
  ];
  // needs that only matter with other cards: a card that needs 'self.enters' wants blink/reanimate, etc.
  const SELF_NEEDS = { 'self.enters': 'self.reenter', 'self.dies': 'sacrifice-of-self' };

  /* ---------- parse ---------- */
  const PC = new WeakMap();
  function parse(c) {
    let P = PC.get(c); if (P) return P;
    const t = norm(c), abil = [], needs = new Map(), makes = new Map();
    const add = (m, k, w) => { if ((m.get(k) || 0) < w) m.set(k, w); };
    const scan = (txt, table, m, hits) => { for (const [k, re, w] of table) if (re.test(txt)) { add(m, k, w); hits.push(k); } };
    for (const line of split(t)) {
      const a = { text: line, kind: 'static', needs: [], makes: [] };
      let m;
      if ((m = line.match(/^(?:[a-z' ,!-]+ — )?(whenever|when|at) (.+?), (.+)$/))) {
        a.kind = 'trigger'; scan(m[2], EVENTS, needs, a.needs);
        if (/^~ /.test(m[2]) && /attacks|deals combat damage/.test(m[2])) add(needs, 'evasion', 0.3);
        scan(m[3], EFFECTS, makes, a.makes); scan(m[3], COUNTS, needs, a.needs);
      } else if ((m = line.match(/^([^:"]{1,140}?):\s+(.+)$/)) && /\{|sacrifice|discard|pay|remove|exile|tap|^[+−-]\d|^0$/.test(m[1])) {
        a.kind = 'activated'; scan(m[1], COSTS, needs, a.needs);
        scan(m[2], EFFECTS, makes, a.makes); scan(m[2], COUNTS, needs, a.needs);
        const tapMana = /\{t\}/.test(m[1]) && /^add /.test(m[2]);
        if (tapMana) { add(needs, 'untap.self', 1); add(makes, 'mana.tap', 1); } else if (!/^[+−-]?\d+$/.test(m[1])) add(makes, 'activation', 0.6);
      } else {
        scan(line, EFFECTS, makes, a.makes); scan(line, COUNTS, needs, a.needs);
        for (const q of line.match(/"(?:whenever|when|at) [^"]+"/g) || []) { const qm = q.slice(1, -1).match(/^(?:whenever|when|at) (.+?), (.+)$/); if (qm) scan(qm[1], EVENTS, needs, a.needs); }
        if (/^(?:as an additional cost|additional cost)[^.]*sacrifice (?:a|an) creature/.test(line)) { add(needs, 'fodder.creature', 1); a.needs.push('fodder.creature'); }
      }
      for (const q of line.slice(1).match(/(?:whenever|when) [^,"]+,/g) || []) scan(q, EVENTS, needs, a.needs); // "until end of turn, whenever …" and granted abilities
      for (const q of line.match(/"[^"]*\{[^"]*:[^"]*"/g) || []) { const qm = q.slice(1, -1).match(/^([^:]{1,80}):\s+(.+)$/); if (qm) { scan(qm[1], COSTS, needs, a.needs); scan(qm[2], EFFECTS, makes, a.makes); } }
      if (a.kind === 'activated' && /deals \d+ damage/.test(line)) add(needs, 'deathtouch', 0.6);
      if (a.needs.length || a.makes.length) abil.push(a);
    }
    for (const k of c.kw || []) { const r = KW[k]; if (r) { add(r[0] === 'needs' ? needs : makes, r[1], 1); } }
    // a creature or artifact with a "when ~ enters" ability needs re-entry (blink, reanimation, bounce)
    if (needs.has('self.enters')) add(needs, 'self.reenter', needs.get('self.enters'));
    if (/\b(?:Instant|Sorcery)\b/.test(c.ft)) add(needs, 'copy', makes.has('mana') || makes.has('card.opp') || makes.has('token.copy') ? 1 : 0.3);
    if (needs.has('self.dies')) add(needs, 'sac.outlet.any', 0.6);
    // effects cause events
    const causes = new Map();
    for (const [k, w] of makes) for (const e of CAUSES[k] || []) add(causes, e, w);
    for (const [pred, list] of TYPE_MAKES) if (pred(c)) for (const [e, w] of list) add(causes, e, w);
    if (makes.has('sac.outlet')) add(causes, 'sac.outlet.any', makes.get('sac.outlet'));
    if (needs.has('fodder.creature') || needs.has('fodder.permanent') || needs.has('fodder.artifact')) { add(causes, 'sac.outlet.any', 0.8); add(causes, 'creature.dies', needs.has('fodder.creature') ? 0.8 : 0.3); add(causes, 'sacrifice', 0.8); }
    for (const k of ['amp.token']) if (needs.has(k)) add(causes, 'token.creature', 0.3);
    P = { abil, needs, makes, causes, parsed: abil.length > 0 || [...needs.keys()].length > 0 || [...makes.keys()].length > 0 };
    PC.set(c, P); return P;
  }
  // amplifiers need the thing they amplify
  const AMP = { 'amp.mill': ['gy.fill'], 'amp.damage': ['damage', 'drain'], 'amp.token': ['token.creature', 'token.artifact'], 'amp.counter': ['counter'], 'amp.life': ['life'], 'amp.trigger': ['creature.enters', 'self.reenter'], 'amp.etb': ['creature.enters', 'self.reenter'] };
  // B's needs met by A: A.makes (direct) or A.causes (events)
  function link(a, b) {
    const A = parse(a), B = parse(b); let w = 0; const why = [];
    for (const [k, wn] of B.needs) {
      const keys = AMP[k] || [k];
      for (const kk of keys) { const wm = Math.max(A.makes.get(kk) || 0, A.causes.get(kk) || 0); if (wm > 0) { w += wn * wm; why.push(kk); } }
    }
    return { w, why };
  }
  // symmetric synergy between two cards
  function pair(a, b) { const x = link(a, b), y = link(b, a); return { w: x.w + y.w, why: x.why.concat(y.why) }; }
  // the same weight, cached (analysis asks for every pair of a deck on every run)
  const PW = new WeakMap();
  function pairW(a, b) {
    if (a === b) return 0;
    let m = PW.get(a); if (m && m.has(b)) return m.get(b);
    const w = pair(a, b).w;
    if (!m) PW.set(a, m = new Map()); m.set(b, w);
    let n = PW.get(b); if (!n) PW.set(b, n = new Map()); n.set(a, w);
    return w;
  }
  const LINK = 0.5; // pair weight at which two cards count as linked (Spellbook 2-card combos: 45.5% linked, random pairs of combo cards 12.3%)
  // each card's links to the rest of a list; minW drops weak type-only links
  function graph(cards, minW) {
    minW = minW == null ? 0.25 : minW;
    const n = cards.length, deg = new Float64Array(n), edges = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const p = pair(cards[i], cards[j]); if (p.w >= minW) { deg[i] += p.w; deg[j] += p.w; edges.push([i, j, p.w, p.why]); } }
    return { deg, edges };
  }

  /* ---------- deck profile: fast links for any card against a list (O(tags) per card) ---------- */
  // supply(c): what c makes or causes; S[k] = Σ supply over the list, N[k] = Σ needs over the list.
  // links(c) = Σ_k min(CAP, need_c(k) · S[k]) + Σ_k min(CAP, supply_c(k) · N[k]) (+ the same against the commanders × CMD),
  // minus c's own share when c is in the list. CAP keeps one broad tag (e.g. "creature enters" in a 30-creature deck) from dominating.
  const CAP = 4, CMD = 3;
  function supply(c) { const P = parse(c), m = new Map(P.causes); for (const [k, w] of P.makes) if ((m.get(k) || 0) < w) m.set(k, w); return m; }
  const ampNeeds = new Map(); for (const [k, list] of Object.entries(AMP)) for (const t of list) { if (!ampNeeds.has(t)) ampNeeds.set(t, []); ampNeeds.get(t).push(k); }
  function profile(cards) {
    const S = new Map(), N = new Map(), add = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
    for (const c of cards) { for (const [k, w] of supply(c)) add(S, k, w); for (const [k, w] of parse(c).needs) add(N, k, w); }
    return { S, N };
  }
  function links(c, prof, cmdProf, inList) {
    const P = parse(c), sup = supply(c), why = new Map();
    const own = inList ? { S: sup, N: P.needs } : null;
    const get = (pr, m, k, self) => Math.max(0, (pr[m].get(k) || 0) - (self ? (self[m].get(k) || 0) : 0));
    const side = (pr, self, mult) => {
      let w = 0;
      for (const [k, wn] of P.needs) for (const kk of AMP[k] || [k]) { const v = Math.min(CAP, wn * get(pr, 'S', kk, self)) * mult; if (v > 0) { w += v; why.set('needs ' + kk, (why.get('needs ' + kk) || 0) + v); } }
      for (const [k, ws] of sup) for (const kk of [k].concat(ampNeeds.get(k) || [])) { const v = Math.min(CAP, ws * get(pr, 'N', kk, self)) * mult; if (v > 0) { w += v; why.set('makes ' + k, (why.get('makes ' + k) || 0) + v); } }
      return w;
    };
    const w = side(prof, own, 1) + (cmdProf ? side(cmdProf, null, CMD) : 0);
    return { w, why: [...why].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]) };
  }

  return { parse, link, pair, pairW, LINK, graph, profile, links, supply, norm, split, EVENTS, EFFECTS, COSTS, COUNTS, KW, CAUSES };
})();
if (typeof module !== 'undefined') module.exports = Mech;
