#!/usr/bin/env bash
set -euo pipefail
version=3.26.0
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    asset=Windows_64-bit.zip
    default_sha256=c42f4b413aa29b6b36fa4e3ac0c18322588a54ac860db4c84b8255997f7d1ec2
    binary=vale.exe
    ;;
  *)
    asset=Linux_64-bit.tar.gz
    default_sha256=22aa69a556558e4a9dfc63c17030777383d8d3c48dcdfad655fa98e839d666ed
    binary=vale
    ;;
esac
url=${VALE_DOWNLOAD_URL:-https://github.com/errata-ai/vale/releases/download/v${version}/vale_${version}_${asset}}
sha256=${VALE_DOWNLOAD_SHA256:-$default_sha256}
retries=5
target=${1:?usage: install-vale.sh <directory>}
mkdir -p "$target"
archive="$target/vale.archive"
status=$(curl --fail --silent --show-error --location --output "$archive" \
  --retry "$retries" --retry-connrefused --retry-delay "${VALE_RETRY_DELAY:-10}" \
  --write-out '%{http_code}' "$url") || {
  echo "::error title=Vale download failed::HTTP $status (curl exit $?) from $url after up to $retries retries" >&2
  exit 1
}
echo "$sha256  $archive" | sha256sum --check --quiet >&2
case "$url" in
  *.zip) unzip -q -o "$archive" "$binary" -d "$target" ;;
  *) tar --force-local --extract --gzip --file "$archive" --directory "$target" "$binary" ;;
esac
rm "$archive"
printf '%s\n' "$target/$binary"
