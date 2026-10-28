# anti-slop (vendored)

Copied from <https://github.com/dmmulroy/anti-slop> at commit `e8c4880471b23ab7f216fba7b27d173a6ef07d4c` (2026-08-31), MIT license (see `LICENSE` in this directory).

The upstream project is meant to be vendored, not installed from npm. The `effect/` rule group was intentionally left out (we do not use Effect). Everything else is unchanged; local edits, if any, are listed below.

## Local edits

- `rules/require-safety-comment-for-type-assertion.ts` exports `DEFAULT_SAFETY_MARKERS` and `markerPattern`, so the guardrails suppression counter counts exactly the `SAFETY:` comments this rule accepts.
