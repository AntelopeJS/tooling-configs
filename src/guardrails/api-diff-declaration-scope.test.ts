import assert from "node:assert/strict";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const NON_PORTABLE =
  'import type { KnipConfig } from "knip";\ndeclare const config: KnipConfig;\nexport default { ...config, ignore: ["a"] };\n';

test("api-diff ignores a non-portable inferred type in a module no published entry reaches, and still fails one a published entry exports (#74)", (t) => {
  const root = apiRepo(t);
  put(root, "src/index.ts", "export const value: number = 1;\n");
  put(root, "src/knip.config.ts", NON_PORTABLE);
  commit(root);
  const unpublished = bin(root, "api-diff", ["HEAD"]);
  assert.equal(unpublished.status, 0, unpublished.stdout + unpublished.stderr);
  assert.doesNotMatch(unpublished.stdout, /TS2742/);

  put(root, "src/index.ts", NON_PORTABLE);
  commit(root);
  const published = bin(root, "api-diff", ["HEAD"]);
  assert.equal(published.status, 1);
  assert.match(published.stdout, /index\.ts.*TS2742/);
});
