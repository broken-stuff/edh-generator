/* ===== Analysis: offline deck evaluation (pure; uses Engine) ===== */
const Analysis = (function () {
  'use strict';
  const E = (typeof Engine !== 'undefined') ? Engine : require('./engine.js');
  const A = c => E.analyze(c);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const ratio = (have, target) => target > 0 ? clamp(have / target, 0, 1) : 1;
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, x: 1 };
  const isPerm = c => /\b(?:Artifact|Creature|Enchantment|Planeswalker|Battle)\b/.test(c.ft) && !/\bLand\b/.test(c.ft);
  const isInstantSpeed = c => /\bInstant\b/.test(c.ft) || c.kw.includes('flash');

  /* ---------- benchmarks (editable defaults; sources noted in UI) ---------- */
  // EDHREC 'Deck of Many Things' (MtGDS, 2022-07-05): mean per deck across EDHREC decklists. Population reference, not a target.
  const POP = { lands: 35.9, ramp: 12.7, draw: 7.6, removal: 8.5, wipes: 2.7, tutors: 3.0, counters: 2.4 };
  const BENCH = { lands: 37, ramp: 10, draw: 10, removal: 9, wipes: 3, protection: 3, recursion: 2, wincon: 3, avgMV: 3.0, engines: 3, cheapInteraction: 6, evasive: 8 };

  /* ---------- enabler / payoff synergy pairs ---------- */
  const PAIRS = E.PAIRS; // shared with the generator (engine.js)

  /* ---------- mana model per card ---------- */
  const MM = new WeakMap();
  function manaModel(c) {
    let m = MM.get(c); if (m) return m;
    const a = A(c), low = c.low;
    m = { land: a.isLand, tapped: false, rampPerm: 0, dork: false, rampLand: 0, extraDrop: 0, perm: isPerm(c) };
    if (a.isLand) {
      m.tapped = /(?:~|this land) enters (?:the battlefield )?tapped/.test(low) && !/unless|you may pay|if you control|if you don't/.test(low);
    } else {
      if (m.perm && a.roles.ramp) {
        const mm = low.match(/\{t\}[^:]*: add ((?:\{[wubrgc]\})+)/);
        if (mm) m.rampPerm = (mm[1].match(/\{/g) || []).length;
        else if (/\{t\}[^:]*: add (?:one|x) mana|\{t\}[^:]*: add [^.]{0,30}mana of any/.test(low)) m.rampPerm = 1;
        else if (/\{t\}[^:]*: add two mana/.test(low)) m.rampPerm = 2;
        m.dork = m.rampPerm > 0 && a.creature;
      }
      if (a.rules.ramp && a.rules.ramp.includes('ramp-land')) {
        const k = low.match(/search your library for (?:up to )?(a|an|one|two|three)\b[^.]*land/);
        m.rampLand = k ? (WORDNUM[k[1]] || 1) : 1;
        if (/put (?:the other|one of them|one) into your hand/.test(low)) m.rampLand = Math.max(1, m.rampLand - 1);
      }
      if (a.rules.ramp && a.rules.ramp.includes('ramp-drop')) m.extraDrop = 1;
    }
    MM.set(c, m); return m;
  }

  /* ---------- probability: hypergeometric ---------- */
  const lf = [0]; for (let i = 1; i <= 200; i++) lf[i] = lf[i - 1] + Math.log(i);
  const lC = (n, k) => k < 0 || k > n ? -Infinity : lf[n] - lf[k] - lf[n - k];
  const hyp = (N, K, n, k) => Math.exp(lC(K, k) + lC(N - K, n - k) - lC(N, n));
  const atLeast = (N, K, n, k) => { let p = 0; for (let i = k; i <= Math.min(n, K); i++) p += hyp(N, K, n, i); return p; };

  /* ---------- goldfish simulation ---------- */
  function simulate(cards, cmds, games, seed) {
    const lib0 = []; for (const e of cards) for (let i = 0; i < e.qty; i++) lib0.push(e.c);
    const N = lib0.length, rng = mulberry32(seed >>> 0);
    const T = 10, mana = new Array(T + 1).fill(0), landsT = new Array(T + 1).fill(0);
    const dropT = new Array(T + 1).fill(0), spentT = new Array(T + 1).fill(0), spellsT = new Array(T + 1).fill(0), handT = new Array(T + 1).fill(0), cmdByT = new Array(T + 1).fill(0);
    const cmdCmc = cmds.length ? Math.min(...cmds.map(c => c.cmc)) : 0;
    let mulls = 0, keep7 = 0, missT4 = 0, spent6 = 0, avail6 = 0, spells6 = 0, cmdOnCurve = 0; const cmdTurns = [];
    let flood = 0, screw = 0;
    const isL = c => manaModel(c).land;
    for (let g = 0; g < games; g++) {
      let lib = lib0.slice();
      const shuffle = () => { for (let i = lib.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = lib[i]; lib[i] = lib[j]; lib[j] = t; } };
      shuffle();
      let hand = lib.slice(0, 7), pos = 7;
      let hl = hand.filter(isL).length;
      if (hl >= 2 && hl <= 5) keep7++;
      else { mulls++; shuffle(); hand = lib.slice(0, 7); pos = 7; } // free first mulligan (Commander)
      let landsUntapped = 0, landsTappedNext = 0, rocks = 0, dorksReady = 0, dorksNext = 0, landsPlayed = 0, cmdCast = false, extraDrops = 0;
      let gSpent = 0, gAvail = 0, gSpells = 0, rampLandsNext = 0;
      for (let t = 1; t <= T; t++) {
        if (t > 1 && pos < lib.length) hand.push(lib[pos++]);
        landsUntapped += landsTappedNext + rampLandsNext; landsTappedNext = 0; rampLandsNext = 0;
        dorksReady += dorksNext; dorksNext = 0;
        let drops = 1 + extraDrops; const before = landsPlayed;
        while (drops > 0) {
          let i = hand.findIndex(c => isL(c) && !manaModel(c).tapped); if (i < 0) i = hand.findIndex(isL);
          if (i < 0) break;
          const c = hand.splice(i, 1)[0]; landsPlayed++; drops--;
          if (manaModel(c).tapped) landsTappedNext++; else landsUntapped++;
        }
        if (landsPlayed > before) dropT[t]++;
        let avail = landsUntapped + rocks + dorksReady;
        mana[t] += avail; landsT[t] += landsUntapped + landsTappedNext;
        let spent = 0;
        // 1) ramp first, cheapest first
        const ramp = hand.filter(c => !isL(c) && (manaModel(c).rampPerm || manaModel(c).rampLand || manaModel(c).extraDrop)).sort((a, b) => a.cmc - b.cmc);
        for (const c of ramp) {
          if (c.cmc > avail - spent) continue;
          spent += c.cmc; hand.splice(hand.indexOf(c), 1); gSpells += t <= 6 ? 1 : 0; spellsT[t]++;
          const m = manaModel(c);
          if (m.rampPerm) { if (m.dork) dorksNext += m.rampPerm; else { rocks += m.rampPerm; avail += m.rampPerm; } }
          if (m.rampLand) rampLandsNext += m.rampLand;
          if (m.extraDrop) extraDrops = Math.max(extraDrops, m.extraDrop);
        }
        // 2) commander
        if (cmds.length && !cmdCast && cmdCmc <= avail - spent) { cmdCast = true; spent += cmdCmc; cmdTurns.push(t); if (t <= Math.max(1, cmdCmc)) cmdOnCurve++; }
        // 3) other spells, largest that fits first
        const rest = hand.filter(c => !isL(c)).sort((a, b) => b.cmc - a.cmc);
        for (const c of rest) { if (c.cmc <= avail - spent) { spent += c.cmc; hand.splice(hand.indexOf(c), 1); if (t <= 6) gSpells++; spellsT[t]++; } }
        spentT[t] += spent; handT[t] += hand.length; if (cmdCast) cmdByT[t]++;
        if (t <= 6) { gSpent += spent; gAvail += avail; }
        if (t === 4 && landsPlayed < 4) missT4++;
        if (t === 6) { const inHandLands = hand.filter(isL).length; if (inHandLands >= 3 && hand.length - inHandLands <= 1) flood++; if (landsPlayed <= 3) screw++; }
      }
      if (!cmdCast) cmdTurns.push(T + 1);
      spent6 += gSpent; avail6 += gAvail; spells6 += gSpells;
    }
    cmdTurns.sort((a, b) => a - b);
    return {
      games, deckSize: N, manaByTurn: mana.map(x => x / games), landsByTurn: landsT.map(x => x / games),
      perTurn: Array.from({ length: T }, (_, i) => { const t = i + 1; return { t, lands: landsT[t] / games, mana: mana[t] / games, spent: spentT[t] / games, spells: spellsT[t] / games, hand: handT[t] / games, pDrop: dropT[t] / games, pCmd: cmdByT[t] / games }; }),
      keep7: keep7 / games, mulligan: mulls / games, missLandDropT4: missT4 / games, flood6: flood / games, screw6: screw / games,
      efficiency6: avail6 ? spent6 / avail6 : 0, spellsBy6: spells6 / games,
      cmdCmc, cmdMedianTurn: cmdTurns.length ? cmdTurns[Math.floor(cmdTurns.length / 2)] : null, cmdOnCurve: cmds.length ? cmdOnCurve / games : null
    };
  }

  /* ---------- main analysis ---------- */
  function run(db, deck, cmds, opts) {
    opts = opts || {};
    const S = opts.settings || E.defaults();
    const targets = Object.assign({}, BENCH, S.targets || {}, { avgMV: +((S.mana && S.mana.avgMV) || BENCH.avgMV) });
    const CI = 'WUBRG'.split('').filter(x => cmds.some(c => c.ci.includes(x))).join('');
    const all = deck.map(e => ({ c: e.c, qty: e.qty || 1, locked: !!e.locked }));
    const nonland = all.filter(e => !A(e.c).isLand), lands = all.filter(e => A(e.c).isLand);
    const qty = arr => arr.reduce((s, e) => s + e.qty, 0);
    const count = pred => all.filter(e => pred(e.c)).reduce((s, e) => s + e.qty, 0);
    const names = pred => all.filter(e => pred(e.c)).map(e => e.c.n);
    const nLands = qty(lands), nNon = qty(nonland);
    const avgMV = nNon ? nonland.reduce((s, e) => s + e.c.cmc * e.qty, 0) / nNon : 0;
    const role = r => count(c => A(c).roles[r]);
    const flag = f => count(c => A(c).flags[f]);

    /* interaction coverage */
    const removalCards = all.filter(e => A(e.c).roles.removal || A(e.c).roles.wipes).map(e => e.c);
    const hits = { creature: /creature|permanent|any target/, artifact: /artifact|permanent/, enchantment: /enchantment|permanent/, planeswalker: /planeswalker|permanent|any target/, land: /\bland\b|nonbasic/, spell: /counter target (?:spell|noncreature|instant|creature spell|activated)/ };
    const coverage = {};
    for (const [k, re] of Object.entries(hits)) coverage[k] = removalCards.filter(c => k === 'spell' ? re.test(c.low) : (new RegExp('(?:destroy|exile|return|damage to|sacrifices?)[^.]{0,60}(?:' + re.source + ')').test(c.low) && !(k === 'land' && /nonland/.test(c.low)))).map(c => c.n);
    const gyHate = names(c => /exile (?:target|each|all|any number of target) [^.]*(?:card from a|cards? from|player's) graveyard|exile (?:each|all) graveyards?|exile all cards from all graveyards/.test(c.low) || /if a card would be put into an opponent's graveyard/.test(c.low));
    const instantInteraction = removalCards.filter(isInstantSpeed).map(c => c.n);
    const cheapInteraction = removalCards.filter(c => c.cmc <= 2 && !A(c).isLand).map(c => c.n);

    /* card advantage */
    const drawCards = all.filter(e => A(e.c).roles.draw).map(e => e.c);
    const engines = drawCards.filter(c => isPerm(c) && /whenever|at the beginning of|\{t\}|: draw/.test(c.low)).map(c => c.n);
    const tutors = names(c => A(c).flags.tutor);

    /* resilience */
    const protection = names(c => A(c).roles.protection);
    const recursion = names(c => A(c).roles.recursion);
    const cmdProtect = names(c => /target (?:creature|permanent|commander)[^.]{0,30}you control (?:gains|has) (?:hexproof|indestructible|shroud|protection)|(?:creatures|permanents|commanders?) you control (?:gain|have) (?:hexproof|indestructible|shroud|protection)|equipped creature (?:has|gains) (?:hexproof|indestructible|shroud|protection|ward)/.test(c.low));
    const indestructibleSelf = names(c => c.kw.includes('indestructible') || c.kw.includes('hexproof') || c.kw.includes('ward'));

    /* threats */
    const wincons = names(c => A(c).roles.wincon);
    const evasive = names(c => A(c).creature && (['flying', 'trample', 'menace', 'shadow', 'horsemanship', 'fear', 'intimidate', 'skulk'].some(k => c.kw.includes(k)) || /can't be blocked/.test(c.low)));
    const creatures = count(c => A(c).creature);

    /* mana base */
    const pp = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const c of cmds) { const p = E.pips(c.mc); for (const k in pp) pp[k] += p[k]; }
    for (const e of nonland) { const p = E.pips(e.c.mc); for (const k in pp) pp[k] += p[k] * e.qty; }
    const pipTotal = Object.values(pp).reduce((a, b) => a + b, 0);
    const srcOf = c => {
      const a = A(c);
      if (a.land === 'fetch') { if (/basic land/.test(c.low)) return CI.split(''); const map = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' }; return [...new Set((c.low.match(/plains|island|swamp|mountain|forest/g) || []).map(x => map[x]))]; }
      if (a.land === 'command' || /mana of any (?:one )?colou?r/.test(c.low)) return CI.split('');
      return c.pm.filter(x => 'WUBRG'.includes(x));
    };
    const landSrc = { W: 0, U: 0, B: 0, R: 0, G: 0 }, allSrc = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const e of all) { const a = A(e.c); if (!(a.isLand || a.roles.ramp)) continue; for (const x of srcOf(e.c)) if (CI.includes(x)) { allSrc[x] += e.qty; if (a.isLand) landSrc[x] += e.qty; } }
    const tapped = lands.filter(e => manaModel(e.c).tapped).map(e => e.c.n);
    const colors = CI.split('').map(x => {
      const pipShare = pipTotal ? pp[x] / pipTotal : 0, srcTotal = Object.values(landSrc).reduce((a, b) => a + b, 0) || 1;
      const srcShare = landSrc[x] / srcTotal;
      const warn = (pipShare >= 0.15 && landSrc[x] < 10) ? 'fewer than 10 land sources' : (srcShare < pipShare - 0.10 ? Math.round(srcShare * 100) + '% of sources for ' + Math.round(pipShare * 100) + '% of pips' : '');
      return { color: x, pips: pp[x], pipShare, landSources: landSrc[x], allSources: allSrc[x], srcShare, warn };
    });
    const deckSize = qty(all);
    const openingLands = { p2to5: (() => { let p = 0; for (let k = 2; k <= 5; k++) p += hyp(deckSize, nLands, 7, k); return p; })(), p3plus: atLeast(deckSize, nLands, 7, 3) };
    const nRamp2 = count(c => A(c).roles.ramp && c.cmc <= 2 && !A(c).isLand);
    const pRampEarly = atLeast(deckSize, nRamp2, 8, 1); // 7 cards + turn-2 draw

    /* simulation */
    const seed = E.hashStr(all.map(e => e.c.n).sort().join('|') + '#' + cmds.map(c => c.n).join('|'));
    const sim = simulate(all, cmds, opts.games || 1500, opts.seed != null ? opts.seed : seed);
    /* exact odds of having drawn at least one card of a role by turn t (7-card hand + one draw per turn after the first) */
    const roleN = { ramp: count(c => A(c).roles.ramp && !A(c).isLand), draw: role('draw'), removal: role('removal'), wipes: role('wipes'), protection: role('protection'), wincon: role('wincon') };
    for (const row of sim.perTurn) { const seen = Math.min(deckSize, 7 + row.t - 1); row.seen = seen; row.pRole = {}; for (const k in roleN) row.pRole[k] = atLeast(deckSize, roleN[k], seen, 1); row.expLandsSeen = seen * nLands / deckSize; }
    sim.roleN = roleN;

    /* synergy */
    const sides = c => { const out = []; for (const p of PAIRS) { const en = p.en(c), pay = p.pay(c); if (en) out.push([p.key, 'en']); if (pay) out.push([p.key, 'pay']); } return out; };
    const pairStats = PAIRS.map(p => ({ key: p.key, label: p.label, enDesc: p.enDesc, payDesc: p.payDesc, en: names(p.en), pay: names(p.pay), cmdEn: cmds.some(p.en), cmdPay: cmds.some(p.pay) }));
    const active = pairStats.filter(p => p.cmdEn || p.cmdPay || (p.en.length >= 3 && p.pay.length >= 1) || p.pay.length >= 3);
    const activeKeys = new Set(active.map(p => p.key));
    for (const p of pairStats) {
      p.active = activeKeys.has(p.key);
      const e = p.en.length + (p.cmdEn ? 4 : 0), y = p.pay.length + (p.cmdPay ? 4 : 0);
      p.status = !p.active ? 'minor' : y === 0 ? 'enablers without payoffs' : e === 0 ? 'payoffs without enablers' : e / y < 1.5 ? 'payoff-heavy: add enablers' : e / y > 6 ? 'enabler-heavy: add payoffs' : 'balanced';
    }
    /* tribal: dominant creature subtype */
    const typeCount = new Map();
    for (const e of all) if (A(e.c).creature) for (const w of ((e.c.ft.split('—')[1] || '').trim().split(/\s+/))) if (w) typeCount.set(w, (typeCount.get(w) || 0) + e.qty);
    const topType = [...typeCount.entries()].sort((a, b) => b[1] - a[1])[0];
    const cmdTypeMention = topType && cmds.some(c => new RegExp('\\b' + topType[0].toLowerCase()).test(c.low));
    const tribal = topType && (topType[1] >= 8 || cmdTypeMention) ? { type: topType[0], count: topType[1], cmdMentions: !!cmdTypeMention, payoffs: names(c => new RegExp('\\b' + topType[0].toLowerCase() + '(?:s|es)?\\b').test(c.low) && !A(c).isLand) } : null;

    const cardSides = new Map(all.map(e => [e.c, sides(e.c).filter(([k]) => activeKeys.has(k))]));
    const cmdSides = cmds.flatMap(sides);
    const perCard = all.filter(e => !A(e.c).isLand).map(e => {
      const my = cardSides.get(e.c); let links = 0; const why = new Set();
      for (const [k, side] of my) {
        const other = side === 'en' ? 'pay' : 'en';
        for (const f of all) { if (f.c === e.c) continue; if (cardSides.get(f.c).some(([k2, s2]) => k2 === k && s2 === other)) { links++; } }
        if (cmdSides.some(([k2, s2]) => k2 === k && s2 === other)) { links += 3; why.add('commander ' + k); }
        why.add(k + (side === 'en' ? ' enabler' : ' payoff'));
      }
      if (tribal && (new RegExp('\\b' + tribal.type + '\\b').test(e.c.ft) || e.c.kw.includes('changeling'))) { links += 1; why.add(tribal.type + ' tribal'); }
      const roles = Object.keys(A(e.c).roles);
      return { c: e.c, links, why: [...why], roles, locked: e.locked };
    });
    const withSyn = perCard.filter(x => x.links > 0).length;
    const synShare = perCard.length ? withSyn / perCard.length : 0;
    const medianLinks = perCard.length ? perCard.map(x => x.links).sort((a, b) => a - b)[Math.floor(perCard.length / 2)] : 0;
    const cutCandidates = perCard.filter(x => x.links === 0 && !x.roles.length && !x.locked).sort((a, b) => (b.c.rank || 1e9) - (a.c.rank || 1e9)).slice(0, 10);

    /* combos */
    const combos = opts.combos || null;

    /* bracket estimate */
    const cnt = { gc: flag('gc') + cmds.filter(c => c.gc).length, tutor: flag('tutor'), xturn: flag('xturn'), mld: flag('mld'), fast: flag('fast') };
    const twoInf = combos ? combos.filter(v => v.inf && v.c.length <= 2).length : null;
    let est = 4; const breaks = [];
    for (const b of [1, 2, 3]) {
      const L = E.BRACKETS[b];
      const over = ['gc', 'mld', 'xturn'].filter(k => cnt[k] > L[k]);
      if (twoInf != null && twoInf > L.combo2) over.push('combo2');
      if (!over.length) { est = b; break; }
      breaks.push('Bracket ' + b + ' exceeded by ' + over.map(k => k + ' ' + (k === 'combo2' ? twoInf : cnt[k]) + '>' + L[k]).join(', '));
    }
    const cedhSignals = [cnt.fast >= 4 ? 'fast mana ' + cnt.fast : '', cnt.tutor >= 6 ? 'tutors ' + cnt.tutor : '', twoInf >= 1 ? '2-card infinites ' + twoInf : '', avgMV <= 2.3 ? 'avg MV ' + avgMV.toFixed(2) : ''].filter(Boolean);
    const bracket = { estimate: est === 1 ? '1–2' : String(est), turns: E.BRACKETS[est === 1 ? 2 : est].turns, counts: cnt, twoInf, reasons: breaks, cedhSignals, note: est <= 2 ? 'Brackets 1 and 2 share card limits except extra turns; they differ by intent and expected game length, which card data cannot measure.' : (est === 4 && twoInf > 0 && cnt.gc <= 3 && cnt.mld === 0 && cnt.xturn <= 2) ? 'Only 2-card infinites exceed Bracket 3. Bracket 3 forbids early-game 2-card infinites only; if these assemble late, the list fits Bracket 3.' : (est === 4 && cedhSignals.length >= 3 ? 'Several cEDH indicators present; could be Bracket 5 depending on intent.' : '') };

    /* axes */
    const P = (t, k) => t + ' · avg ' + POP[k];
    const F = (name, value, target, score, note) => ({ name, value, target, score: clamp(score, 0, 1), note: note || '' });
    const wmean = fs => { const w = fs.reduce((s, f) => s + (f.w || 1), 0); return fs.reduce((s, f) => s + f.score * (f.w || 1), 0) / w; };
    const axes = [];
    const mvScore = clamp((4.2 - avgMV) / (4.2 - targets.avgMV), 0, 1);
    const speed = [F('Average MV (nonland)', avgMV.toFixed(2), '≤ ' + targets.avgMV.toFixed(1), mvScore), F('Mana available turn 4 (simulated)', sim.manaByTurn[4].toFixed(2), '≥ 6', (sim.manaByTurn[4] - 3) / 3),
      F('Commander cast by its MV turn', sim.cmdOnCurve == null ? '—' : Math.round(sim.cmdOnCurve * 100) + '%', '≥ 60%', sim.cmdOnCurve == null ? 1 : sim.cmdOnCurve / 0.6), F('Interaction at MV ≤ 2', cheapInteraction.length, '≥ ' + targets.cheapInteraction, cheapInteraction.length / targets.cheapInteraction), F('Fast mana', cnt.fast, 'context', Math.min(1, cnt.fast / 2) * 0.5 + 0.5)];
    speed[4].w = 0.5;
    axes.push({ key: 'speed', label: 'Speed', factors: speed });
    const tappedShare = nLands ? tapped.length / nLands : 0;
    const colorOk = colors.length ? colors.filter(c => !c.warn).length / colors.length : 1;
    axes.push({ key: 'mana', label: 'Mana & ramp', factors: [F('Lands', nLands, P(targets.lands, 'lands'), 1 - Math.abs(nLands - targets.lands) / 6), F('Ramp pieces', role('ramp'), P(targets.ramp, 'ramp'), ratio(role('ramp'), targets.ramp)), F('Ramp at MV ≤ 2 (P ≥1 by turn 2)', nRamp2 + ' (' + Math.round(pRampEarly * 100) + '%)', '≥ 70%', pRampEarly / 0.7), F('Colors with adequate sources', colors.length - colors.filter(c => c.warn).length + '/' + colors.length, 'all', colorOk), F('Lands entering tapped', tapped.length, '≤ 4', 1 - Math.max(0, tapped.length - 4) / 8), F('Missed natural land drop by turn 4 (sim)', Math.round(sim.missLandDropT4 * 100) + '%', '≤ 40%', 1 - Math.max(0, sim.missLandDropT4 - 0.4) / 0.3)] });
    axes.push({ key: 'cards', label: 'Card advantage', factors: [F('Card draw sources', role('draw'), P(targets.draw, 'draw'), ratio(role('draw'), targets.draw)), F('Repeatable draw engines (permanents)', engines.length, '≥ ' + targets.engines, ratio(engines.length, targets.engines)), F('Tutors', tutors.length, 'context · avg ' + POP.tutors, 0.6 + Math.min(0.4, tutors.length * 0.1))] });
    const covKeys = ['creature', 'artifact', 'enchantment', 'planeswalker'];
    axes.push({ key: 'interaction', label: 'Interaction', factors: [F('Targeted removal / counters', role('removal'), P(targets.removal, 'removal'), ratio(role('removal'), targets.removal)), F('Board wipes', role('wipes'), P(targets.wipes, 'wipes'), ratio(role('wipes'), targets.wipes)), F('Instant-speed interaction', instantInteraction.length, '≥ 50% of interaction', removalCards.length ? instantInteraction.length / removalCards.length / 0.5 : 0), F('Permanent types answerable', covKeys.filter(k => coverage[k].length).length + '/4', '4/4', covKeys.filter(k => coverage[k].length).length / 4), F('Graveyard hate', gyHate.length, '≥ 1', gyHate.length ? 1 : 0.4)] });
    axes.push({ key: 'resilience', label: 'Protection & resilience', factors: [F('Protection pieces', protection.length, targets.protection, ratio(protection.length, targets.protection)), F('Recursion', recursion.length, targets.recursion, ratio(recursion.length, targets.recursion)), F('Commander protection effects', cmdProtect.length, '≥ 2', ratio(cmdProtect.length, 2)), F('Self-protected permanents (hexproof/indestructible/ward)', indestructibleSelf.length, '≥ 3', ratio(indestructibleSelf.length, 3))] });
    axes.push({ key: 'synergy', label: 'Synergy', factors: [F('Nonland cards with ≥1 synergy link', Math.round(synShare * 100) + '%', '≥ 60%', synShare / 0.6), F('Median links per card', medianLinks, '≥ 3', medianLinks / 3), F('Active themes balanced', active.filter(p => p.status === 'balanced').length + '/' + active.length, 'all', active.length ? active.filter(p => p.status === 'balanced').length / active.length : 0.5), F('Commander-linked themes', pairStats.filter(p => p.cmdEn || p.cmdPay).length + (tribal && tribal.cmdMentions ? 1 : 0), '≥ 1', (pairStats.some(p => p.cmdEn || p.cmdPay) || (tribal && tribal.cmdMentions)) ? 1 : 0.3)] });
    axes.push({ key: 'consistency', label: 'Consistency', factors: [F('Opening 7 with 2–5 lands', Math.round(openingLands.p2to5 * 100) + '%', '≥ 85%', openingLands.p2to5 / 0.85), F('Keepable 7 (sim, before mulligan)', Math.round(sim.keep7 * 100) + '%', '≥ 85%', sim.keep7 / 0.85), F('Mana spent / available, turns 1–6 (sim)', Math.round(sim.efficiency6 * 100) + '%', '≥ 70%', sim.efficiency6 / 0.7), F('Draw + tutors (redundancy)', role('draw') + tutors.length, '≥ 12', (role('draw') + tutors.length) / 12)] });
    axes.push({ key: 'threat', label: 'Win pressure', factors: [F('Win conditions', wincons.length, targets.wincon, ratio(wincons.length, targets.wincon)), F('Evasive creatures', evasive.length, '≥ ' + targets.evasive, ratio(evasive.length, targets.evasive)), F('Creatures', creatures, 'context', creatures >= 12 || wincons.length >= 5 ? 1 : 0.6), F('Complete combos (Spellbook)', combos ? combos.length : '—', 'context', combos && combos.length ? 1 : 0.7)] });
    for (const ax of axes) ax.score = Math.round(wmean(ax.factors) * 100);
    const overall = Math.round(axes.reduce((s, a) => s + a.score, 0) / axes.length);

    /* ---------- power model (structure after scrycheck.com/docs; weights are this tool's own, uncalibrated) ---------- */
    const byName = new Map(all.map(e => [E.nameKey(e.c.n), e.c]).concat(cmds.map(c => [E.nameKey(c.n), c])));
    const cardOf = n => byName.get(E.nameKey(n)) || byName.get(E.nameKey(String(n).split(' // ')[0])) || null;
    const cmdKeys = new Set(cmds.map(c => E.nameKey(c.n)));
    const sat = (x, k) => 100 * (1 - Math.exp(-Math.max(0, x) / k));
    // each card counts w × (0.6 + card power), so a stronger card in the same slot scores higher
    const qf = x => typeof x === 'string' ? 1 : 0.6 + E.cardPower(x);
    const comp = (label, n, w, cards) => { cards = cards || []; const pts = cards.length === n ? cards.reduce((s, x) => s + w * qf(x), 0) : n * w; return { label, n, w, pts, cards: cards.map(x => typeof x === 'string' ? x : x.n) }; };
    const vec = (key, label, k, parts) => { const pts = parts.reduce((s, p) => s + p.pts, 0); return { key, label, k, pts, score: Math.round(sat(pts, k)), parts }; };
    const uniq = new Set();
    const take = (pred) => { const out = []; for (const e of nonland) { if (uniq.has(e.c)) continue; if (pred(e.c)) { uniq.add(e.c); out.push(e.c); } } return out; };
    // Speed: fast mana weighted most, then rocks, dorks, land ramp, treasure, cost reducers (one bucket per card)
    const sFast = take(c => A(c).flags.fast);
    const sRock2 = take(c => manaModel(c).rampPerm > 0 && !manaModel(c).dork && c.cmc <= 2);
    const sDork = take(c => manaModel(c).dork);
    const sRock3 = take(c => manaModel(c).rampPerm > 0 && c.cmc >= 3);
    const sLand = take(c => manaModel(c).rampLand > 0 || manaModel(c).extraDrop > 0);
    const sTreas = take(c => A(c).rules.ramp && A(c).rules.ramp.includes('ramp-treasure'));
    const sRed = take(c => /\bspells? (?:you cast )?(?:[^.]{0,40})?cost \{\d\} less|costs? \{\d\} less to cast/.test(c.low) && !A(c).flags.stax);
    const vSpeed = vec('speed', 'Speed', 18, [comp('Fast mana (≤1 MV)', sFast.length, 3, sFast), comp('Mana rocks ≤2 MV', sRock2.length, 1.5, sRock2), comp('Mana dorks', sDork.length, 1.2, sDork), comp('Land ramp / extra drops', sLand.length, 1, sLand), comp('Cost reducers', sRed.length, 1, sRed), comp('Rocks ≥3 MV', sRock3.length, 0.8, sRock3), comp('Treasure makers', sTreas.length, 0.6, sTreas)]);
    // Consistency: tutors ≈ repeatable draw engines > wheels > burst draw > cantrips
    uniq.clear();
    const cTutE = take(c => A(c).flags.tutor && c.cmc <= 2), cTut = take(c => A(c).flags.tutor);
    const engSet = new Set(engines);
    const cEng = take(c => engSet.has(c.n));
    const cWheel = take(c => /each player (?:discards (?:their|his or her) hand|shuffles (?:their|his or her) hand[^.]*)[^.]*(?:,|then|and)[^.]*draws? (?:seven|that many)|each player draws seven/.test(c.low));
    const cCan = take(c => A(c).roles.draw && c.cmc <= 2 && /\b(?:Instant|Sorcery)\b/.test(c.ft) && /draw a card/.test(c.low));
    const cBurst = take(c => A(c).roles.draw);
    const vCons = vec('consistency', 'Consistency', 20, [comp('Tutors ≤2 MV', cTutE.length, 3, cTutE), comp('Tutors ≥3 MV', cTut.length, 2, cTut), comp('Repeatable draw engines', cEng.length, 2.4, cEng), comp('Wheels', cWheel.length, 1.5, cWheel), comp('One-shot draw', cBurst.length, 1, cBurst), comp('Cantrips', cCan.length, 0.5, cCan)]);
    // Interaction: counterspells > instant spot removal > sorcery removal, wipes, stax, protection
    uniq.clear();
    const isFree = c => /rather than pay (?:this spell's|its) mana cost|without paying (?:its|this spell's) mana cost|you may exile an? [a-z]+ card from your hand/.test(c.low);
    const iCounterF = take(c => A(c).rules.removal && A(c).rules.removal.includes('rm-counter') && isFree(c));
    const iCounter = take(c => A(c).rules.removal && A(c).rules.removal.includes('rm-counter'));
    const iInst = take(c => A(c).roles.removal && isInstantSpeed(c));
    const iSorc = take(c => A(c).roles.removal);
    const iWipe = take(c => A(c).roles.wipes);
    const iStax = take(c => A(c).flags.stax || A(c).flags.hate);
    const iProt = take(c => A(c).roles.protection);
    const vInt = vec('interaction', 'Interaction', 22, [comp('Free counterspells', iCounterF.length, 3.5, iCounterF), comp('Counterspells', iCounter.length, 2.5, iCounter), comp('Instant-speed spot removal', iInst.length, 2, iInst), comp('Sorcery-speed removal', iSorc.length, 1.2, iSorc), comp('Board wipes', iWipe.length, 1.2, iWipe), comp('Stax / hate pieces', iStax.length, 1, iStax), comp('Protection', iProt.length, 0.8, iProt)]);
    // Mana base: quality and fixing only; lowers headroom, never adds power
    const colorWarn = colors.filter(c => c.warn).length;
    const multiLands = lands.filter(e => srcOf(e.c).filter(x => CI.includes(x)).length >= 2).reduce((s, e) => s + e.qty, 0);
    const fixShare = nLands ? multiLands / nLands : 0;
    const mbParts = [
      { label: 'Unconditional taplands beyond 2', n: Math.max(0, tapped.length - 2), w: -6 },
      { label: 'Colors below source check', n: colorWarn, w: -15 },
      { label: 'Lands off target by more than 2', n: Math.max(0, Math.abs(nLands - targets.lands) - 2), w: -5 },
      { label: CI.length >= 3 ? 'Multicolor lands < 30% in 3+ colors' : 'Fixing (n/a below 3 colors)', n: CI.length >= 3 && fixShare < 0.3 ? 1 : 0, w: -10 }
    ].map(p => Object.assign(p, { pts: p.n * p.w, cards: [] }));
    const vMana = { key: 'manabase', label: 'Mana base', k: null, pts: null, score: Math.round(clamp(100 + mbParts.reduce((s, p) => s + p.pts, 0), 0, 100)), parts: mbParts, fixShare };
    // Combos: compactness × outcome, grouped into families (shared pieces) with a cap
    const outcomeOf = v => { const t = (v.p || []).join(' | ').toLowerCase(); return /win the game|loses? the game|infinite (?:damage|life ?loss|lifeloss|drain|combat|turns?|poison|mill)|each opponent loses/.test(t) ? ['win', 1] : /infinite/.test(t) ? ['infinite resource', 0.75] : /lock|can't|skip|prevent/.test(t) ? ['lock', 0.45] : ['value', 0.3]; };
    const twoTurnMana = t => (t > 1 ? sim.manaByTurn[t - 1] || 0 : 0) + (sim.manaByTurn[t] || 0);
    const comboList = (combos || []).map(v => {
      const pieces = v.c.map(cardOf); const known = pieces.every(Boolean);
      const cost = v.mv != null ? v.mv : (known ? pieces.reduce((s, c) => s + c.cmc, 0) : null);
      const [outcome, ow] = outcomeOf(v); const n = v.c.length;
      const compact = n <= 2 ? 1 : n === 3 ? 0.7 : n === 4 ? 0.45 : 0.3;
      let turn = null; if (cost != null) for (let t = 1; t <= 8; t++) if (twoTurnMana(t) >= cost) { turn = t; break; }
      return { cards: v.c, produces: v.p || [], n, outcome, score: compact * ow, cost, costSrc: v.mv != null ? 'Spellbook' : 'card MV sum', turn, early: turn != null && turn <= 5, usesCmd: v.c.some(x => cmdKeys.has(E.nameKey(x))), inf: v.inf };
    });
    const parent = comboList.map((_, i) => i); const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    const pieceIdx = new Map();
    comboList.forEach((cb, i) => cb.cards.forEach(n => { const k = E.nameKey(n); if (pieceIdx.has(k)) parent[find(i)] = find(pieceIdx.get(k)); else pieceIdx.set(k, i); }));
    const famMap = new Map(); comboList.forEach((cb, i) => { const r = find(i); if (!famMap.has(r)) famMap.set(r, []); famMap.get(r).push(cb); });
    const families = [...famMap.values()].map(list => { list.sort((a, b) => b.score - a.score); const mx = list[0].score, rest = list.slice(1).reduce((s, x) => s + x.score, 0); return { combos: list, best: list[0], score: Math.min(1.5 * mx, mx + 0.25 * rest) }; }).sort((a, b) => b.score - a.score);
    families.forEach((f, i) => f.combos.forEach(cb => cb.family = i + 1));
    const winFamilies = families.filter(f => f.best.outcome === 'win' || f.best.outcome === 'infinite resource').length;
    const comboPts = families.reduce((s, f) => s + f.score * 8, 0);
    // Threats
    const synPieces = perCard.filter(x => x.links >= 3).map(x => x.c.n);
    const vThreat = vec('threats', 'Threats', 20, [comp('Combo families (Spellbook)', families.length, families.length ? comboPts / families.length : 0, families.map(f => f.best.cards.join(' + '))), comp('Win conditions', wincons.length, 2, all.filter(e => A(e.c).roles.wincon).map(e => e.c)), comp('Evasive creatures', evasive.length, 0.5, evasive), comp('Synergy pieces (≥3 links)', synPieces.length, 0.15, synPieces)]);
    // Archetype
    const pairOf = k => pairStats.find(p => p.key === k);
    const themeScore = k => { const p = pairOf(k); return p && p.active ? Math.min(1, (p.en.length + p.pay.length) / 25 + (p.cmdEn || p.cmdPay ? 0.3 : 0)) : 0; };
    const eqAura = count(c => /\b(?:Equipment|Aura)\b/.test(c.ft));
    const hug = count(c => /\beach player (?:draws|may draw|may put|adds?|creates|gains)/.test(c.low));
    const nCounter = iCounter.length + iCounterF.length;
    const ARCH = [
      ['Combo', winFamilies ? Math.min(1, 0.5 + 0.2 * winFamilies + 0.04 * tutors.length) : 0],
      ['Voltron', Math.min(1, eqAura / 12 + (cmds.some(c => A(c).creature) && cmdProtect.length >= 3 ? 0.2 : 0))],
      ['Tribal', tribal ? Math.min(1, tribal.count / 25 + (tribal.cmdMentions ? 0.3 : 0)) : 0],
      ['Tokens', themeScore('tokens')], ['Aristocrats', themeScore('aristocrats')], ['+1/+1 counters', themeScore('counters')], ['Spellslinger', themeScore('spells')],
      ['Landfall', themeScore('landfall')], ['Graveyard', themeScore('graveyard')], ['Artifacts', themeScore('artifacts')], ['Enchantress', themeScore('enchantments')],
      ['Lifegain', themeScore('lifegain')], ['Blink', themeScore('blink')],
      ['Stax', Math.min(1, iStax.length / 8)],
      ['Control', Math.min(1, (role('removal') + role('wipes') + nCounter) / 24) * (wincons.length <= 4 ? 1 : 0.75)],
      ['Big mana', Math.min(1, role('ramp') / 18) * (avgMV >= 3.4 ? 1 : 0.5)],
      ['Aggro', Math.min(1, creatures / 35) * (avgMV <= 3 ? 1 : 0.6)],
      ['Group hug', Math.min(1, hug / 6)],
      ['Midrange', 0.35]
    ].map(([name, score]) => ({ name, score: Math.round(score * 100) / 100 })).sort((a, b) => b.score - a.score);
    const primary = ARCH[0].name;
    const WEIGHTS = { Combo: [0.25, 0.3, 0.15, 0.3], Control: [0.2, 0.25, 0.35, 0.2], Stax: [0.2, 0.25, 0.35, 0.2], Aggro: [0.3, 0.2, 0.15, 0.35], Voltron: [0.3, 0.2, 0.15, 0.35], Tribal: [0.3, 0.2, 0.15, 0.35], Tokens: [0.3, 0.2, 0.15, 0.35], 'Big mana': [0.35, 0.2, 0.15, 0.3] };
    const wv = WEIGHTS[primary] || [0.25, 0.25, 0.2, 0.3];
    const vmix = vSpeed.score * wv[0] + vCons.score * wv[1] + vInt.score * wv[2] + vThreat.score * wv[3];
    const cps = nonland.map(e => E.cardPower(e.c)).sort((a, b) => b - a);
    const qualTop = cps.slice(0, 60); const cardQ = qualTop.length ? qualTop.reduce((a, b) => a + b, 0) / qualTop.length : 0;
    const qScore = Math.min(100, cardQ / 0.6 * 100);
    const plRaw = 1 + 9 * (0.7 * vmix + 0.3 * qScore) / 100;
    const manaMult = 0.85 + 0.15 * vMana.score / 100;
    const infra = nNon ? (sFast.length + tutors.length + cheapInteraction.length) / nNon : 0;
    const signals = [
      { key: 'redundancy', label: 'Combo redundancy (≥2 independent win/infinite families)', on: winFamilies >= 2 },
      { key: 'engine', label: 'Commander is a piece of a ≤3-card win/infinite combo', on: comboList.some(cb => cb.usesCmd && cb.n <= 3 && (cb.outcome === 'win' || cb.outcome === 'infinite resource')) },
      { key: 'independence', label: 'Wins without the commander (win/infinite combo excluding it)', on: comboList.some(cb => !cb.usesCmd && (cb.outcome === 'win' || cb.outcome === 'infinite resource')) },
      { key: 'infra', label: 'Infrastructure density: fast mana + tutors + MV≤2 interaction ≥ 25% of nonland (' + Math.round(infra * 100) + '%)', on: infra >= 0.25 }
    ];
    const ceiling = 8 + 0.5 * signals.filter(s => s.on).length;
    const plPre = clamp(plRaw * manaMult, 1, 10);
    const pl = Math.round(Math.min(plPre, ceiling) * 10) / 10;
    const PL_LABEL = ['', 'Jank / unfocused', 'Early build', 'Precon level', 'Upgraded precon', 'Focused casual', 'Tuned casual', 'Optimized', 'High power', 'Competitive range', 'Top-end cEDH'];
    // Confidence
    const untagged = perCard.filter(x => !x.roles.length && !x.why.length && !Object.keys(A(x.c).flags).some(f => A(x.c).flags[f])).length;
    const untaggedShare = perCard.length ? untagged / perCard.length : 0;
    const margin = ARCH[0].score - ARCH[1].score;
    const ciParts = [['base', 0.35], ['cards matched by no rule (' + Math.round(untaggedShare * 100) + '%)', 0.6 * untaggedShare], [deckSize + cmds.length !== 100 ? 'deck not 100 cards' : '', deckSize + cmds.length !== 100 ? 0.3 : 0], [combos == null ? 'no Spellbook file' : '', combos == null ? 0.25 : 0], [margin < 0.1 ? 'archetype unclear' : '', margin < 0.1 ? 0.15 : 0], [Math.abs(pl - Math.round(pl)) <= 0.15 ? 'near a level boundary' : '', Math.abs(pl - Math.round(pl)) <= 0.15 ? 0.1 : 0]].filter(x => x[1] > 0);
    const ci = Math.round(ciParts.reduce((s, x) => s + x[1], 0) * 10) / 10;
    // Win speed
    const PT = [[1, 11], [3, 10], [4, 9], [5, 8], [6, 7], [7, 6], [8, 5], [9, 4], [10, 3]];
    const interp = x => { for (let i = 1; i < PT.length; i++) if (x <= PT[i][0]) { const [x0, y0] = PT[i - 1], [x1, y1] = PT[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return 3; };
    const typical = Math.round(interp(pl));
    const comboTurn = comboList.filter(cb => cb.turn != null && (cb.outcome === 'win' || cb.outcome === 'infinite resource')).reduce((m, cb) => Math.min(m, cb.turn), 99);
    const best = Math.max(2, Math.min(typical - 2, comboTurn));
    const contested = Math.round(typical + 1 + (protection.length < 3 ? 1 : 0) + (recursion.length < 2 ? 0.5 : 0));
    // Recommended minimum bracket: card markers, raised by expected win turn (WotC: B2 8+, B3 6+, B4 4+)
    const earlyTwo = comboList.filter(cb => cb.n <= 2 && cb.inf && cb.early).length;
    const markerFloor = est === 1 ? 2 : est;
    let minB = markerFloor; const why = ['card markers → ' + (est === 1 ? '1–2' : est)];
    if (est === 4 && twoInf > 0 && cnt.gc <= 3 && cnt.mld === 0 && cnt.xturn <= 2 && earlyTwo === 0 && combos) { minB = 3; why.push('2-card infinites all assemble after turn 5 → Bracket 3 allowed'); }
    if (typical <= 5 && minB < 4) { minB = 4; why.push('typical win turn ' + typical + ' is faster than Bracket 3 (6+)'); }
    else if (typical <= 7 && minB < 3) { minB = 3; why.push('typical win turn ' + typical + ' is faster than Bracket 2 (8+)'); }
    if (minB === 4 && cedhSignals.length >= 3 && ceiling >= 9.5 && pl >= 9) { minB = 5; why.push('cEDH indicators + strategy ceiling ' + ceiling.toFixed(1)); }
    const band = s => s >= 85 ? 'Exceptional' : s >= 65 ? 'Strong' : s >= 45 ? 'Moderate' : s >= 25 ? 'Weak' : 'Critical gap';
    const vectors = [vSpeed, vCons, vInt, vMana, vThreat].map(v => Object.assign(v, { band: band(v.score) }));
    // Card popularity distribution (EDHREC rank; popularity, not power)
    const RB = [['Top 500', 1, 500], ['501–2,000', 501, 2000], ['2,001–8,000', 2001, 8000], ['8,001+', 8001, 1e12]];
    const quality = RB.map(([label, lo, hi]) => ({ label, n: nonland.filter(e => e.c.rank && e.c.rank >= lo && e.c.rank <= hi).reduce((s, e) => s + e.qty, 0) })).concat([{ label: 'Unranked', n: nonland.filter(e => !e.c.rank).reduce((s, e) => s + e.qty, 0) }]);
    const power = { cardQ: Math.round(cardQ * 100) / 100, qScore: Math.round(qScore), pl, plRaw: Math.round(plRaw * 10) / 10, manaMult: Math.round(manaMult * 100) / 100, ceiling, ceilingBinding: plPre > ceiling, label: PL_LABEL[Math.max(1, Math.min(10, Math.floor(pl)))], ci, ciParts: ciParts.map(x => x[0]), confidence: ci <= 0.5 ? 'high' : ci <= 0.8 ? 'medium' : 'low', vectors, weights: { speed: wv[0], consistency: wv[1], interaction: wv[2], threats: wv[3] }, archetypes: ARCH.slice(0, 5), primary, signals, win: { best, typical, contested, comboTurn: comboTurn < 99 ? comboTurn : null }, minBracket: minB, minBracketWhy: why, combos: comboList, families: families.map(f => ({ score: Math.round(f.score * 100) / 100, n: f.combos.length, best: f.best })), earlyTwo, quality };
    // Anti-synergy checks
    const symWipes = names(c => A(c).roles.wipes && !/creatures? (?:your opponents|an opponent|you don't) control|nontoken creatures? (?:your opponents|you don't)/.test(c.low));
    const allGyExile = names(c => /exile (?:each|all) graveyards?|exile all cards from all graveyards|if a card would be put into an opponent's graveyard[^.]*exile|graveyards? from anywhere, exile it/.test(c.low) || /if a card or token would be put into a graveyard from anywhere/.test(c.low));
    const antiSyn = [];
    if (symWipes.length && creatures >= 28) antiSyn.push({ text: symWipes.length + ' symmetrical board wipe' + (symWipes.length > 1 ? 's' : '') + ' in a deck with ' + creatures + ' creatures: ' + symWipes.join(', ') + '.' });
    if (allGyExile.length && (pairOf('graveyard').active || recursion.length >= 4)) antiSyn.push({ text: 'Graveyard hate that hits your own graveyard while the deck uses it (' + recursion.length + ' recursion, graveyard theme ' + (pairOf('graveyard').active ? 'active' : 'inactive') + '): ' + allGyExile.join(', ') + '.' });
    power.antiSyn = antiSyn;

    /* recommendations */
    const recs = [];
    const inDeck = new Set(all.map(e => e.c.n).concat(cmds.map(c => c.n)));
    const pcap = S.budget && S.budget.perCard != null && S.budget.perCard !== '' ? +S.budget.perCard : null;
    const cur = (S.budget && S.budget.cur) || 'usd';
    const lim = Object.assign(E.bracketDefaults(S.bracket || 3), S.bl || {});
    const denied = new Set(opts.deny || []);
    const pool = db ? db.all.filter(c => c.leg === 'legal' && !E.isBasic(c) && !inDeck.has(c.n) && !denied.has(c.n) && [...c.ci].every(x => CI.includes(x)) && !(pcap != null && (c.p[cur] == null || c.p[cur] > pcap)) && !(c.gc && cnt.gc >= lim.gc) && !(A(c).flags.tutor && cnt.tutor >= lim.tutor) && !(A(c).flags.mld && lim.mld <= 0) && !(A(c).flags.xturn && cnt.xturn >= lim.xturn)) : [];
    const synBonus = c => { let s = 0; for (const [k, side] of sides(c)) if (activeKeys.has(k)) { const p = pairStats.find(x => x.key === k); s += side === 'en' ? (p.status.startsWith('payoff') ? 2 : 1) : (p.status.startsWith('enabler') ? 2 : 1); } if (tribal && new RegExp('\\b' + tribal.type + '\\b').test(c.ft)) s += 1; return s; };
    const pick = (pred, k) => pool.filter(pred).map(c => ({ c, s: synBonus(c) * 0.6 + (c.rank ? 1 - Math.log10(c.rank) / Math.log10(40000) : 0) })).sort((a, b) => b.s - a.s || (a.c.n < b.c.n ? -1 : 1)).slice(0, k).map(x => x.c);
    const addRec = (sev, text, cards) => recs.push({ sev, text, cards: (cards || []).map(c => ({ n: c.n, mc: c.mc, price: c.p[cur], rank: c.rank, uri: c.uri })) });
    for (const r of ['ramp', 'draw', 'removal', 'wipes', 'protection', 'recursion', 'wincon']) {
      const have = role(r), t = +targets[r] || 0;
      if (have < t) addRec(t - have >= 3 ? 'high' : 'med', E.SLOT_LABEL[r] + ': ' + have + ' of ' + t + '. Candidates ranked by theme fit and EDHREC rank:', pick(c => !A(c).isLand && A(c).roles[r], 5));
    }
    if (nLands < targets.lands - 2) addRec('high', 'Lands: ' + nLands + ' (target ' + targets.lands + '). Simulated missed land drop by turn 4: ' + Math.round(sim.missLandDropT4 * 100) + '%.', []);
    if (nLands > targets.lands + 3) addRec('med', 'Lands: ' + nLands + ' (target ' + targets.lands + '). Simulated flood at turn 6: ' + Math.round(sim.flood6 * 100) + '%.', []);
    if (avgMV > targets.avgMV + 0.4) addRec('med', 'Average MV ' + avgMV.toFixed(2) + ' exceeds target ' + targets.avgMV.toFixed(1) + '. Highest-MV nonland cards without a role: ' + perCard.filter(x => !x.roles.length).sort((a, b) => b.c.cmc - a.c.cmc).slice(0, 5).map(x => x.c.n + ' (' + x.c.cmc + ')').join(', ') + '.', []);
    for (const c of colors) if (c.warn) addRec('med', c.color + ' mana: ' + c.warn + '. Lands producing ' + c.color + ' in your identity:', pick(x => A(x).isLand && srcOf(x).includes(c.color) && srcOf(x).length >= 2, 5));
    if (tapped.length > 6) addRec('low', tapped.length + ' lands enter tapped unconditionally: ' + tapped.join(', ') + '.', []);
    for (const p of pairStats.filter(p => p.active && p.status !== 'balanced')) {
      const needEn = p.status.startsWith('payoff') || p.status === 'payoffs without enablers';
      const P = PAIRS.find(x => x.key === p.key);
      addRec('low', p.label + ': ' + p.en.length + ' enablers, ' + p.pay.length + ' payoffs (' + p.status + '). Add ' + (needEn ? p.enDesc : p.payDesc) + ':', pick(c => !A(c).isLand && (needEn ? P.en(c) : P.pay(c)), 4));
    }
    if (!covKeys.every(k => coverage[k].length)) addRec('med', 'No answer for: ' + covKeys.filter(k => !coverage[k].length).join(', ') + '.', pick(c => !A(c).isLand && (A(c).roles.removal || A(c).roles.wipes) && covKeys.filter(k => !coverage[k].length).some(k => new RegExp('(?:destroy|exile)[^.]{0,40}' + k + '|permanent').test(c.low)), 4));
    if (!gyHate.length) addRec('low', 'No graveyard hate.', pick(c => /exile (?:target|each|all) [^.]*graveyard|exile all cards from all graveyards/.test(c.low), 3));
    for (const a of antiSyn) addRec('med', 'Anti-synergy: ' + a.text, []);
    /* ---------- swap plans (evaluated by impact()) ---------- */
    const priceOf = c => c && c.p && c.p[cur] != null ? +c.p[cur] : null;
    const linkOf = new Map(perCard.map(x => [x.c, x.links]));
    const cardValue = c => { const a = A(c); return (linkOf.get(c) || 0) + 2 * Object.keys(a.roles).length + (a.flags.gc || a.flags.fast || a.flags.tutor ? 3 : 0) + (c.rank ? 2 * (1 - Math.log10(c.rank) / Math.log10(40000)) : 0); };
    const usedCuts = new Set(), usedAdds = new Set();
    const roleSafe = c => Object.keys(A(c).roles).every(r => role(r) - 1 >= (+targets[r] || 0));
    const cutPick = (pred) => all.filter(e => !e.locked && !A(e.c).isLand && !usedCuts.has(e.c) && roleSafe(e.c) && (!pred || pred(e.c))).map(e => e.c).sort((a, b) => cardValue(a) - cardValue(b) || (a.n < b.n ? -1 : 1))[0] || null;
    const basicOf = x => lands.find(e => E.isBasic(e.c) && e.c.pm.includes(x) && e.qty > 0 && !e.locked);
    const overColor = () => { const c = colors.filter(k => basicOf(k.color)).sort((a, b) => (b.srcShare - b.pipShare) - (a.srcShare - a.pipShare))[0]; return c ? basicOf(c.color).c : null; };
    const plans = [];
    const addPlan = (group, reason, cut, add, tag) => { if (!cut || !add || cut === add) return; plans.push({ group, reason, cut, add, tag: tag || '', dPrice: (priceOf(add) || 0) - (priceOf(cut) || 0), priceKnown: priceOf(add) != null && priceOf(cut) != null }); usedAdds.add(add); };
    const pickTwo = pred => { const best = pick(c => pred(c) && !usedAdds.has(c), 10); if (!best.length) return []; const top = best[0]; const cheap = best.filter(c => priceOf(c) != null).sort((a, b) => priceOf(a) - priceOf(b))[0]; return cheap && cheap !== top && (priceOf(top) || 0) - priceOf(cheap) >= 1 ? [[top, 'best fit'], [cheap, 'cheapest of top 10']] : [[top, 'best fit']]; };
    // 1) gaps
    for (const r of ['ramp', 'draw', 'removal', 'wipes', 'protection', 'recursion', 'wincon']) {
      const have = role(r), t = +targets[r] || 0; if (have >= t) continue;
      const opts2 = pickTwo(c => !A(c).isLand && A(c).roles[r]); if (!opts2.length) continue;
      const cut = cutPick(c => !A(c).roles[r]); if (!cut) continue; usedCuts.add(cut);
      for (const [add, tag] of opts2) addPlan('Fix gaps', E.SLOT_LABEL[r] + ' ' + have + ' → ' + (have + 1) + ' of ' + t, cut, add, tag);
    }
    if (nLands < targets.lands - 1) { const need = colors.slice().sort((a, b) => (a.srcShare - a.pipShare) - (b.srcShare - b.pipShare))[0]; const b = need && db ? E.lookup(db, E.BASIC_NAMES[need.color]) : null; const cut = cutPick(); if (b && cut) { usedCuts.add(cut); addPlan('Fix gaps', 'Lands ' + nLands + ' → ' + (nLands + 1) + ' (target ' + targets.lands + ')', cut, b); } }
    if (nLands > targets.lands + 1) { const ob = overColor(); const weakest = ['ramp', 'draw', 'removal', 'protection', 'wincon'].sort((a, b) => role(a) / Math.max(1, +targets[a] || 1) - role(b) / Math.max(1, +targets[b] || 1))[0]; const o = pickTwo(c => !A(c).isLand && A(c).roles[weakest]); if (ob) for (const [add, tag] of o) addPlan('Fix gaps', 'Lands ' + nLands + ' → ' + (nLands - 1) + ' (target ' + targets.lands + '); adds ' + E.SLOT_LABEL[weakest], ob, add, tag); }
    for (const c of colors.filter(c => c.warn)) { const ob = overColor(); if (!ob || ob.pm.includes(c.color)) continue; for (const [add, tag] of pickTwo(x => A(x).isLand && srcOf(x).includes(c.color) && srcOf(x).filter(y => CI.includes(y)).length >= 2)) addPlan('Fix gaps', c.color + ' sources ' + c.landSources + ' → ' + (c.landSources + 1), ob, add, tag); }
    for (const p of pairStats.filter(p => p.active && p.status !== 'balanced').slice(0, 2)) {
      const needEn = p.status.startsWith('payoff') || p.status === 'payoffs without enablers'; const PP = PAIRS.find(x => x.key === p.key);
      const o = pickTwo(c => !A(c).isLand && (needEn ? PP.en(c) : PP.pay(c))); const cut = cutPick(); if (!o.length || !cut) continue; usedCuts.add(cut);
      for (const [add, tag] of o) addPlan('Fix gaps', p.label + ': add ' + (needEn ? 'enabler' : 'payoff') + ' (' + p.en.length + ' enablers, ' + p.pay.length + ' payoffs)', cut, add, tag);
    }
    // 2) upgrades for the weakest power vector (price usually up)
    const UPG = { speed: [c => A(c).flags.fast || (manaModel(c).rampPerm > 0 && c.cmc <= 2 && !manaModel(c).dork), 'fast mana / 2-MV rock'], consistency: [c => (A(c).flags.tutor && c.cmc <= 3) || (isPerm(c) && A(c).roles.draw && /whenever|at the beginning of/.test(c.low)), 'tutor or draw engine'], interaction: [c => (A(c).roles.removal && isInstantSpeed(c) && c.cmc <= 2), 'instant interaction ≤2 MV'], threats: [c => A(c).roles.wincon, 'win condition'] };
    const weakV = [vSpeed, vCons, vInt, vThreat].slice().sort((a, b) => a.score - b.score).slice(0, 2);
    for (const v of weakV) { const [pred, lab] = UPG[v.key]; const adds = pick(c => !A(c).isLand && pred(c) && !usedAdds.has(c), 2); for (const add of adds) { const cut = cutPick(); if (!cut) break; usedCuts.add(cut); addPlan('Upgrades', v.label + ' ' + v.score + ' (' + v.band + '): add ' + lab, cut, add); } }
    // 3) budget: replace expensive cards with cheaper ones sharing a role or theme side
    const pricey = all.filter(e => !e.locked && !usedCuts.has(e.c) && !A(e.c).isLand && priceOf(e.c) != null && priceOf(e.c) >= 5).sort((a, b) => priceOf(b.c) - priceOf(a.c)).slice(0, 5);
    for (const e of pricey) {
      const rs = Object.keys(A(e.c).roles), sd = sides(e.c).map(x => x.join(':'));
      const same = c => !A(c).isLand && (rs.length ? rs.some(r => A(c).roles[r]) : sides(c).some(x => sd.includes(x.join(':'))));
      const add = pick(c => same(c) && !usedAdds.has(c) && priceOf(c) != null && priceOf(c) <= priceOf(e.c) * 0.4, 1)[0];
      if (add) addPlan('Budget', 'Save on ' + e.c.n + (rs.length ? ' (' + rs.map(r => E.SLOT_LABEL[r]).join(', ') + ')' : ''), e.c, add);
    }
    if (cutCandidates.length) addRec('info', 'Cut candidates (no role tag, no synergy link; worst EDHREC rank first): ' + cutCandidates.map(x => x.c.n).join(', ') + '.', []);
    if (opts.almost && opts.almost.length) addRec('info', 'Combos one card away (Spellbook):', []), recs[recs.length - 1].combos = opts.almost.slice(0, 6);

    return {
      at: new Date().toISOString(), CI, deckSize, nLands, nNon, avgMV, overall, axes, sim,
      prob: { openingLands, pRampEarly, nRamp2 },
      mana: { colors, tapped, pipTotal },
      interaction: { coverage, gyHate, instantInteraction, cheapInteraction, removal: role('removal'), wipes: role('wipes') },
      cards: { draw: drawCards.map(c => c.n), engines, tutors },
      resilience: { protection, recursion, cmdProtect, indestructibleSelf },
      threat: { wincons, evasive, creatures },
      synergy: { pairs: pairStats, tribal, perCard: perCard.sort((a, b) => b.links - a.links || (a.c.n < b.c.n ? -1 : 1)), synShare, medianLinks, cut: cutCandidates },
      bracket, combos, recs, power, plans, cur
    };
  }

  /* ---------- swap impact: re-run the analysis with each swap, same seed (common random numbers) ---------- */
  function applySwap(deck, cut, add) {
    const out = [];
    for (const e of deck) {
      if (e.c === cut) { if ((e.qty || 1) > 1) { out.push(Object.assign({}, e, { qty: e.qty - 1 })); } out.push({ c: add, qty: 1 }); }
      else out.push(e);
    }
    return out;
  }
  const snap = X => ({ src: Object.fromEntries(X.mana.colors.map(c => [c.color, c.landSources])), warn: X.mana.colors.filter(c => c.warn).length, pl: X.power.pl, fund: X.overall, minB: X.power.minBracket, typical: X.power.win.typical, keep: X.sim.keep7, t4: X.sim.manaByTurn[4], v: Object.fromEntries(X.power.vectors.map(v => [v.key, v.score])), axes: Object.fromEntries(X.axes.map(a => [a.key, a.score])) });
  function impactPrep(db, deck, cmds, opts) {
    const games = opts.impactGames || 5000;
    const seed = E.hashStr('impact#' + cmds.map(c => c.n).join('|'));
    const o = Object.assign({}, opts, { games, seed, almost: null });
    return { db, deck, cmds, opts: o, games, base: snap(run(db, deck, cmds, o)) };
  }
  function impactOne(prep, p) {
    const d2 = applySwap(prep.deck, p.cut, p.add);
    const combos = prep.opts.combosFor ? prep.opts.combosFor(p.cut, p.add) : (prep.opts.combos || null);
    const a = snap(run(prep.db, d2, prep.cmds, Object.assign({}, prep.opts, { combos }))), b = prep.base;
    const dv = Object.keys(a.v).map(k => [k, a.v[k] - b.v[k]]).filter(x => x[1] !== 0);
    const da = Object.keys(a.axes).map(k => [k, a.axes[k] - b.axes[k]]).filter(x => x[1] !== 0);
    const dsrc = Object.keys(a.src).map(k => [k, a.src[k] - (b.src[k] || 0)]).filter(x => x[1] !== 0);
    return Object.assign({}, p, { d: { src: dsrc, warn: a.warn - b.warn, pl: Math.round((a.pl - b.pl) * 10) / 10, fund: a.fund - b.fund, minB: a.minB - b.minB, typical: a.typical - b.typical, keep: a.keep - b.keep, t4: a.t4 - b.t4, vectors: dv, axes: da }, after: a });
  }
  function impact(db, deck, cmds, opts, plans) { const prep = impactPrep(db, deck, cmds, opts); return plans.map(p => impactOne(prep, p)); }

  /* ---------- decklist parsing with sections ---------- */
  function parseDecklist(text) {
    const cmd = [], main = []; let section = 'main', sawBlankAfterMain = false;
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { if (main.length) sawBlankAfterMain = true; continue; }
      if (/^(commanders?)\s*:?$/i.test(line)) { section = 'cmd'; continue; }
      if (/^(deck|mainboard|main)\s*:?$/i.test(line)) { section = 'main'; continue; }
      if (/^(sideboard|maybeboard|considering)\s*:?$/i.test(line)) { section = 'skip'; continue; }
      if (section === 'skip') continue;
      const isCmdTag = /\[commander/i.test(line) || /\*CMDR\*/i.test(line);
      const it = E.parseList(line)[0]; if (!it) continue;
      if (isCmdTag || section === 'cmd') cmd.push(it); else if (sawBlankAfterMain && main.length >= 90) cmd.push(it); else main.push(it);
    }
    return { cmd, main };
  }

  return { run, impact, impactPrep, impactOne, applySwap, simulate, manaModel, parseDecklist, PAIRS, BENCH, POP, hyp };
})();
if (typeof module !== 'undefined') module.exports = Analysis;
