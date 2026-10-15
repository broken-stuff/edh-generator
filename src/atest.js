const E=require('./engine.js'),An=require('./analysis.js');const raw=require('./fixture.js');
const db=E.buildDB(raw.map(E.norm).filter(Boolean),{});
(async()=>{
 const R=await E.generate(db,{commanders:['Synth Rainbow'],seed:'a',bracket:4,bl:E.bracketDefaults(4)});
 let t=Date.now();const X=An.run(db,R.deck,R.commanders,{settings:R.settings,combos:R.combos});
 console.log('ms',Date.now()-t,'overall',X.overall, X.axes.map(a=>a.key+':'+a.score).join(' '));
 console.log('sim',JSON.stringify({m:X.sim.manaByTurn.map(x=>+x.toFixed(2)),keep:X.sim.keep7,miss:X.sim.missLandDropT4,cmd:X.sim.cmdMedianTurn,onc:X.sim.cmdOnCurve,eff:X.sim.efficiency6}));
 console.log('bracket',X.bracket); console.log('pairs',X.synergy.pairs.filter(p=>p.active).map(p=>p.key+' '+p.en.length+'/'+p.pay.length+' '+p.status));
 console.log('recs',X.recs.map(r=>r.sev+' '+r.text.slice(0,90)+' ['+r.cards.map(c=>c.n).join(', ')+']'));
 console.log('mana',X.mana.colors.map(c=>c.color+' '+c.landSources+' '+c.warn));
 const X2=An.run(db,R.deck,R.commanders,{settings:R.settings});console.log('deterministic',JSON.stringify(X2.sim)===JSON.stringify(X.sim));
 const P=An.parseDecklist('Commander\n1 Synth Rainbow\n\nDeck\n'+R.deck.map(e=>e.qty+' '+e.c.n).join('\n'));console.log('parse',P.cmd.length,P.main.length);
 const P2=An.parseDecklist(R.deck.map(e=>e.qty+'x '+e.c.n).join('\n')+'\n1x Synth Rainbow [Commander{top}]');console.log('parse2',P2.cmd.map(x=>x.name),P2.main.length);
 console.log('hyp check P(2-5 lands|37/99)', An.run? X.prob.openingLands.p2to5.toFixed(3):'');
})();
