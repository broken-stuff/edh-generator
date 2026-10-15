# broken-stuff EDH generator

Offline Commander (EDH) deck generator and analyzer. One static page (`index.html`); all logic runs in the browser.

## Data files

The page loads card data from `data/` in this repository:

| File | Source | Required |
|---|---|---|
| `data/cards.json.gz` (or `data/cards.json`) | Scryfall bulk data, *Oracle Cards* or *Default Cards*: https://scryfall.com/docs/api/bulk-data | yes |

GitHub rejects files over 100 MB, so compress before committing:

```sh
gzip -9 -c oracle-cards-*.json > data/cards.json.gz
```

On each visit the page sends a HEAD request for the file and downloads it only when its ETag/Last-Modified changed; otherwise it uses the copy stored in the browser (IndexedDB). Users can still load their own files from the Data source panel.

## Updating

Replace the files in `data/`, commit, push. Pages redeploys automatically.

## Publishing (once)

Settings → Pages → Build and deployment → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)`.

## Source and build

`index.html` is generated. Edit the files in `src/`, then:

```sh
cd src
sh build.sh          # src/edh-deck-generator.html (single file, no <html> wrapper)
sh build-site.sh ..  # ../index.html for GitHub Pages
node test.js && node atest.js   # engine and analysis tests on synthetic cards
```
