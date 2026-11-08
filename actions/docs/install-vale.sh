#!/usr/bin/env bash
set -euo pipefail
version=3.26.0
url=${VALE_DOWNLOAD_URL:-https://github.com/errata-ai/vale/releases/download/v${version}/vale_${version}_Linux_64-bit.tar.gz}
sha256=${VALE_DOWNLOAD_SHA256:-22aa69a556558e4a9dfc63c17030777383d8d3c48dcdfad655fa98e839d666ed}
retries=5
target=${1:?usage: install-vale.sh <directory>}
mkdir -p "$target"
archive="$target/vale.tar.gz"
status=$(curl --fail --silent --show-error --location --output "$archive" \
  --retry "$retries" --retry-connrefused --retry-delay "${VALE_RETRY_DELAY:-10}" \
  --write-out '%{http_code}' "$url") || {
  echo "::error title=Vale download failed::HTTP $status from $url after $retries retries" >&2
  exit 1
}
echo "$sha256  $archive" | sha256sum --check --quiet >&2
tar --extract --gzip --file "$archive" --directory "$target" vale
rm "$archive"
printf '%s\n' "$target/vale"
