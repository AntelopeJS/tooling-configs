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

export const SKILL = ".agents/skills/verify-module";
export const ADD = "export function add(a, b) {\n  return a + b;\n}\n";
export const OPS =
  'export const label = "ops";\nexport const mark = label.toUpperCase();\n';

/** A model-like check: it prints the same rule names whatever the code looks like, as long as it behaves the same. */
export const CHECK = `import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { add } = await import(pathToFileURL(join(process.cwd(), "src/math.js")).href);
if (add(1, 2) !== 3) {
  console.log("BROKEN AddWorks");
  process.exitCode = 1;
} else console.log("holds AddWorks");
if (Object.is(add(-0, -0), -0)) console.log("finding NegativeZero");
else console.log("holds NegativeZero");
`;

/** A model-like check that prints each finding with its counterexample length, read from the covered code. */
export const LENGTH_CHECK = `import { join } from "node:path";
import { pathToFileURL } from "node:url";
const math = await import(pathToFileURL(join(process.cwd(), "src/math.js")).href);
for (const length of math.steps ?? [3]) console.log(\`finding NegativeZero: \${length} states\`);
if (math.extra) console.log("finding Extra: 2 states");
`;

/** The same check after a rewrite that no longer reports the NegativeZero rule at all. */
export const CHECK_WITHOUT_RULE = CHECK.replace(/if \(Object\.is[\s\S]*$/, "");

export const CONFIG = `export default {
  doors: ${PUBLISH_DOORS},
  formal: [
    {
      name: "formal-add",
      covers: ["src/math.js", "src/ops.js", "src/typed.ts"],
      files: [".agents/skills/formal-add/**"],
      command: ["node", ".agents/skills/formal-add/check.mjs"],
      violation: /^(?:finding|BROKEN) (\\w+)(?:: (?<states>\\d+) states)?/gm,
      passing: /^holds (\\w+)/gm,
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
