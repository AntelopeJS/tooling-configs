import assert from "node:assert/strict";
import test from "node:test";

import {
  addHelper,
  INTERNAL,
  wildcardRepo,
} from "./helpers/api-diff-added-repo.ts";
import { bin } from "./helpers/test-repo.ts";

test("api-diff --allow-added accepts a module-level @internal tag or a tag on every exported declaration and rejects a partly tagged module", (t) => {
  const root = wildcardRepo(t);
  addHelper(
    root,
    "/** @internal @packageDocumentation */\nexport function help(): number { return 1; }\nexport const extra = 2;\n",
  );
  const tagged = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(tagged.status, 0, tagged.stdout + tagged.stderr);
  addHelper(
    root,
    "/** @internal */\nexport function help(): number { return 1; }\n/** Public. */\nexport const extra = 2;\n",
  );
  const partial = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(partial.status, 1, partial.stdout + partial.stderr);
  assert.match(
    partial.stdout,
    /src\/internal\/helper\.ts: added entry \.\/internal\/helper/,
  );
  addHelper(
    root,
    "/** @internal */\nexport function help(): number { return 1; }\n/** @internal */\nexport const extra = 2;\n",
  );
  const everyTagged = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(everyTagged.status, 0, everyTagged.stdout + everyTagged.stderr);
});

test("api-diff --allow-added fails an added internal entry without @internal and names the file and the fix", (t) => {
  const root = wildcardRepo(t);
  addHelper(root, "export function help(): number { return 1; }\n");
  const result = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Added \(allowed\)/);
  assert.match(
    result.stdout,
    /src\/internal\/helper\.ts.*not marked @internal/,
  );
  assert.match(result.stdout, /@internal @packageDocumentation/);
  assert.match(result.stdout, /new file mode/);
});
