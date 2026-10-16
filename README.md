# broken-stuff EDH generator

A Commander (EDH) deck builder and analyser that runs entirely in the browser from Scryfall's bulk card data. Pick a commander, a bracket, a game plan, themes and a budget. It builds a legal 100-card deck from every eligible card in the file, optimises it, and scores the result.

Live site: GitHub Pages serves `index.html` from this repository. No server or API calls are needed for deck building; the only network requests are for the card file in `data/`.

## How a deck is built

1. **Card data.** The Scryfall file is read line by line. Tokens, emblems, art cards and non-English printings are dropped, and reprints are merged into one entry per card. With the current Oracle Cards file that is 38,751 records → 34,988 unique cards → 32,116 legal in Commander.
2. **Candidate pool.** Every card is checked against the commander's colour identity, legality, the bracket's hard limits (Game Changers, mass land denial, extra turns), your filters, your exclude list and the per-card price cap. The Log tab lists each exclusion reason with counts. Example: Sigarda, Font of Blessings at Bracket 2 with a $50 cap gives 12,005 candidates.
3. **Card score.** Each candidate gets one score from:
   - EDHREC popularity rank (log scale);
   - a card-power estimate from rules text (fast mana, cheap interaction, tutors, card advantage engines);
   - synergy with the commander and chosen themes or creature types;
   - fit to the target mana curve;
   - price, only when a budget is set;
   - a bracket preference that leans toward stronger cards at higher brackets.

   The weights are fixed defaults. The Deck shape, Rules and Advanced panels are hidden in this version; saved or shared settings that set them still apply.
4. **Baseline.** A first pass fills nonbasic lands, then the role slots (ramp, draw, removal, wipes, protection, recursion, win conditions), then theme slots. Theme slots rotate across your themes so no single theme crowds out the others. Basics are split by colour-pip share.
5. **Optimiser.** It scores every movable deck card against every pool card for one deck-level score:
   - the sum of card scores;
   - pair synergy: 2√(enablers × payoffs) for each theme, which rewards a balanced mix of enablers and payoffs;
   - a penalty for any role slot below its target;
   - a penalty for average mana value drifting from the target.

   It applies the best swaps that pass every rule (budget, bracket limits, creature limits, combo rules), then re-scans, until no single swap raises the score.

   A swap blocked by the total budget can be paired with a cheaper swap elsewhere, including trading a nonbasic land for a basic, when the pair raises the score overall. For Sigarda at $50 this scores about 4.3 million card pairs in about 1 second.
6. **Validation.** The final deck is checked for size, legality, colour identity, singleton rule, budget and bracket limits. Anything that fails is repaired, and the checks are listed on the Validation tab.

### Same settings, same deck

Generation is deterministic. The random seed is a hash of the settings, the score has no random component, and the optimiser stops on a fixed round count rather than a timer. Generate and Rebuild with unchanged settings and card data return the identical list (checked for four commander/bracket/budget combinations, three runs each, and after a page reload).

### What "optimal" means here

The result is a local optimum of the deck score above, checked by brute force: re-scoring every feasible single swap (more than 500,000 for the Sigarda example) finds none that raises it. It is not a proof of the best possible deck under any definition, for two reasons:

- the score is only as good as its inputs (popularity rank, rules-text patterns, hand-set weights);
- swaps of three or more cards at once are not searched.

## Score bar

A bar above the tabs shows, for the current deck: power level, fundamentals, deck score (the optimiser's objective), total price against the budget cap, bracket (flagged when the cards imply a higher one) and typical win turn. It updates after every edit.

## Analysis

The Analysis tab scores any deck, whether generated or pasted. It is split into Overview, Turn by turn, Power, Fundamentals, Mana & interaction, Synergy and Method:

- eight fundamentals axes;
- a power level from 1 to 10 built from speed, consistency, interaction, mana base and threats;
- best, typical and contested win turns;
- the minimum bracket implied by the cards;
- a seeded goldfish simulation (up to 100,000 games);
- expected state for turns 1–10: cards seen, lands, mana available and spent, spells cast, hand size, land-drop and commander-cast rates, and exact odds of having seen at least one ramp, draw, removal, wipe or win-condition card;
- exact draw odds;
- swap recommendations with projected effects, which you can accept or deny.

## Primer

The Primer tab is a play guide built only from the deck's own numbers: archetype, commander cast-turn distribution, strongest themes, mulligan odds, a turn-by-turn plan (which ramp, engines and win conditions to deploy, with expected lands and mana), interaction and protection to hold, one-sided versus symmetric wipes, Spellbook combos and the most-linked synergy pieces.

## History

The History tab keeps the last 25 decks and revisions in the browser (IndexedDB). Each generate and each accepted swap, replacement or removal is an entry with price, power and deck score. Opening an entry rebuilds it from its settings and replays its edits, then confirms the card list is identical or reports how many cards differ because the card data has changed.

**Compare** scores the generated deck and any pasted list side by side, with the same rules and the same random seed.

## Data files

The site loads the newest Scryfall bulk file in `data/` automatically:

| File | Source |
|---|---|
| `data/oracle-cards-*.jsonl.gz` (also `.json`, `.jsonl`, `.json.gz`; `default-cards-*` accepted) | Scryfall bulk data: https://scryfall.com/docs/api/bulk-data |

- **How the newest file is found.** The page lists `data/` through the GitHub contents API, which allows 60 requests an hour per visitor IP. If that fails, it tries `data/cards.json.gz`, `data/cards.json` and `data/cards.jsonl.gz`.
- **Caching.** A file is downloaded only when its Git hash changes. Otherwise the copy stored in the browser (IndexedDB) is used.
- **Updating.** Upload the new Scryfall file to `data/` and delete the old one. Pages redeploys on its own. GitHub rejects files over 100 MB, so keep the `.gz` form.
- **Your own file.** Anyone can load their own file under Data source (`.json`, `.jsonl` or `.gz`).

## Publishing (once)

Settings → Pages → Build and deployment → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.

## Source and build

`index.html` is generated. Edit the files in `src/`, then:

```sh
cd src
sh build.sh                     # src/edh-deck-generator.html (single file)
sh build-site.sh && mv site/index.html ../index.html && rm -r site
node test.js && node atest.js   # engine and analysis tests on synthetic cards
node sens.js                    # sensitivity of scores to bracket, budget and game plan
```
