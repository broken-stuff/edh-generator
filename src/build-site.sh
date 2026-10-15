#!/bin/sh
# Builds the GitHub Pages copy: a full HTML document (charset, viewport, icon) around the same single-file app.
set -e
OUT=${1:-site}
mkdir -p "$OUT/data"
{
  echo '<!doctype html>'
  echo '<html lang="en">'
  echo '<meta charset="utf-8">'
  echo '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  echo '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 22 22%22%3E%3Ccircle cx=%2211%22 cy=%2211%22 r=%2210%22 fill=%22none%22 stroke=%22%23888%22 stroke-width=%221.5%22/%3E%3Ccircle cx=%2211%22 cy=%225%22 r=%222%22 fill=%22%23f8e7b9%22/%3E%3Ccircle cx=%2216.7%22 cy=%229.1%22 r=%222%22 fill=%22%23b3ceea%22/%3E%3Ccircle cx=%2214.5%22 cy=%2215.9%22 r=%222%22 fill=%22%23a69f9d%22/%3E%3Ccircle cx=%227.5%22 cy=%2215.9%22 r=%222%22 fill=%22%23eb9f82%22/%3E%3Ccircle cx=%225.3%22 cy=%229.1%22 r=%222%22 fill=%22%23c4d3ca%22/%3E%3C/svg%3E">'
  echo '<script>window.EDH_SITE = 1;</script>'
  cat edh-deck-generator.html
  echo '</html>'
} > "$OUT/index.html"
touch "$OUT/.nojekyll"
