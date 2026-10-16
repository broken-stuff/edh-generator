# broken-stuff EDH generator

A Commander (EDH) deck builder and analyser that runs entirely in the browser from Scryfall's bulk card data. Pick a commander, a bracket, a game plan, themes and a budget. It builds a legal 100-card deck from every eligible card in the file, optimises it, and scores the result.

Live site: GitHub Pages serves `index.html` from this repository. The page makes no API calls; it only requests static files from `data/` on the same site (card data and Commander Spellbook combos).

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

## Layout

The left menu has three groups: Build (Setup, Commanders, Deck, Primer, History), Evaluate (Analysis, Sample hand, Combos, Stats, By role) and Output and checks (Export, Validation, Log, Tests). Setup holds the commander, budget and game plan; generating a deck opens the Deck page. On phones the menu becomes a scrolling tab strip.

**Card names.** Hover a card name (mouse) or tap it (touch) for its mana cost, type, rules text, P/T or loyalty, price, EDHREC rank, role tags, flags and, for cards in the deck, why the generator picked it. Ctrl/Cmd-click opens Scryfall.

**Card images** are off by default. Appearance → Card images → On shows pictures in the popover and the sample hand. They load from `cards.scryfall.io`, Scryfall's image host; this is the only thing the page ever loads from outside the site, and only when turned on.

**Keys:** 1–9 and 0 open pages in menu order, G generates, / jumps to search, U or Ctrl/Cmd+Z undoes the last edit, Esc closes popups, ? shows the list.

**Undo** (next to Rebuild around locks) reverts the last swap, replacement, removal or combo add. It rebuilds the deck from its settings and replays every edit but the last, which gives the same list because generation is deterministic. Cards you locked by hand stay locked.

On phones the deck list shows one card per row (name, cost, price, roles, reason, actions) instead of a wide table.

**Clear** (top right) starts over: it removes the current deck, analysis and swap decisions and resets Setup to defaults. History, the loaded card and combo data and Appearance are kept.

**Appearance** (gear button, top right) sets light, dark or system mode, an accent colour (ink, blue, violet, pink, green, orange, teal), text size (S, M, L, XL) and serif or sans headings. The choice is stored in the browser.

## Card explorer

`card.html` (linked from the header of both pages) looks up any card. Search by name; the card is shown in the middle (picture from `cards.scryfall.io`, or a text card when Appearance → Card images is Off), its rules text, mana value, colour identity, EDHREC rank, legality, printings, keywords, deck roles and detected mechanics on the left, and recommendations on the right. The card name is kept in the URL (`card.html#Sol%20Ring`), so Back and shared links work. It reads the same `data/` files and the same stored browser copy as the generator, and makes no API calls.

**Similar cards** ranks every other card by a match from 0 to 100%, the weighted mean of four parts:

| Part | Default weight | How it is measured |
|---|---|---|
| Mechanics | 60 | ½ cosine similarity of rules text (words and word pairs, TF-IDF weighted, card names replaced) + ½ IDF-weighted overlap of detected mechanics: keywords, triggers (enters, dies, attacks, cast, upkeep…), counters, token types, the generator's role, flag and theme rules |
| Mana cost | 20 | 60% mana value (−25% per point of difference), 40% colour identity overlap |
| Type | 12 | 70% card types, 20% subtypes, 10% legendary or not |
| Stats | 8 | power and toughness (−12.5% per point) or loyalty (−20% per point); left out for cards without them |

