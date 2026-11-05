#!/usr/bin/env bash
# Removes seeded runs from one AntelopeJS repo checkout. Safe to rerun.
# Usage: remove-seeded.sh <repo-root>
# Prints the counts the PR body quotes, then what is left for a human or agent to judge.
set -euo pipefail
root=$(cd "$1" && pwd)
cd "$root"

workspace_manifests() {
  pnpm -r --include-workspace-root -s exec pwd | while read -r dir; do
    realpath --relative-to="$root" "$dir/package.json"
  done
}

bump() {
  local pkg=$1 version=$2 f
  for f in $(workspace_manifests); do
    grep -q "\"$pkg\"" "$f" || continue
    PKG=$pkg VERSION=$version perl -0pi -e 's{("\Q$ENV{PKG}\E"\s*:\s*")(>=\s*|[~^]?)\d+\.\d+\.\d+}{$1$2$ENV{VERSION}}g' "$f"
    echo "$f"
  done
}

tc_files=$(bump @antelopejs/tooling-configs 0.3.0)
dms_files=$(workspace_manifests | xargs grep -l '"@antelopejs/dms"' 2>/dev/null || true)
dms_uses_control=$(git grep -l 'dms-control' -- ':!pnpm-lock.yaml' ':!**/pnpm-lock.yaml' 2>/dev/null || true)
if [ -n "$dms_files" ] && [ -n "$dms_uses_control" ]; then
  dms_files=$(bump @antelopejs/dms 0.17.0)
else
  dms_files=""
fi

pnpm install --silent >/dev/null 2>"$root/.seeded-install.err" || { cat "$root/.seeded-install.err" >&2; rm -f "$root/.seeded-install.err"; exit 1; }
rm -f "$root/.seeded-install.err"
git ls-files '*pnpm-lock.yaml' | xargs grep -lq "'@antelopejs/tooling-configs@0.3.0'" || { echo "pnpm-lock.yaml does not resolve @antelopejs/tooling-configs@0.3.0" >&2; exit 1; }
if [ -n "$dms_files" ]; then
  git ls-files '*pnpm-lock.yaml' | xargs grep -lq "'@antelopejs/dms@0.17.0'" || { echo "pnpm-lock.yaml does not resolve @antelopejs/dms@0.17.0" >&2; exit 1; }
fi

if node -e 'process.exit(require("./package.json").scripts?.sync ? 0 : 1)'; then
  pnpm run -s sync >/dev/null
else
  pnpm exec antelopejs-sync >/dev/null
fi

breaks=$(git ls-files '.agents/skills/verify-*/seeded-breaks/*' | wc -l)
doors=$(git ls-files '.agents/skills/verify-*/seeded-doors/*' | wc -l)
for d in .agents/skills/verify-*/seeded-breaks .agents/skills/verify-*/seeded-doors; do
  [ -e "$d" ] && git rm -rq --ignore-unmatch "$d" && rm -rf "$d"
done

empty_containments=0
nonempty_containments=""
for cfg in .agents/skills/verify-*/verify.config.ts; do
  [ -f "$cfg" ] || continue
  n=$(grep -cE '^\s*containments:\s*\[\],?\s*$' "$cfg" || true)
  empty_containments=$((empty_containments + n))
  sed -i -E '/^\s*containments:\s*\[\],?\s*$/d' "$cfg"
  hits=$(grep -nE 'containments\s*:' "$cfg" || true)
  [ -n "$hits" ] && nonempty_containments+="$cfg: $hits"$'\n'
done

for readme in .agents/skills/verify-*/features/README.md; do
  [ -f "$readme" ] || continue
  sed -i 's/, `journeys:` the journeys it runs, and `seeded-breaks\/<feature>.patch` the break its journeys must catch\./, and `journeys:` the journeys it runs./' "$readme"
done

echo "== remove-seeded counts =="
echo "tooling-configs bumped to 0.3.0 in: $(echo $tc_files)"
echo "dms bumped to 0.17.0 in: ${dms_files:-(not used with dms-control)}"
echo "seeded-breaks files removed: $breaks"
echo "seeded-doors files removed: $doors"
echo "empty containments entries removed: $empty_containments"
echo "== left to judge =="
outside=$(comm -13 <(workspace_manifests | sort) <(git ls-files '*package.json' | xargs grep -lE '"@antelopejs/(tooling-configs|dms)"' | sort) || true)
[ -n "$outside" ] && printf 'manifests outside the root workspace that name tooling-configs or dms (not bumped):\n%s\n' "$outside"
[ -n "$nonempty_containments" ] && printf 'non-empty containments (journeys named as containment):\n%s' "$nonempty_containments"
git grep -nIiE 'seeded|containment' -- '.agents/skills/verify-*' '.claude/skills/verify-*' 'AGENTS.md' 'CONTRIBUTING.md' 'docs' ':!*.lock' ':!pnpm-lock.yaml' || true
