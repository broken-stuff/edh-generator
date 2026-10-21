/* ===== Deep: wide swap search with the simulation as the judge (pure; uses Engine and Analysis; runs in Web Workers or in-process) ===== */
// Objective: g = Δ(10 × unrounded power level + fundamentals mean), the same score as budget upgrades, on common random numbers
// (every list is simulated on the same shuffles as the current list, so differences come from the cards).
//  0. Cut cost: every cuttable nonland card is replaced by one reference add at G1 games; the card whose removal costs least
//     is the default cut c*, and δ_j = g(c*) − g(c_j) is how much worse cutting c_j is.
//  1. Screen (G1 games): each candidate add replaces c* (lands replace a basic). Candidates: the best-fitting cards of the
//     analysis pool (theme links + EDHREC rank), the best for each role and weak power vector, the most played cards, cards
//     that complete a Spellbook combo with the deck (one card missing) and pairs that complete one together (two missing).
//  2. Confirm (G2 games): the best screened candidates are measured again.
//  3. Package: swaps are added one at a time; each round re-measures the leading candidates (with the next cheapest cut, and
//     the top few with other cuts) on the deck as changed so far, so synergy between added cards and with the cut is counted.
//     It stops when no swap adds MIN_GAIN or the bracket floor would rise above the chosen bracket.
// The person accepts or denies every swap; nothing is applied by the search.
const Deep = (function () {
  'use strict';
  const E = (typeof Engine !== 'undefined') ? Engine : require('./engine.js');
  const An = (typeof Analysis !== 'undefined') ? Analysis : require('./analysis.js');
  const A = c => E.analyze(c);
  const G1 = 1500, G2 = 5000, MIN_GAIN = 0.5;
  const DEF = { g1: G1, g2: G2, cuts: 24, nonland: 400, popular: 40, perRole: 4, perVector: 4, lands: 24, single: 30, pairs: 16, confirm: 60, rounds: 10, lead: 12, altCuts: 3, altFor: 3, shown: 15, pairsShown: 3 };

  /* ---------- evaluator: the part that runs in each worker ---------- */
  // init: { cards: [card], deck: [{ n, qty, locked }], cmds: [name], opts, combos: [variant] | null, comp: { addName: [variant] } }
  // task: { id, games, swaps: [{ cut, add }] } (names) → { id, g, d, after }
  function evaluator(init) {
    const by = new Map(init.cards.map(c => [c.n, c]));
    const deck = init.deck.map(e => ({ c: by.get(e.n), qty: e.qty, locked: !!e.locked }));
    const cmds = init.cmds.map(n => by.get(n)), base = init.combos, comp = init.comp || {};
    const names = new Set(init.deck.map(e => e.n).concat(init.cmds));
    const preps = new Map();
    const prep = g => { if (!preps.has(g)) preps.set(g, An.impactPrep(null, deck, cmds, Object.assign({}, init.opts, { combos: base, impactGames: g }))); return preps.get(g); };
    return t => {
      const P = prep(t.games), swaps = t.swaps.map(s => ({ cut: by.get(s.cut), add: by.get(s.add) }));
      let combos = null;
      if (base) {
        const cut = new Set(t.swaps.map(s => s.cut)), now = new Set(names); for (const s of t.swaps) { now.delete(s.cut); now.add(s.add); }
        combos = base.filter(v => !v.c.some(n => cut.has(n))); const seen = new Set(combos.map(v => v.id));
        for (const s of t.swaps) for (const v of comp[s.add] || []) if (!seen.has(v.id) && v.c.every(n => now.has(n))) { seen.add(v.id); combos.push(v); }
      }
      const r = An.impactSwaps(P, swaps, combos);
      return { id: t.id, g: r.g, d: r.d, after: r.after };
    };
  }

  /* ---------- executors ---------- */
  // in-process (tests, or a browser without Workers): yields between tasks so the page can repaint and cancel
  function localExec(init) {
    const ev = evaluator(init); let stop = false;
    return {
      n: 1,
      async run(tasks, onOne) { const out = []; for (const t of tasks) { if (stop) throw new Error('cancelled'); out.push(ev(t)); if (onOne) await onOne(); } return out; },
      cancel() { stop = true; }, close() { }
    };
  }
  // Web Worker pool; src: the source of engine.js + analysis.js + deep.js
  function workerExec(init, src, n) {
    const code = src + '\n;(function(){ let ev = null; self.onmessage = m => { const d = m.data; try { if (d.init) { ev = Deep.evaluator(d.init); self.postMessage({ ready: 1 }); } else self.postMessage(ev(d)); } catch (e) { self.postMessage({ id: d.id, err: String(e && e.message || e) }); } }; })();';
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const ws = Array.from({ length: n }, () => { const w = new Worker(url); w.postMessage({ init }); return w; });
    let dead = null;
    const kill = why => { if (dead) return; dead = why; for (const w of ws) w.terminate(); URL.revokeObjectURL(url); };
    return {
      n,
      run(tasks, onOne) {
        if (dead) return Promise.reject(new Error(dead));
        return new Promise((res, rej) => {
          const out = new Array(tasks.length); let next = 0, done = 0;
          if (!tasks.length) return res(out);
          const pos = new Map(tasks.map((t, i) => [t.id, i]));
          const feed = w => { if (next < tasks.length) w.postMessage(tasks[next++]); };
          for (const w of ws) {
            w.onmessage = m => {
              const d = m.data; if (d.ready) return;
              if (d.err) { kill('worker: ' + d.err); return rej(new Error(d.err)); }
              out[pos.get(d.id)] = d; done++; if (onOne) onOne();
              if (done === tasks.length) res(out); else feed(w);
            };
            w.onerror = e => { kill('worker error'); rej(new Error(e.message || 'worker error')); };
            feed(w);
          }
          const iv = setInterval(() => { if (dead) { clearInterval(iv); rej(new Error(dead)); } else if (done === tasks.length) clearInterval(iv); }, 100);
        });
      },
      cancel() { kill('cancelled'); }, close() { kill('closed'); }
    };
  }

  /* ---------- candidates ---------- */
  // X: Analysis.run result (with planner and pool). ctx: { deck, cmds, combos, prov, keep: Set(names) }
  function candidates(X, ctx, o) {
    const P = X.planner, pool = P.pool, seen = new Set(), adds = [], why = new Map();
    const take = (list, tag) => { for (const c of list) { if (!why.has(c.n)) why.set(c.n, tag); if (!seen.has(c.n)) { seen.add(c.n); adds.push(c); } } };
    const non = pool.filter(c => !A(c).isLand);
    const gap = c => Object.keys(A(c).roles).reduce((s, r) => s + (r in P.have && P.have[r] < P.targets[r] ? 2 : 0), 0);
    take(non.map(c => ({ c, v: P.value(c) + gap(c) })).sort((a, b) => b.v - a.v || (a.c.n < b.c.n ? -1 : 1)).slice(0, o.nonland).map(x => x.c), 'theme fit');
    for (const r of Object.keys(P.targets)) take(P.pick(c => !A(c).isLand && A(c).roles[r], o.perRole), E.SLOT_LABEL[r] || r);
    for (const k of Object.keys(P.upg)) take(P.pick(c => !A(c).isLand && P.upg[k][0](c), o.perVector), P.upg[k][1]);
    take(non.filter(c => c.rank).sort((a, b) => a.rank - b.rank).slice(0, o.popular), 'most played');
    const lands = P.multi ? pool.filter(c => A(c).isLand && P.landOn(c) >= 2).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9)).slice(0, o.lands) : [];
    return { adds, lands, why };
  }
  async function comboCands(X, ctx, o) {
    const prov = ctx.prov; if (!prov || !prov.almost) return { single: [], pairs: [] };
    const P = X.planner, inPool = new Map(P.pool.map(c => [c.n, c]));
    const names = ctx.cmds.map(c => c.n).concat(ctx.deck.map(e => e.c.n));
    const S = ctx.settings || {}, lim = Object.assign(E.bracketDefaults(+S.bracket || 3), S.bl || {});
    const lim2 = lim.combo2 <= 0; // two-card infinite combos barred in this bracket
    const al = (await prov.almost(names, n => inPool.has(n), 2)).filter(x => x.v.r === 0 && !(lim2 && x.v.inf && x.v.c.length <= 2));
    const rankOf = x => -(x.v.pop || 0);
    const single = [], pairs = [], s1 = new Set(), s2 = new Set();
    for (const x of al.slice().sort((a, b) => rankOf(a) - rankOf(b))) {
      const m = x.missing.map(n => inPool.get(n));
      if (m.length === 1 && !s1.has(m[0].n) && single.length < o.single) { s1.add(m[0].n); single.push({ add: m[0], v: x.v }); }
      if (m.length === 2 && pairs.length < o.pairs) { const k = m.map(c => c.n).sort().join('|'); if (!s2.has(k)) { s2.add(k); pairs.push({ adds: m, v: x.v }); } }
    }
    return { single, pairs };
  }

  /* ---------- the search ---------- */
  // exec: from localExec / workerExec, built with init(X, ctx, cand). progress(done, total, label). Returns { singles, pkg, stats }.
  function makeInit(X, ctx, adds, opts) {
    const cards = new Map();
    for (const e of ctx.deck) cards.set(e.c.n, e.c); for (const c of ctx.cmds) cards.set(c.n, c); for (const c of adds) cards.set(c.n, c);
    const all = new Set(cards.keys()), comp = {};
    if (ctx.prov && ctx.prov.completes) for (const c of adds) { const v = ctx.prov.completes(c.n, all, ctx.cmds.map(x => x.n)).filter(v => v.r === 0); if (v.length) comp[c.n] = v; }
    return { cards: [...cards.values()], deck: ctx.deck.map(e => ({ n: e.c.n, qty: e.qty || 1, locked: !!e.locked })), cmds: ctx.cmds.map(c => c.n), opts, combos: ctx.combos || null, comp };
  }
  async function search(X, ctx, execFor, progress, o) {
    o = Object.assign({}, DEF, o || {});
    const P = X.planner, keep = ctx.keep || new Set(), bracket = +((ctx.settings && ctx.settings.bracket) || 3);
    const C = candidates(X, ctx, o), K = await comboCands(X, ctx, o);
    for (const s of K.single) { if (!C.adds.includes(s.add)) C.adds.push(s.add); C.why.set(s.add.n, 'completes ' + s.v.c.join(' + ')); }
    const pairCards = [].concat(...K.pairs.map(p => p.adds));
    const allAdds = [...new Set(C.adds.concat(C.lands, pairCards))];
    const exec = execFor(makeInit(X, ctx, allAdds, { settings: ctx.settings }));
    // cuts: the lowest-value nonland cards (synergy links, roles, popularity), role-safe ones first; the simulation then orders them
    const safe = c => Object.keys(A(c).roles).every(r => !(r in P.have) || P.have[r] - 1 >= P.targets[r]);
    const cuts = ctx.deck.filter(e => !e.locked && !keep.has(e.c.n) && !P.combo.has(e.c.n) && !A(e.c).isLand).map(e => e.c)
      .sort((a, b) => safe(b) - safe(a) || P.value(a) - P.value(b) || (a.n < b.n ? -1 : 1)).slice(0, o.cuts);
    const basics = ctx.deck.filter(e => E.isBasic(e.c) && !e.locked).sort((a, b) => P.landValue(a.c) - P.landValue(b.c));
    const est = cuts.length + C.adds.length + C.lands.length + K.pairs.length + o.confirm + o.rounds * (o.lead + o.altFor * (o.altCuts - 1));
    let done = 0, total = est, id = 0, evals = 0;
    const tick = async () => { done++; evals++; if (progress) await progress(Math.min(done, total - 1), total); };
    const run = (tasks) => exec.run(tasks.map(t => Object.assign({ id: ++id }, t)), tick);
    const sw = (cut, add) => ({ cut: cut.n, add: add.n });
    try {
      if (!cuts.length || !C.adds.length) return { singles: [], pkg: [], stats: { evals: 0, cands: allAdds.length, cuts: cuts.length } };
      // 0. cut cost with a reference add (the best-fitting candidate)
      const ref = C.adds[0];
      const r0 = await run(cuts.map(c => ({ games: o.g1, swaps: [sw(c, ref)] })));
      const cutG = cuts.map((c, j) => ({ c, g: r0[j].g })).sort((a, b) => b.g - a.g), gMax = cutG[0].g;
      const order = cutG.map(x => ({ c: x.c, delta: gMax - x.g })), cStar = order[0].c;
      // 1. screen
      const sAdds = C.adds.filter(c => c !== cStar), b0 = basics[0] && basics[0].c;
      const items = sAdds.map(c => ({ kind: 'add', adds: [c] })).concat(b0 ? C.lands.map(c => ({ kind: 'land', adds: [c] })) : [], order.length > 1 ? K.pairs.map(p => ({ kind: 'pair', adds: p.adds, v: p.v })) : []);
      const cutsFor = (it, used) => { const out = []; const nb = new Map(basics.map(e => [e.c, e.qty])); for (const u of used) if (nb.has(u)) nb.set(u, nb.get(u) - 1);
        for (const a of it.adds) { if (A(a).isLand) { const e = basics.find(b => nb.get(b.c) > 0); if (!e) return null; nb.set(e.c, nb.get(e.c) - 1); out.push(e.c); } else { const x = order.find(y => !used.has(y.c) && !out.includes(y.c)); if (!x) return null; out.push(x.c); } }
        return out; };
      const swapsOf = (it, cs) => it.adds.map((a, i) => sw(cs[i], a));
      const rA = await run(items.map(it => ({ games: o.g1, swaps: swapsOf(it, cutsFor(it, new Set())) })));
      items.forEach((it, i) => { it.g1 = rA[i].g; it.minB = rA[i].after.minB; });
      // 2. confirm the best at G2 (lands and pairs get a share so they are not crowded out)
      const okB = it => it.minB <= Math.max(bracket, X.power.minBracket);
      const best = (kind, k) => items.filter(it => it.kind === kind && okB(it)).sort((a, b) => b.g1 - a.g1).slice(0, k);
      const conf = [...new Set(best('add', o.confirm - 12).concat(best('land', 6), best('pair', 6)))];
      const rB = await run(conf.map(it => ({ games: o.g2, swaps: swapsOf(it, cutsFor(it, new Set())) })));
      conf.forEach((it, i) => { it.g2 = rB[i].g; it.r = rB[i]; it.cuts = cutsFor(it, new Set()); });
      const ranked = conf.filter(it => okB({ minB: it.r.after.minB })).sort((a, b) => b.g2 - a.g2);
      // 3. package
      const pkg = []; let gPrev = 0; const used = new Set(), added = new Set();
      for (let k = 0; k < o.rounds; k++) {
        const open = ranked.filter(it => it.g2 > 0 && !it.adds.some(a => added.has(a)));
        const left = [...new Set(open.slice(0, o.lead / 2).concat(open.filter(it => it.kind !== 'pair').slice(0, o.lead / 2)))]; // combo pairs score high; keep single cards in the race
        if (!left.length) break;
        const tries = [];
        let na = 0;
        left.forEach(it => {
          const cs = cutsFor(it, used); if (!cs) return; tries.push({ it, cs });
          if (it.kind === 'add' && na++ < o.altFor) for (const x of order.filter(y => !used.has(y.c) && y.c !== cs[0]).slice(0, o.altCuts - 1)) tries.push({ it, cs: [x.c] });
        });
        if (!tries.length) break;
        const pre = pkg.map(p => sw(p.cut, p.add));
        const rC = await run(tries.map(t => ({ games: o.g2, swaps: pre.concat(swapsOf(t.it, t.cs)) })));
        let bi = -1;
        rC.forEach((r, i) => { if (r.after.minB > Math.max(bracket, X.power.minBracket)) return; if (bi < 0 || r.g > rC[bi].g) bi = i; });
        if (bi < 0 || rC[bi].g - gPrev < MIN_GAIN * tries[bi].it.adds.length) break;
        const t = tries[bi], r = rC[bi];
        t.it.adds.forEach((a, i) => { pkg.push({ add: a, cut: t.cs[i], step: k + 1, m: (r.g - gPrev) / t.it.adds.length, total: r.g, r, kind: t.it.kind, v: t.it.v }); used.add(t.cs[i]); added.add(a); });
        gPrev = r.g;
      }
      total = done; if (progress) await progress(done, total);
      // best single swaps: one row per added card, at most o.pairsShown pairs
      const shown = new Set(); let np = 0;
      const singles = ranked.filter(it => it.g2 >= MIN_GAIN && !it.adds.some(a => shown.has(a.n)) && (it.kind !== 'pair' || np++ < o.pairsShown) && (it.adds.forEach(a => shown.add(a.n)), true)).slice(0, o.shown);
      return { singles, pkg, why: C.why, order: order.map(x => x.c), stats: { evals, cands: items.length, adds: allAdds.length, cuts: cuts.length, confirmed: conf.length, ref: ref.n, workers: exec.n } };
    } finally { exec.close(); }
  }

  /* ---------- results as swap rows for the Improve list ---------- */
  function rows(X, res) {
    const P = X.planner, price = c => P.price(c), r1 = v => Math.round(v * 10) / 10;
    const row = (group, reason, cut, add, r, tag) => ({ group, reason, cut, add, tag: tag || '', d: r.d, after: r.after, g: r.g, dPrice: (price(add) || 0) - (price(cut) || 0), priceKnown: price(add) != null && price(cut) != null });
    const out = [];
    for (const it of res.singles) it.adds.forEach((a, i) => out.push(row('Deep search', (it.kind === 'pair' ? 'Pair: completes ' + it.v.c.join(' + ') + ' with ' + it.adds.filter(x => x !== a).map(x => x.n).join(', ') : (res.why.get(a.n) || 'screened')) + ' · gain ' + r1(it.g2) + (it.kind === 'pair' ? ' for both' : ''), it.cuts[i], a, it.r)));
    const nSteps = res.pkg.length ? res.pkg[res.pkg.length - 1].step : 0;
    for (const p of res.pkg) out.push(row('Package', 'Step ' + p.step + ' of ' + nSteps + ' · marginal gain ' + r1(p.m) + ' · package total ' + r1(p.total) + (p.kind === 'pair' ? ' · completes ' + p.v.c.join(' + ') : res.why.get(p.add.n) ? ' · ' + res.why.get(p.add.n) : ''), p.cut, p.add, p.r));
    return out;
  }

  return { search, rows, evaluator, localExec, workerExec, candidates, makeInit, G1, G2, MIN_GAIN, DEF };
})();
if (typeof module !== 'undefined') module.exports = Deep;
