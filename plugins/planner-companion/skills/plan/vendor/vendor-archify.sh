#!/usr/bin/env bash
# Usage: vendor-archify.sh <archify-root>
# Copies the files listed in archify.files into vendor/archify/, keeping the layout,
# and records the archify version and date in vendor/archify/VENDORED.
set -euo pipefail
root=${1:?usage: vendor-archify.sh <archify-root>}
here=$(cd "$(dirname "$0")" && pwd)
dest=$here/archify
version=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1]+"/package.json","utf8")).version)' "$root")
rm -rf "$dest"
mkdir -p "$dest"
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  mkdir -p "$dest/$(dirname "${entry%/}")"
  cp -R "$root/${entry%/}" "$dest/$(dirname "${entry%/}")/"
done < "$here/archify.files"
printf 'archify %s vendored %s\n' "$version" "$(date +%F)" > "$dest/VENDORED"
