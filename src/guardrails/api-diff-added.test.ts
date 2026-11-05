import assert from "node:assert/strict";
import test from "node:test";

import {
  addHelper,
  INTERNAL,
  MARKED,
  wildcardRepo,
} from "./helpers/api-diff-added-repo.ts";
import { bin } from "./helpers/test-repo.ts";

test("api-diff --allow-added passes an added internal entry marked @internal in both halves and lists it, while the same change fails without the flag", (t) => {
  const root = wildcardRepo(t);
  addHelper(root, MARKED);
  const allowed = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.match(allowed.stdout, /^API: 1 packages, 2 entries unchanged/);
  assert.match(allowed.stdout, /Runtime API: 1 packages, 2 entries unchanged/);
  assert.match(
    allowed.stdout,
    /Added \(allowed\): 1\n {2}\.: \.\/internal\/helper\n/,
  );
  const strict = bin(root, "api-diff", ["base"]);
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stdout, /new file mode/);
  assert.doesNotMatch(strict.stdout, /Added \(allowed\)/);
});

test("api-diff --allow-added prints no Added (allowed) line when nothing was added", (t) => {
  const root = wildcardRepo(t);
  const result = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^API: 1 packages, 2 entries unchanged/);
  assert.doesNotMatch(result.stdout, /Added \(allowed\)/);
});

test("api-diff rejects a malformed command line with the usage text", (t) => {
  const root = wildcardRepo(t);
  const result = bin(root, "api-diff", ["base", "--allow-added"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Usage: antelopejs-api-diff <base-ref>.*--allow-added/,
  );
});
