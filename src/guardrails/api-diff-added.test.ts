import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const BUILD = "tsc --noEmit false --composite false --declarationMap false";
const INTERNAL = ["--allow-added", "**/internal/**"];

function wildcardRepo(t: Parameters<typeof apiRepo>[0]): string {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "public-api",
      type: "module",
      scripts: { build: BUILD },
      exports: { "./*": "./dist/*.js" },
    }),
  );
  put(root, "src/feature.ts", "export const feature: number = 1;\n");
  put(root, "src/internal/old.ts", "export const old = 1;\n");
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  return root;
}

function addHelper(root: string, source: string): void {
  put(root, "src/internal/helper.ts", source);
  put(
    root,
    "src/feature.ts",
    "import { help } from './internal/helper.js';\nexport const feature: number = help();\n",
  );
  commit(root);
}

const MARKED =
  "/** @internal */\nexport function help(): number { return 1; }\n";

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

test("api-diff --allow-added accepts a module-level @internal tag or a tag on every exported declaration and rejects a partly tagged module", (t) => {
  const root = wildcardRepo(t);
  addHelper(
    root,
    "/** @internal @packageDocumentation */\nexport function help(): number { return 1; }\nexport const extra = 2;\n",
  );
  assert.equal(bin(root, "api-diff", ["base", ...INTERNAL]).status, 0);
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
  assert.equal(bin(root, "api-diff", ["base", ...INTERNAL]).status, 0);
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

test("api-diff --allow-added still fails a changed entry under internal, an added entry outside the glob, and a removed entry", (t) => {
  const root = wildcardRepo(t);
  put(root, "src/internal/old.ts", "export const old = 'changed';\n");
  commit(root);
  const changed = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /\+export declare const old/);
  execFileSync("git", ["reset", "-q", "--hard", "base"], { cwd: root });
  put(root, "src/public.ts", MARKED);
  commit(root);
  const outside = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(outside.status, 1, outside.stdout + outside.stderr);
  assert.match(outside.stdout, /new file mode/);
  execFileSync("git", ["reset", "-q", "--hard", "base"], { cwd: root });
  rmSync(join(root, "src/internal/old.ts"));
  commit(root);
  const removed = bin(root, "api-diff", ["base", ...INTERNAL]);
  assert.equal(removed.status, 1, removed.stdout + removed.stderr);
  assert.match(removed.stdout, /deleted file mode/);
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
