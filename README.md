# broken-stuff EDH generator

Two Commander (EDH) tools that run in your browser on Scryfall's full card data and Commander Spellbook's combo list:

- **Deck generator** (`index.html`): builds a legal 100-card deck for a commander, bracket, budget and game plan, then scores and explains it.
- **Card explorer** (`card.html`): look up any card and see the closest cards to it, ranked by how well they match, plus its 2-card combos.

The two pages link to each other from the header. In the generator, a card's popup has **Similar cards and combos ↗**, which opens that card in the explorer. In the explorer, a card that can be a commander has **Build a deck with it**, which opens the generator with that commander filled in.

Nothing you enter is sent anywhere. Card pictures, when turned on, load from `cards.scryfall.io`.

## Card explorer

Search a card by name. The card is in the middle with its prices (USD, EUR, MTGO). Its rules text, mana value, colour identity, EDHREC rank, legality, keywords, deck roles and mechanics are on the left. Recommendations are on the right. The address bar keeps the card name, so Back works and links can be shared (`card.html#Sol%20Ring`).

**Similar cards** gives every other card a match from 0 to 100%:

| Part | Weight | What it compares |
|---|---|---|
| Mechanics | 60 | Rules text wording, plus the mechanics both cards have (keywords, triggers, counters, tokens, roles, themes). Rare mechanics count more than common ones. |
| Mana cost | 20 | Mana value and colour identity |
| Type | 12 | Card types, subtypes, legendary or not |
| Stats | 8 | Power/toughness or loyalty (only for cards that have them) |

Each result shows its price, EDHREC rank, the mechanics it shares with your card, and a bar showing which parts the score came from.

- **Focus:** click a mechanic, such as Cascade, Enters trigger or +1/+1 counters, either on the left or in the Focus row. Only cards with that mechanic are kept. Each score is then half how alike their text for that mechanic is and half the overall match.
- **Filters:** colours (any, within the card's colour identity, or same identity), shared card type, maximum price, Commander-legal only.
- **Sort:** best match, lowest price, or most played.
- **Weights:** sliders change how much each part counts.

**2-card combos** lists every Commander Spellbook combo made of the card plus one other card, most played first. Each shows what the combo produces, any extra requirement, both prices, and a link to the steps.

When the page first opens, it takes a few seconds to read the rules text of every card before similar cards appear.

## Deck generator

Pick a commander, a bracket, a game plan, themes and a budget, then press **Generate deck**. The generator scores every eligible card and builds a legal 100-card deck. It then swaps cards until no single swap improves the deck, while staying inside your budget and bracket rules.

What it weighs for each card:
- EDHREC popularity
- a card-power estimate from rules text (fast mana, cheap interaction, tutors, card advantage)
- synergy with your commander and themes
- fit to the mana curve
- price, when you set a budget

The same settings always produce the same deck.

**Pages** (left menu; a tab strip on phones):

- **Setup:** commander, budget, game plan, themes and creature types.
- **Commanders:** browse every legal commander. Filter by name, text, colour or theme, then send one to Setup with **Build**.
- **Inspire me:** a seven-question quiz (colours, play style, creature type, themes, power, popularity, commander price). Every legal commander gets a match score and a list of reasons:
  - **Play style** (Aggressive, Control, Combo, Value engine, Go big) reads the commander's rules text, such as attack triggers, counterspells, board wipes, untap effects or cost reduction. Combo also counts the commander's Commander Spellbook combos.
  - **Creature type** checks the commander's type line and rules text, and counts the creatures of that type in its colours. Commanders that are or name the type come first.
  - **Themes** use the same synergy tags as Setup. **Power** looks at Game Changer status, infinite combos and the card-power estimate. **Popularity** is EDHREC rank among commanders.
  - Match is the weighted share of your answers it meets: play style 3, creature type 3, themes 2, power 1, popularity 1.
- **Surprise me:** three random commanders, filtered by colours, popularity (top 500 or outside the top 1,000) and price. Each shows its rules text, the play styles and themes it leans toward, and can be rerolled or sent to Setup with **Build**.
- **Deck:** the list grouped by type. Lock cards you want to keep. **Swap** shows the five best alternatives for a card. **Rebuild around locks** rebuilds while keeping locked cards (if the locked cards can't fit the budget, the current deck stays), and **Undo** reverts your last edit.
- **Primer:** a play guide built from the deck's own numbers, covering:
  - table talk for the pre-game conversation
  - mulligan odds and a turn-by-turn plan
  - interaction to hold and combos
  - tokens and counters to bring

  It can also print the list and primer, or nine text proxies per page.
- **History:** your last 25 decks and edits. Tick two to compare them.
- **Analysis:** scores any deck, generated or pasted. You get:
  - a power level from 1 to 10 and eight fundamentals
  - win turns and the bracket the cards imply
  - a goldfish simulation
  - turn-by-turn odds of drawing ramp, draw, removal and win conditions
  - swap suggestions you can accept or deny
- **Sample hand:** draw 7, take London mulligans, draw more.
- **Combos:** combos already in the deck, and combos one card away with that card's price. **+ Add** shows what to cut and checks the swap first: it won't add a card that breaks your bracket or budget (it says which rule). Two-card infinites your bracket doesn't allow are marked "not allowed" and listed last.
- **Stats:** curve, colour pips against sources, roles against targets, price, Game Changers, and a colour check of the odds of casting your most colour-hungry card on curve.
- **Export / Validation / Log:** copy the list, see the legality and budget checks, and see why cards were left out.

**Hover or tap any card name** for its cost, text, price, roles and why it is in the deck.

**Keys:** 1–9 and 0 open pages, G generates, / jumps to search, U or Ctrl/Cmd+Z undoes, Esc closes popups, ? shows the list.

**Clear** (top right) starts over. History, card data and appearance are kept.

## Appearance

The gear button (top right, on both pages) sets:
- light, dark or system mode
- accent colour
- text size
- serif or sans headings
- card pictures

The explorer shows pictures by default. The generator hides them by default.

## Card data

The site refreshes Scryfall card data and Commander Spellbook combos every Monday. Your browser keeps a copy and downloads again only when the data changes. On the generator's Setup page, under **Card data**, you can also load your own Scryfall bulk file (`.json`, `.jsonl` or `.gz`) from [scryfall.com/docs/api/bulk-data](https://scryfall.com/docs/api/bulk-data).

---

## For maintainers

- **Publishing:** Settings → Pages → Deploy from a branch → `main`, `/ (root)`.
- **Refreshing data now:** Actions → Data files → Run workflow. The workflow (`.github/workflows/data.yml`) does three things:
  - slims Scryfall's Oracle Cards file into `data/oracle-cards-*.jsonl.gz` with `tools/scryfall-slim.js`
  - splits Commander Spellbook's `variants.json` into `data/spellbook/` with `tools/spellbook-shard.js`
  - rewrites `data/index.json`
- **Building:** `index.html` and `card.html` are generated, so edit `src/` instead:

```sh
cd src
sh build.sh && sh build-site.sh && mv site/index.html ../index.html && rm -r site   # deck generator
sh build-card.sh                                                                    # card explorer
node test.js && node atest.js && node stest.js                                      # tests on synthetic cards
```
