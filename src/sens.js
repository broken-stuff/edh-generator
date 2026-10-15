// Sensitivity matrix: how generated decks and their scores respond to bracket, budget and game plan.
const E=require('./engine.js'),An=require('./analysis.js');const raw=require('./fixture.js');
const db=E.buildDB(raw.map(E.norm).filter(Boolean),{});
const PLANS={balanced:[{lands:37,ramp:10,draw:10,removal:9,wipes:3,protection:3,recursion:2,wincon:3},3.0],fast:[{lands:34,ramp:12,draw:9,removal:8,wipes:1,protection:3,recursion:1,wincon:5},2.6],late:[{lands:38,ramp:13,draw:10,removal:8,wipes:4,protection:3,recursion:3,wincon:4},3.6]};
(async()=>{
 const rows=[];
 for (const plan of ['balanced','fast','late']) for (const b of [1,2,3,4,5]) for (const bud of [null,150]) {
  const d=E.defaults();
  const S={commanders:[process.argv[2]||'Synth Rainbow'],seed:'s',bracket:b,bl:E.bracketDefaults(b),targets:PLANS[plan][0],mana:Object.assign({},d.mana,{avgMV:PLANS[plan][1]}),budget:Object.assign({},d.budget,{total:bud})};
  const R=await E.generate(db,S);
  const X=An.run(db,R.deck,R.commanders,{settings:R.settings,games:3000});
  const P=X.power, v=Object.fromEntries(P.vectors.map(x=>[x.key,x.score]));
  rows.push([plan,b,bud||'-',R.stats.total.toFixed(0),X.avgMV.toFixed(2),P.cardQ,P.pl,v.speed,v.consistency,v.interaction,v.threats,X.bracket.counts.gc,X.bracket.counts.fast,X.bracket.counts.tutor,P.win.typical,P.minBracket].join('\t'));
 }
 console.log('plan\tB\tbud\tprice\tavgMV\tqual\tPL\tspd\tcons\tint\tthr\tGC\tfast\ttut\tT\tminB');console.log(rows.join('\n'));
})();
