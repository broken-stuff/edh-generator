// Similar (card explorer) tests on the SYNTHETIC fixture. Logic tests only.
const E = require('./engine.js'), S = require('./similar.js'), raw = require('./fixture.js');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('pass', m); };
const db = E.buildDB(raw.map(E.norm).filter(Boolean), {});
(async () => {
  const X = await S.build(db);
  assert(X.N === db.all.length && X.ids.length > 0, 'index built for every card');
  const pick = re => db.all.find(c => re.test(c.ot) && !E.isBasic(c));
  const draw = pick(/^Draw two cards\.$/);
  const R = S.rank(X, draw, { limit: 20 });
  assert(R.list.length > 0 && R.list.every(r => r.c !== draw && r.c.oid !== draw.oid), 'the card itself is never recommended');
  assert(R.list.every((r, i) => !i || R.list[i - 1].score >= r.score), 'sorted by score');
  assert(R.list.every(r => r.score >= 0 && r.score <= 1), 'scores between 0 and 1');
  assert(/^Draw (two|three) cards\.$/.test(R.list[0].c.ot), 'closest card to "Draw two cards." also draws cards: ' + R.list[0].c.n);
  assert(S.cardMechanics(X, draw).some(m => m.id === 'r:draw-n'), 'draw rule detected as a mechanic');
  const F = S.rank(X, draw, { focus: 'r:draw-n', limit: 50 });
  assert(F.list.length > 0 && F.list.every(r => /draw/i.test(r.c.ot)), 'focus keeps only cards with that mechanic');
  const W = S.rank(X, draw, { weights: { mech: 0, cost: 100, type: 0, stats: 0 }, limit: 5 });
  assert(W.list.every(r => Math.abs(r.score - r.parts.cost) < 1e-9), 'weights: cost only → score equals cost part');
  const vanilla = db.all.find(c => !c.ot && /Creature/.test(c.ft));
  if (vanilla) { const V = S.rank(X, vanilla, { limit: 5 }); assert(V.list.every(r => r.parts.mech === (r.c.low ? 0 : 1) || !r.c.low), 'vanilla card: mechanics part is 1 only for cards without rules text'); }
  assert(S.mechanics({ low: 'whenever a creature you control dies, put a +1/+1 counter on ~.', kw: [], mc: '', ot: '', ft: 'Creature', tl: 'Creature', pow: 1 }).includes('ctr:+1/+1'), '+1/+1 counter detected');
  assert(S.mechanics({ low: 'create a treasure token.', kw: [], mc: '', ot: '', ft: 'Sorcery', tl: 'Sorcery' }).includes('tok:treasure'), 'Treasure token detected');
  const prov = E.localComboProvider([{ id: 'x', c: [draw.n, 'B'], cmd: [], p: ['Infinite mana'], t: [], r: 0, pop: 5 }, { id: 'y', c: [draw.n, 'B', 'C'], cmd: [], p: [], t: [], r: 0 }], {});
  const K = S.combos(prov, draw.n);
  assert(K.two.length === 1 && K.two[0].partner === 'B' && K.more === 1, '2-card combos split from larger ones');
})();
