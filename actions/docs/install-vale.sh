#!/usr/bin/env bash
set -euo pipefail
version=3.26.0
sha256=22aa69a556558e4a9dfc63c17030777383d8d3c48dcdfad655fa98e839d666ed
target=${1:?usage: install-vale.sh <directory>}
mkdir -p "$target"
archive="$target/vale.tar.gz"
curl --fail --silent --show-error --location --output "$archive" \
  "https://github.com/errata-ai/vale/releases/download/v${version}/vale_${version}_Linux_64-bit.tar.gz"
echo "$sha256  $archive" | sha256sum --check --status
tar --extract --gzip --file "$archive" --directory "$target" vale
rm "$archive"
printf '%s\n' "$target/vale"
