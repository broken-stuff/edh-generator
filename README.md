# broken-stuff EDH generator

Commander (EDH) deck tools that run entirely in your browser, built on [Scryfall](https://scryfall.com)'s card data and [Commander Spellbook](https://commanderspellbook.com)'s combo list.

**Use it:** [broken-stuff.github.io/edh-generator](https://broken-stuff.github.io/edh-generator/)

| Page | What it does |
|---|---|
| **Deck generator** (`index.html`) | Builds a legal 100-card deck for a commander, bracket, budget and game plan, with one headline power score and export. **All tools** adds analysis, measured upgrades, a play primer, collection support and a hand Builder. |
| **Card explorer** (`card.html`) | Looks up any card and ranks the cards most like it, with prices and its 2-card combos. |

No account, server or install. Nothing you enter leaves your browser. The only outside requests are the site's own data files and, if you turn them on, card pictures from `cards.scryfall.io`.

## Contents

- [How to use](#how-to-use)
- [Deck generator](#deck-generator)
- [Card explorer](#card-explorer)
- [Appearance](#appearance)
- [Card data](#card-data)
- [How it works](#how-it-works)
- [Development](#development)
- [Credits and legal](#credits-and-legal) (MIT License)

## How to use

Open the [deck generator](https://broken-stuff.github.io/edh-generator/). Card data loads the first time (a few seconds) and stays in your browser. It opens in **Quick** mode, which has two pages:

1. **Build.** Pick a commander (or **Find a commander**: Browse, Quiz, Random), a power level (Commander Bracket), a budget and a game plan, then press **Generate deck** (`G`).
2. **Deck.** The list, with one headline score (power level out of 10). Tap **Bracket, win turn and price** under it for the rest. Tap a card to lock, swap or remove it; **Rebuild around locks** rebuilds the rest. **Export** copies or downloads the list for Moxfield, Archidekt, MTGO or plain text.

The [card explorer](https://broken-stuff.github.io/edh-generator/card.html) ranks the cards most like any card, with prices and its 2-card combos. A card's popup in the generator links to it, and the explorer's **Build a deck with it** opens the generator with that commander filled in.

**All tools** (Appearance, the gear at the top) brings back every page described below: Collection, Builder, Import, Analysis, Improve, Primer, Counts, Sample hand, Build log and Tests. The choice is kept in this browser. In Quick mode the Collection tile and the **Mechanics only** card choice still show while they are in use, so a setting can't apply unseen.

### With All tools

The **Start** page shows four step tiles, each with its status and a link to its page. Work through them in order:

1. **Collection** (optional). Paste your cards (`1 Card Name` or just the name) or load a CSV export with a Name column (ManaBox, Moxfield, Archidekt, Deckbox). Then pick a mode:
   - **Mark:** owned cards get a green dot. Builds and suggestions use all cards.
   - **Prefer:** new decks favour your cards.
   - **Only mine:** new decks and all suggestions use only your cards (basic lands always allowed).
2. **Deck.** On Start, either:
   - **Build a deck:** fill the tiles (Commander, Power, Budget, Collection, Game plan and themes) and press **Generate deck** (`G`). **Find a commander** helps you pick one (Browse, Quiz, Random).
   - **Import my deck:** paste a list (Moxfield, Archidekt, MTGO, CSV or `1 Name`). It is kept exactly as pasted. If it is under 100 cards, **Fill to 100** (on Analysis and in the Deck summary) keeps every card and adds the rest from your Start settings.
   - Or build it yourself on **Builder**: pick a commander, then pick cards from your collection by role, theme, mana value and type, with a live tracker against real decks of your bracket. **Analyze this deck** sends it to Analysis.
3. **Analysis.** Power level, bracket, win turn, problems, and role counts against real decks of your bracket.
4. **Improve.** Measured changes, from **All cards** or **My collection**:
   - **Suggested swaps:** cuts and adds scored with simulated games; accept or deny each. **Deep search** looks wider.
   - **By category:** pick a category (Ramp, Card draw, Removal…) to get adds for it, each paired with a cut that keeps the other categories in range.
   - **By card:** up to three better cards per card, one per price band.
   - **Budget upgrades:** the best set of swaps for a set amount ($20, $50, $200 or custom).
   - **Combos:** combos in the deck and ones one or two cards away.

**Primer** gives a play guide; **Deck › Export** copies the list (or only the cards added since build/import, for a store's mass entry).

The two pages link to each other. In the generator, a card's popup has **Similar cards and combos ↗**, which opens that card in the explorer. In the explorer, a card that can be a commander has **Build a deck with it**, which opens the generator with that commander filled in.

## Deck generator

Pick a commander, a bracket, a game plan, themes and a budget, then press **Generate deck**. The generator scores every eligible card and builds a legal 100-card deck. It then swaps cards one at a time until no single swap improves the deck, while staying inside your budget and bracket rules. The same settings always produce the same deck.

Each card is weighed on:
- EDHREC popularity
- a card-power estimate from its rules text (fast mana, cheap interaction, tutors, card advantage)
- synergy with your commander and themes
- fit to the mana curve
- price, when you set a budget

**Card choice: Mechanics only** (on Start, under Game plan) builds without EDHREC popularity. Each card is weighed instead on:
- the commander's **plan profile**, read from its own rules text: mechanics it has or names (ninjutsu, mutate, goad, offspring, energy and the rest), creature types and card types it rewards ("other Zombies you control", "instant and sorcery spells"), power or mana value bounds it names, and links in the mechanics graph. The deck holds a quota of plan cards, and the curve target comes from the plan cards' own mana values. The Deck stats show the plan and how many cards meet it.
- a **card-quality model** on rules-text features (roles, mana value, efficiency, card types, abilities), fitted on the reference decks with no popularity field among its inputs, so new and unplayed cards are judged on what they do
- the card-power estimate without its popularity term, curve fit and price

Analysis, Improve and deep search on a mechanics-only deck use the same quality model in place of EDHREC rank. Standard builds are unchanged.

With **All tools** on, the pages are in the left menu (a bar at the bottom on phones) and follow the order you use them in: **Start**, **Collection**, **Builder**, **Deck**, **Analysis**, **Improve** and **Primer** (under More on phones). **More** holds History, Build log and Tests. Pages with more than one view have a row of tabs under the title. The KPI tiles (power, bracket, win turn, price) show on Analysis; the other deck pages show the same numbers in one line.

### Start

Four step tiles at the top show where you are: **Collection**, **Deck**, **Analysis** and **Improve**, each with its status (cards in the collection, the deck's commander and price, its power and win turn, the measured swaps worth making) and a link to its page.

- **Build a deck:** tiles for the commander (and partner), power (Commander Bracket), budget and your collection (mark, prefer or only), then game plan and themes; creature types, deck type and card choice are folded under the plan. **More settings** holds include and exclude lists, price settings and save, load and share. **Save, load, share** saves settings as a JSON file, loads one back, or gives a share token: add it to the page address as `#token` and anyone who opens that link gets the same settings.
- **Import my deck:** paste your current list (Moxfield, Archidekt, MTGO, CSV or plain `1 Name`; set codes, collector numbers, `*F*`/`*E*`, Archidekt `[Category]` and `^Tag^`, and Moxfield `#tags` are ignored; Archidekt maybeboard and sideboard cards are left out). The commander is read from a `Commander` or `// COMMANDER` header, a `[Commander]`, `#!Commander` or `*CMDR*` tag, or a `SB:` line. Without one, the importer looks where exports put it: the last block after a blank line, the sideboard, a first block of its own, or the first or last card of a 100-card list; it says where it found it, and if it finds none it lists the legendary cards to pick from. Double-faced and split cards match by either face or with `/`, `//` or `///`; Universes Beyond flavour names (such as Secret Lair printings) match their Oracle card through `data/aliases.json`. The deck is kept exactly as pasted: nothing is added, removed or swapped, and budget, bracket and include/exclude settings are not applied. Analysis opens first, with the deck's problems and role counts; Improve measures cuts and adds. Rule problems, such as a deck that isn't 100 cards, show under **Rules** on Deck. A deck under 100 cards gets **Fill to 100** (on Analysis, next to the card count, and in the Deck summary): it keeps every card you have, locked, and adds the missing ones from your Start settings (bracket, game plan, themes, collection mode and per-card cap; the total budget cap is not applied, since the kept cards may already be over it). Deck, Swap, Combos, Primer and Export work on the imported list too.
- **Find a commander**, three ways. Each sends a pick to Build a deck with **Build**.
  - **Browse:** every legal commander. Filter by name, text, colour or theme.
  - **Quiz:** a seven-question quiz (colours, play style, creature type, themes, power, popularity, commander price). Every legal commander gets a match score and its reasons:
    - **Play style** (Aggressive, Control, Combo, Value engine, Go big) reads the commander's rules text, such as attack triggers, counterspells, board wipes, untap effects or cost reduction. Combo also counts the commander's Commander Spellbook combos.
    - **Creature type** checks the commander's type line and rules text, and counts the creatures of that type in its colours. Commanders that are or name the type come first.
    - **Themes** use the same synergy tags as New deck. **Power** looks at Game Changer status, infinite combos and the card-power estimate. **Popularity** is EDHREC rank among commanders.
    - Match is the weighted share of your answers it meets: play style 3, creature type 3, themes 2, power 1, popularity 1.
  - **Random:** three random commanders, filtered by colours, popularity (top 500, or outside the top 1,000) and price. Each shows its rules text and the play styles and themes it leans toward. Reroll any one.

### Collection

Paste the cards you own (one per line, `1 Card Name` or just the name, or a CSV export with a Name column from Moxfield, Archidekt, Deckbox or ManaBox), or load a file. Names not in the card data are listed. Then choose how to use it:
- **Mark the cards I own:** a green dot after every card you own, everywhere a card name is shown, and "In your collection" in its popup. Builds and suggestions use all cards.
- **Prefer cards I own:** new decks favour your cards (the Owned bonus weight).
- **Only cards I own:** new decks and every suggestion on Analysis and Improve (suggested swaps, deep search, By card, Budget upgrades, combos one card away) use only your cards. Basic lands are always allowed.

With a deck loaded the page shows how many of its nonbasic cards you own and what the rest cost, with **Copy the cards to get** for a store's mass entry. The list is kept in your browser with your settings.

### Builder

Build a deck by hand from your collection.

- **Before a commander is picked:** your collection broken down by role (the Deck › Counts categories: lands, ramp, card draw, spot removal, counterspells, board wipes, protection, tutors, recursion, win conditions, and nonland cards with no role), by synergy theme (the generator's theme tags), by card type and by colour identity. A card counts in every role and theme it matches. Pick a commander from the list (yours first) or search any legal one.
- **Cards offered:** Commander-legal cards inside the commander's colour identity, from **My collection** (basic lands always available) or **All cards**. Category chips (All, each role, each synergy theme, No role) show the deck's count against its target and how many cards are available. Filter by mana value (0–1 to 6+), card type and text, and sort by popularity (EDHREC rank), mana value, name or price. **+** adds a card, **✓** removes it.
- **Synergy themes** are read from the commander's rules text the way the generator reads them (for example Tribal: Elf for Lathril); add or remove any theme, or add a creature type.
- **Tracker** (beside the list; a bar above it on phones, tap for the full panel): cards out of 99 (98 with two commanders), each role and card type (creatures, instants, sorceries, artifacts, enchantments, planeswalkers) against a target, average mana value, the mana curve, each colour's share of the pips next to the lands that make it, basic lands (+/− per type, or **Fill basics** to the land target split by pips), and the deck grouped by type. Targets start at the median of the reference decks for the bracket you choose (B1–B5) and can be changed; a row is red below the 25th percentile, green inside the middle half, amber above it. Type and average-MV ranges come from the same 822 Archidekt decklists as Deck › Counts (`node tools/ref-roles.js` recomputes both tables).
- **Editing: Current deck** (shown once you have a generated or imported deck; **Edit in Builder** in the Deck summary and on Analysis opens it): the Builder edits the working deck itself. Every add or take-out shows straight away on Deck, Counts, Analysis and Improve, is kept in History, and **Undo** (`U`) takes it back. Cards you add are locked; cards you take out are left out of **Rebuild around locks** until you add them back. Basic lands +/− and **Fill basics** change the deck's basics. Under 100 cards, **Fill to 100** adds the rest from your Start settings. With **My collection**, the deck's own cards stay listed whether you own them or not.
- **Editing: Draft:** a separate list kept in your browser. **Analyze this deck** imports it as it is, so Analysis, Deck, Improve (including **Fill to 100**) and Export work on it; **Copy list** copies it with Commander and Deck sections; **Load the current deck** copies the working deck into the draft.

### Deck

- **Cards:** the list, grouped by type or by role (ramp, draw, removal and so on). Tap a card for its text, price, roles, why it is in the deck, and its actions: **Lock** keeps it on rebuild, **Swap** shows the five best alternatives, **Remove** takes it out. **Rebuild around locks** rebuilds while keeping locked cards (if they can't fit the budget, the current deck stays). **Undo** reverts your last edit. **Rules** in the summary opens the legality and budget checks.
- **Counts:** how many cards the deck has for each job (lands, ramp, card draw, spot removal, counterspells, board wipes, protection, tutors, recursion, win conditions), next to the typical range for real decks: the middle half (25th to 75th percentile) of the Archidekt decklists in `data/reference/` for the chosen bracket, counted with the generator's own role tags. Each row says Low, Typical or High and lists its cards. Works on generated and imported lists; counterspell ranges use blue decks only. `node tools/ref-roles.js` recomputes the ranges.
- **Sample hand:** draw 7, take London mulligans, draw more.
- **Export:** copy or download the list. **Added cards only** lists the cards added since the deck was generated or imported (combo adds, upgrades, accepted swaps) as `1 Card Name` lines for a store's mass entry (TCGplayer, Card Kingdom).

### Analysis

Scores the current deck, generated or imported, or compares it with another list. The top of the page shows fundamentals, balance, lands against the curve estimate, cards that are hard to cast on curve, the commander turn, the simulated combo turn, and where the win turn comes from. Below that, on the same page:
- **Problems**, high and medium first; low and info notes are folded away.
- **Counts against real decks**, the same table as Deck › Counts.
- **Next: Improve**, with the number of candidate swaps, where they come from (all cards or your collection) and how much of the deck you own.

Buttons under the source switch jump to each section. **Compare** scores another pasted list against the deck.

**Show detail** opens turn-by-turn odds and the goldfish simulation (1,500 to 100,000 games), the power level from 1 to 10 with its five vectors and combos, the eight fundamentals, mana base and interaction, synergy themes, deck stats (mana curve, colour pips against sources, roles against targets, price, Game Changers) and the method.

### Improve

**Suggest cards from** (at the top of every Improve view): **All cards**, or **My collection**, the same switch as **Only cards I own** on Collection. It takes every add in suggested swaps, candidate cards, deep search, By card, Budget upgrades and combos one card away only from your collection list. Basic lands are always allowed. With **All cards**, adds you own carry the green dot.

- **Suggested swaps:** recommended cuts and adds for the analyzed list, each scored with simulated games. Accept or deny them one at a time, by group or all at once. Candidate cards for each problem are under the list. **Deep search** (10–30 s, runs in background workers, with a progress bar and Cancel) screens several hundred candidate adds at 1,500 simulated games, confirms the best 60 at 5,000, includes cards and pairs that complete Commander Spellbook combos, and builds a package of swaps chosen one after another on the list as changed so far, so synergy between the added cards counts. A refinement pass then retries each package swap against other adds and cuts, or without it. **Thorough** (~1 min on 4 cores) screens more cards and cuts, confirms 80, and builds the package with a three-wide beam search. Its swaps join the list for you to accept or deny. Candidates are ordered by EDHREC play rate first and theme fit second, plus the best-fitting cards by theme alone. Each swap must gain at least 1 (0.1 power level) and the package at least 3 (0.3 power level); below that the list is shown as near optimal, since accepting and re-running would keep finding ever smaller gains. Each group shows its best 3; gap and upgrade suggestions that measure below 1, the rest of each group and the deep search's single swaps are behind Show. A card cut by an accepted swap is not suggested again, and a card it added is not cut, so swaps cannot go back and forth.
- **By category:** one tile per count category (Lands, Ramp, Card draw, Spot removal, Counterspells in blue decks, Board wipes, Protection, Tutors, Recursion, Win conditions) with the deck's count and the typical range for its bracket (red below, amber above, as on Deck › Counts). Pick one and the 10 best-fitting cards in that category (Commander-legal, in your colours, inside bracket limits and the per-card price cap, from your collection if set) are each measured as a swap at 3,000 simulated games. The best gains are ticked, as many as it takes to reach the median (1 to 5). Cuts for the ticked cards are chosen together on running counts: every add's categories are counted first, then each cut must leave every category it belongs to at or above the low end of its range; cards from over-supplied categories go first, then the lowest value. A card in the category being filled, a locked card, a combo piece and the commander are never cut; a basic land only while lands are above range. Each cut has a menu of the next options. **Counts after** shows every category that changes, **Measure together** scores the whole set, and **Apply** makes the swaps after the deck rules pass.
- **By card:** every nonland card in the list with up to three better cards, one per price band (up to the card's price or $1, up to 3× it or $5, above), each measured as a swap at 1,500 games (~20 s in background workers). Options that gain less than 0.5 are left out, and one card is offered for at most two cards in the list. Swap applies one.
- **Budget upgrades:** pick $20, $50, $200 or another amount. The page finds the set of swaps that raises the deck most for at most that much: each add is Commander-legal and inside your colour identity and bracket limits, and each replaces the most replaceable card (lowest value that keeps every role at its target; never the commander, a combo piece or a card you locked; lands replace a basic of your most over-supplied colour). Candidates are measured with 3,000 simulated games on the same shuffles as the current list (gain = 10 × power level change + fundamentals change) and the best set within the amount is chosen by knapsack. The whole set is then measured together. **Apply** or **Apply all** makes the swaps; **Copy buy list** copies the adds as `1 Card Name` lines.
- **Combos:** combos already in the deck, and combos one or two cards away with each missing card's price. **+ Add** (one card) or **+ Add 2 cards** pairs each missing card with a suggested cut, which you can change, and checks the whole change first: it won't add cards that break your bracket or budget, and says which rule. Two-card infinites your bracket doesn't allow are marked "not allowed" and listed last.

### Primer

A play guide built from the deck's own numbers: table talk for the pre-game conversation, mulligan odds and a turn-by-turn plan, interaction to hold, combos, and tokens and counters to bring. It can print the list and primer, or nine text proxies per page.

### More

- **History:** your last 25 decks and edits. Tick two to compare them.
- **Build log:** the seed, the optimiser's score, and each step the generator took, including why cards were left out.
- **Tests:** runs acceptance tests against the loaded card data (1-colour, 5-colour and partner commanders, budget cap, impossible budget, determinism, Bracket 2 Game Changer count).

### Anywhere in the generator

- **Hover or tap a card name** for its cost, text, price, roles, whether you own it and why it is in the deck. On a computer it opens beside the name; on a phone it slides up from the bottom. With card images on, the picture sits left of the text.
- **Keys:** `1`–`7` open Start, Collection, Builder, Deck, Analysis, Improve and Primer, `G` generates, `/` jumps to search, `U` or `Ctrl/Cmd+Z` undoes, `Esc` closes popups, `?` lists the keys.
- **Clear** (top right) starts over. History, card data and appearance are kept.

## Card explorer

Search a card by name. The card is in the middle with its prices (USD, EUR, MTGO). Its rules text, mana value, colour identity, EDHREC rank, legality, keywords, deck roles and mechanics are on the left. Recommendations are on the right. The address keeps the card name, so Back works and links can be shared (`card.html#Sol%20Ring`).

**Similar cards** gives every other card a match from 0 to 100%:

| Part | Weight | What it compares |
|---|---|---|
| Mechanics | 60 | Rules text wording, plus the mechanics both cards have (keywords, triggers, counters, tokens, roles, themes). Rare mechanics count more than common ones. |
| Mana cost | 20 | Mana value and colour identity |
| Type | 12 | Card types, subtypes, legendary or not |
| Stats | 8 | Power/toughness or loyalty (only for cards that have them) |

Each result shows its price, EDHREC rank, the mechanics it shares with your card, and a bar showing which parts the score came from.

- **Focus:** click a mechanic, such as Cascade, Enters trigger or +1/+1 counters, on the left or in the Focus row. Only cards with that mechanic are kept, and each score becomes half how alike their text for that mechanic is and half the overall match.
- **Filters:** colours (any, within the card's colour identity, or same identity), shared card type, maximum price, Commander-legal only.
- **Sort:** best match, lowest price, or most played.
- **Weights:** sliders change how much each part counts.

**2-card combos** lists every Commander Spellbook combo made of the card plus one other card, most played first. Each shows what the combo produces, any extra requirement, both prices, and a link to the steps.

The first time the page opens, it takes a few seconds to read every card's rules text before similar cards appear.

## Appearance

The gear button (top right, on both pages) sets light, dark or system mode, accent colour, text size, serif or sans headings, card pictures and, in the generator, **Quick** or **All tools**. The explorer shows pictures by default; the generator hides them by default.

## Card data

The site refreshes Scryfall card data and Commander Spellbook combos every Monday. Your browser keeps a copy (IndexedDB) and downloads again only when the data changes. Settings, history and appearance are kept in `localStorage`.

To use other card data, open the generator's Start page and, under **Card data**, load a Scryfall bulk file (`.json`, `.jsonl` or `.gz`) from [scryfall.com/docs/api/bulk-data](https://scryfall.com/docs/api/bulk-data).

## How it works

Each page is one self-contained HTML file with no frameworks, libraries or build tools beyond `sh`. The code is plain JavaScript in `src/`:

| File | Role |
|---|---|
| `src/engine.js` | Card normalisation, role and theme tagging, brackets, deck generation and the swap optimiser, commander quiz scoring |
| `src/analysis.js` | Power level, bracket estimate, goldfish simulation, draw odds, recommendations |
| `src/plan.js` | Commander plan profiles (what a commander's text asks its deck for) and the rules-text card-quality model used by Mechanics only |
| `src/mech.js` | Mechanics graph: Oracle text parsed into what each card needs (triggers, costs, scaling) and makes (effects and the events they cause); links between cards |
| `src/builder.js` | Builder page: collection breakdown, card pool for a commander, tracker counts and basic-land split |
| `src/deep.js` | Deep search: wide swap screen, combo completions, sequential swap package; runs in Web Workers |
| `src/app.js` | Deck generator interface |
| `src/similar.js` | Card explorer similarity index and ranking |
| `src/card.js` | Card explorer interface |
| `src/shell.html`, `src/card-shell.html` | Page markup and styles |
| `tools/` | Node scripts the data workflow uses to slim and split the data files |
| `data/` | Published card data, combo files and `index.json` (written by the workflow, not by hand) |

`index.html` and `card.html` at the repository root are build outputs that GitHub Pages serves. Do not edit them directly.

## Development

You need `sh` and [Node.js](https://nodejs.org) 20 or newer (the version the workflow uses). There are no dependencies to install.

**Build** after changing anything in `src/`, and commit the rebuilt pages with your change:

```sh
cd src
sh build.sh && sh build-site.sh && mv site/index.html ../index.html && rm -r site   # deck generator → ../index.html
sh build-card.sh                                                                    # card explorer  → ../card.html
```

`card.html` takes its styles from `shell.html` and its engine from `engine.js`, so rebuild it after changing either of those too. The **Check** workflow (`.github/workflows/check.yml`) runs the tests below on every pull request and fails if either page doesn't match a fresh build.

**Test** (`test.js` and `stest.js` use synthetic cards named "Synth …"; `ttest.js` reads the card data in `data/`):

```sh
cd src
node test.js     # generator engine; exits non-zero on a failure
node stest.js    # card explorer similarity; exits non-zero on a failure
node btest.js    # builder: pool, themes, tracker counts, basics, export round trip
node ttest.js    # role tagging on the real card data in data/: staples get their roles, top-500 coverage
node atest.js    # prints analysis output for a generated deck
node sens.js     # prints a table of how decks respond to bracket, budget and game plan
```

**Run locally:** serve the repository root over HTTP, for example `python3 -m http.server` and open `http://localhost:8000/`. Opened straight from disk (`file://`), the pages can't fetch `data/`, so load a Scryfall bulk file on Start instead.

**Data files:** `.github/workflows/data.yml` runs every Monday at 06:23 UTC and on demand (Actions → Data files → Run workflow, with options to skip either source or force a Scryfall re-download). It:
- slims Scryfall's Oracle Cards file into `data/oracle-cards-*.jsonl.gz` with `tools/scryfall-slim.js`
- splits Commander Spellbook's `variants.json` into `data/spellbook/` with `tools/spellbook-shard.js`
- writes `data/aliases.json` (alternate printed names, such as Universes Beyond flavour names, mapped to Oracle names) from Scryfall's Default Cards file with `tools/scryfall-aliases.js`
- rewrites `data/index.json` with `tools/data-index.js`, then commits to `main`

**Reference decks (calibration):** `.github/workflows/ref-decks.yml` (manual, or a push that changes the downloader) runs `tools/ref-decks.js`, which saves bracket-labelled decklists for the 60 most-played commanders to `data/reference/decks.jsonl.gz`: EDHREC's average deck for each bracket (exhibition, core, upgraded, optimized, cEDH) and up to 3 of the most-viewed Archidekt decks per bracket (the bracket the owner set), one request every 1.2 s. `node tools/ref-calibrate.js data --json out.json` runs the analysis on every reference deck and prints agreement between its bracket and power level and the decks' brackets (exact, within one, confusion matrix, rank correlation), with power-level cut points fitted by leave-one-commander-out cross-validation. The page does not load these files.

**Benchmarks:** `node tools/bench-recover.js data` takes the 60 EDHREC Bracket 4 average decks, swaps 10 nonland cards of each for random legal cards of the identity with EDHREC rank 12,000–25,000 (seeded), runs deep search and reports how many of the planted cards it cuts, how many of its cuts are planted cards, and how many removed originals it adds back (`--shard i/n` splits the run across processes; `--merge` combines them). `node tools/bench-auc.js data` measures, on the same decks, how well the swap objective alone separates planted cards from originals (AUC). `node tools/bench-plan.js data` measures deck building on what popularity cannot explain: for the 60 commanders with an EDHREC Bracket 3 average deck it builds a standard and a mechanics-only deck and reports plan cards, niche recall (the human decks' picks ranked above 5,000, made for that commander), overlap, mechanics links, curve error, and power level and win turn from an analysis that carries no EDHREC rank (`--set` passes settings to the mechanics-only build). `node tools/quality-fit.js data` refits the card-quality model and prints its held-out AUC. `tools/opp-profile.js` and `tools/opp-shift.js` rebuild the opponent profiles of the table simulation.

**Mana in the simulation:** a mana ability yields its output less its activation cost (a Signet nets 1, a {1} filter 0). Lotus Petal, rituals and rocks that don't untap (Mana Vault, Grim Monolith) are one-shot mana, spent only on a turn they make the commander or another spell in hand castable. Mox Opal needs three artifacts, Mox Amber a legendary creature or planeswalker (the commander counts), Chrome Mox exiles a coloured card from hand and Mox Diamond discards a land; without one in hand they are not cast. Springleaf Drum needs a creature on the battlefield. Spend restrictions (such as Delighted Halfling's legendary-only mana) are not modelled. In the power level's Speed vector, fast mana counts by the same model: lasting mana fully, conditional moxen (Mox Opal unless the deck has 15+ artifacts) and one-shot mana less, cards that make no net mana (Lion's Eye Diamond) not at all.

**Table simulation:** besides the goldfish, the analysis plays a quarter as many games against three opponents of your bracket. Each opponent's win turn, spot removal, counterspells and board wipes come from the EDHREC average decks of that bracket; a per-bracket shift makes an average deck of the bracket win 1 game in 4. You hold removal and counters for an opponent about to win (each answer delays them two turns); opponents hold one answer each for your win, which your protection can stop; their removal and wipes hit your creatures and commander (+2 tax). The table win rate is shown under Power. It is not part of the swap score: on the benchmark it halved the removal and protection cards cut by mistake but cut fewer planted cards overall.

**Publishing:** GitHub Pages, Settings → Pages → Deploy from a branch → `main`, `/ (root)`. Every push to `main` is live.

## Credits and legal

- Card data and images: [Scryfall](https://scryfall.com). Combo data: [Commander Spellbook](https://commanderspellbook.com). Popularity ranks: [EDHREC](https://edhrec.com), through Scryfall's data. Calibration decklists: [EDHREC](https://edhrec.com) average decks and public [Archidekt](https://archidekt.com) decks.
- broken-stuff EDH generator is unofficial Fan Content permitted under the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
- Code: [MIT License](LICENSE). Anyone may use, copy, change and share it. The license covers this repository's code, not the card data, card images or combo data, which stay under their owners' terms.