Each result shows its price, EDHREC rank, the mechanics it shares and a bar split by part. **Focus** (or clicking a mechanic on the left) keeps only cards with that mechanic and scores them ½ on how alike their lines with that mechanic are, ½ on the overall match. Filters: colours (any, within the card's identity, same identity), shares a card type, maximum price, Commander-legal only; sort by match, price or EDHREC rank; the four weights are adjustable. Indexing the rules text of ~35,000 cards takes a few seconds after the card data loads.

**2-card combos** lists every Commander Spellbook combo made of the card and one other card, most played first, with what it produces, any extra requirement, both prices and a link to the steps.

## Commanders

Lists every legal commander in the card data. Filter by name, type or rules text, by colour (within, exactly or including the chosen colours) and by theme (the generator's own synergy tags matched against the commander's text). Sort by EDHREC popularity, price or mana value. Build puts the commander into Setup.

## Sample hand

Draws a 7-card hand from the generated list with the browser's random generator, so each hand is new. Mulligan follows the London rule with the first mulligan free (multiplayer): draw 7, then tap one card per later mulligan to put it on the bottom. Draw a card continues from the library. The Primer and Analysis odds come from the seeded simulation, not from this page.

## Score cards

Six cards above every page show, for the current deck: power level, fundamentals, deck score (the optimiser's objective), total price against the budget cap, bracket (flagged when the cards imply a higher one) and typical win turn. It updates after every edit.

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

## Stats

Mana curve, colour pips against sources, role counts against targets, price, Game Changers, combos and synergy tags. **Colour check** finds, for each colour, the card that is hardest to cast on curve (most pips of that colour for its mana value) and gives the exact hypergeometric chance of having drawn that many sources by that turn on the play. Frank Karsten's guideline is 90%; lower values are shown in red.

## Primer

The Primer tab is a play guide built only from the deck's own numbers. **Table talk** opens it: the bracket, typical win turn and counts of Game Changers, tutors, fast mana, extra turns, mass land denial, stax and Spellbook combos, for the pre-game conversation. Then: archetype, commander cast-turn distribution, strongest themes, mulligan odds, a turn-by-turn plan (which ramp, engines and win conditions to deploy, with expected lands and mana), interaction and protection to hold, one-sided versus symmetric wipes, Spellbook combos and the most-linked synergy pieces. **Tokens, emblems and counters to bring** lists token types (for example Treasure, 1/1 white Soldier creature), markers (monarch, initiative, energy, poison, day/night) and counters, read from rules text with reminder text removed.

**Print primer and list** prints the decklist in three columns followed by the primer. **Print proxies** prints a text proxy for every card except basic lands at 63 × 88 mm, nine per page (Letter or A4): name, cost, type line, rules text and P/T.

## History



The History tab keeps the last 25 decks and revisions in the browser (IndexedDB). Each generate and each accepted swap, replacement or removal is an entry with price, power and deck score. Opening an entry rebuilds it from its settings and replays its edits, then confirms the card list is identical or reports how many cards differ because the card data has changed.

**Compare two entries:** tick two rows and press Compare selected for the cards out and in and the change in price, power, deck score, fundamentals and bracket.

**Compare** (Analysis) scores the generated deck and any pasted list side by side, with the same rules and the same random seed.

## Data files

Everything the page loads comes from this site's `data/` folder. The page makes no API calls.

| Path | What it is | How it gets there |
|---|---|---|
| `data/oracle-cards-*.jsonl.gz` (also `.json`, `.jsonl`, `.json.gz`; `default-cards-*` accepted) | Scryfall Oracle Cards (https://scryfall.com/docs/api/bulk-data), cut to the fields the page reads | Refreshed by the **Data files** workflow every Monday when Scryfall has published a newer file, or on demand. A hand upload of the full file also works; delete the old one. |
| `data/index.json` | List of files in `data/` with size and SHA-256 | Written by the **Data files** workflow after every push to `data/`. |
| `data/spellbook/` | Commander Spellbook combos in compact form | Rebuilt by the **Data files** workflow every Monday, or on demand. |

- **Finding the card file.** The page reads `data/index.json` and picks the newest Scryfall file. If the index is missing, it falls back to the GitHub contents API, then to `data/cards.json.gz`, `data/cards.json` and `data/cards.jsonl.gz`.
- **Caching.** Card and combo files are downloaded only when their hash or manifest changes. Otherwise the copy stored in the browser (IndexedDB) is used.
- **Your own card file.** Anyone can load their own file under Card data (`.json`, `.jsonl` or `.gz`).

### Scryfall card data

`tools/scryfall-slim.js` streams Scryfall's Oracle Cards file and keeps only the fields `Engine.norm()` reads (name, cost, type, rules text, P/T, loyalty, colour identity, Commander legality, prices, EDHREC rank, Game Changer and reserved flags, set, dates, keywords, produced mana, the Scryfall link and the "normal" image path). On the 16 Oct 2026 file it went from 25 MB to 7.1 MB gzipped (38,751 cards), and the page builds identical card records from either file apart from the tracking suffix on Scryfall links. The workflow asks `api.scryfall.com/bulk-data/oracle-cards` for the current file name (`jsonl_download_uri`), downloads it only if it is new, slims it, replaces the old file and commits. Weekly commits of about 7 MB grow the repository by roughly 350 MB a year.

```sh
node tools/scryfall-slim.js oracle-cards-20261016090200.json data/oracle-cards-20261016090200.jsonl.gz
```

### Commander Spellbook combos

Spellbook publishes every combo in one file, `https://json.commanderspellbook.com/variants.json`. It is several hundred MB because each combo repeats full card records with image links and step-by-step text. The `.gz` copy is served with `Content-Encoding: gzip`, so browsers and many download tools unpack it on arrival and save plain JSON under a `.gz` name, which then fails to open as gzip.

`tools/spellbook-shard.js` streams that file (plain or gzip, detected from the bytes rather than the name). It keeps what the generator and the Combos page use and writes:

| File | Contents |
|---|---|
| `manifest.json` | Source, Spellbook timestamp and version, counts, list of shards |
| `tables.json` | Card, result ("feature") and requirement ("template") names |
| `variants-NNN.json` | 20,000 combos per file, as `[id, cards, results, requirements, colour identity, mana value, bracket tag, popularity, flags]` using indices into the tables |

Only combos with status OK or Example that are legal in Commander are kept. On a 316 MB test file in the export format, the output was four shards of about 1.1 MB each, and every row matched the source field by field.

The step-by-step text is not kept. The Combos page links each combo to commanderspellbook.com for its steps; that is a link, not a request the page makes.

**Workflow.** `.github/workflows/data.yml` runs on GitHub, not in the browser. It refreshes the Scryfall file (above), downloads `variants.json`, runs the converter, rewrites `data/index.json` and commits any changes. To refresh now: Actions → Data files → Run workflow. Scryfall and Spellbook are ticked by default; "Re-download Scryfall card data" fetches the card file even when its name hasn't changed.

**Running it locally:**

```sh
curl -L --compressed -o variants.json https://json.commanderspellbook.com/variants.json
node tools/spellbook-shard.js variants.json data/spellbook
node tools/data-index.js data
```

### How combos are used

- **Generation** follows the bracket's 2-card-infinite limit and the Combos filter (allow, prefer, exclude).
- **Analysis** counts combo families toward the threat score and the minimum bracket.
- **Combos page** lists combos complete in the deck and combos one card away, with the missing card and its price. **+ Add** next to a missing card opens a picker for the card to cut (nonland cards outside every found combo, locked-out and includes excluded, weakest first) and shows the price after the swap, a warning if it adds a 2-card infinite or Game Changer the bracket doesn't allow, and any role it removes. **Add and lock** makes the swap, locks the new card and records it in History. Its search covers every combo by card name or result, filtered by colour identity, number of cards and infinite-only.

A combo counts as assembled only when every card is in the list. Combos that also need a card *type* (for example "a sacrifice outlet") are shown in search but never counted, because that requirement can't be checked automatically. Combos that need a specific card as commander count only when it is the commander.

## Publishing (once)

Settings → Pages → Build and deployment → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.

## Source and build

`index.html` and `card.html` are generated. Edit the files in `src/`, then:

```sh
cd src
sh build.sh                     # src/edh-deck-generator.html (single file)
sh build-site.sh && mv site/index.html ../index.html && rm -r site
sh build-card.sh                # ../card.html (card explorer: engine.js + similar.js + card.js)
node test.js && node atest.js && node stest.js   # engine, analysis and card-explorer tests on synthetic cards
node ../tools/spellbook-shard.js variants.json ../data/spellbook   # combo files (see Commander Spellbook combos)
node sens.js                    # sensitivity of scores to bracket, budget and game plan
```
