import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { commit, put } from "../../guardrails/helpers/test-repo.ts";
import {
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./verify-repo.ts";

const SKILL = ".agents/skills/verify-module";
export const ADD = "export function add(a, b) {\n  return a + b;\n}\n";
const OPS =
  'export const label = "ops";\nexport const mark = label.toUpperCase();\n';

/** A model-like check over src/math.js: it prints `holds AddWorks`, or `BROKEN AddWorks` and exits 1 when `add` is wrong. */
export const CHECK = `import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { add } = await import(pathToFileURL(join(process.cwd(), "src/math.js")).href);
if (add(1, 2) !== 3) {
  console.log("BROKEN AddWorks");
  process.exitCode = 1;
} else console.log("holds AddWorks");
`;

const CONFIG = `export default {
  doors: ${PUBLISH_DOORS},
  formal: [
    {
      name: "formal-add",
      covers: ["src/math.js", "src/ops.js", "src/typed.ts"],
      files: [".agents/skills/formal-add/**"],
      command: ["node", ".agents/skills/formal-add/check.mjs"],
      violation: /^BROKEN (\\w+)/gm,
    },
  ],
};
`;

/** A module repository with a formal check over src/math.js; `head` is committed over `base`, and `removed` paths are deleted in the head commit. */
export function formalRepo(
  t: TestContext,
  head: Record<string, string>,
  base: Record<string, string> = {},
  removed: string[] = [],
) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-runs-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "src/math.js": ADD,
    "src/ops.js": OPS,
    "src/typed.ts":
      "export const total = [1, 2, 3].reduce((sum, n) => sum + n, 0);\n",
    ".agents/skills/formal-add/check.mjs": CHECK,
    [`${SKILL}/verify.config.ts`]: CONFIG,
    [`${SKILL}/features/smoke.md`]: feature([], ["module-dev"]),
    [`${SKILL}/features/math.md`]: feature(["src/**"], ["module-dev"]),
    ...base,
  });
  for (const [path, content] of Object.entries(head)) put(root, path, content);
  for (const path of removed) rmSync(join(root, path));
  commit(root);
  return { root, tmp, run: newRun(root, tmp) };
}

/** Writes a minimal judgement and returns the verdict markdown. */
export function judged(root: string, tmp: string, run: string) {
  put(
    run,
    "evidence/judgement.json",
    JSON.stringify({
      doors: { none: "no door" },
      docs: [{ page: "README.md", matches: true }],
      verifier: "a fresh thread",
    }),
  );
  return verify(root, tmp, ["verdict", run, "--pr", "7"]).stdout;
}
