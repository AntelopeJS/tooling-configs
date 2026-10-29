import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";

import { commit, put, testRepo } from "../guardrails/helpers/test-repo.ts";
import { behaviourChange } from "./behaviour.ts";

type Files = { [path: string]: string };

function sha(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function changed(
  t: TestContext,
  base: Files,
  head: Files,
  covers = Object.keys(base),
): boolean {
  const root = testRepo(t);
  for (const [path, content] of Object.entries(base)) put(root, path, content);
  commit(root);
  const baseSha = sha(root);
  for (const [path, content] of Object.entries(head)) put(root, path, content);
  commit(root);
  const check = { name: "formal-test", covers, command: [], violation: null };
  return behaviourChange(root, check, { baseSha, headSha: sha(root) }).changed;
}

const OPS =
  "export function add(a, b) {\n  return a + b;\n}\nexport function sub(a, b) {\n  return a - b;\n}\n";

test("retargeting a re-export of a covered module to another of its exports is changed", (t) => {
  assert.equal(
    changed(
      t,
      { "src/ops.ts": OPS, "src/index.ts": 'export { add } from "./ops";\n' },
      {
        "src/ops.ts": OPS,
        "src/index.ts": 'export { sub as add } from "./ops";\n',
      },
    ),
    true,
  );
});

test("a re-export of a covered module under its own name, reflowed, is unchanged", (t) => {
  assert.equal(
    changed(
      t,
      { "src/ops.ts": OPS, "src/index.ts": 'export { add } from "./ops";\n' },
      { "src/ops.ts": OPS, "src/index.ts": 'export { add } from "./ops";\n\n' },
    ),
    false,
  );
});

test("retargeting a local export alias is changed", (t) => {
  const local = (target: string) =>
    `function f() {\n  return 1;\n}\nfunction g() {\n  return 2;\n}\nexport { ${target} as run };\n`;
  assert.equal(
    changed(t, { "src/a.ts": local("f") }, { "src/a.ts": local("g") }),
    true,
  );
  assert.equal(
    changed(t, { "src/a.ts": local("f") }, { "src/a.ts": `${local("f")}\n` }),
    false,
  );
});

test("exporting a local under its own name, by keyword or by list, is unchanged", (t) => {
  assert.equal(
    changed(
      t,
      { "src/a.ts": "export const limit = 1;\n" },
      { "src/a.ts": "const limit = 1;\nexport { limit };\n" },
    ),
    false,
  );
});

test("swapping two side-effect imports is changed", (t) => {
  assert.equal(
    changed(
      t,
      { "src/a.ts": 'import "./first";\nimport "./second";\nrun();\n' },
      { "src/a.ts": 'import "./second";\nimport "./first";\nrun();\n' },
    ),
    true,
  );
});

test("a function moved verbatim into a file with a different top-level variable of the same name is changed", (t) => {
  const log = "export function report() {\n  return Logger.channel;\n}\n";
  assert.equal(
    changed(
      t,
      {
        "src/a.ts": `const Logger = { channel: "a" };\n${log}`,
        "src/b.ts":
          'const Logger = { channel: "b" };\nexport const other = 1;\n',
      },
      {
        "src/a.ts": 'const Logger = { channel: "a" };\n',
        "src/b.ts": `const Logger = { channel: "b" };\nexport const other = 1;\n${log}`,
      },
    ),
    true,
  );
});

test("a function moved with the variable it reads, or reading it through an import, is judged by that variable", (t) => {
  const log = "export function report() {\n  return Logger.channel;\n}\n";
  assert.equal(
    changed(
      t,
      {
        "src/a.ts": `export const Logger = { channel: "a" };\n${log}`,
        "src/b.ts": "export const other = 1;\n",
      },
      {
        "src/a.ts": 'export const Logger = { channel: "a" };\n',
        "src/b.ts": `import { Logger } from "./a";\nexport const other = 1;\n${log}`,
      },
    ),
    false,
  );
});

test("an import aliased to a name that a local variable also has is changed when a function switches to the local", (t) => {
  const lib = "export const x = 1;\n";
  const use = (name: string) =>
    `import { x as y } from "./lib";\nconst x = 2;\nexport function value() {\n  return ${name};\n}\n`;
  assert.equal(
    changed(
      t,
      { "src/lib.ts": lib, "src/a.ts": use("y") },
      { "src/lib.ts": lib, "src/a.ts": use("x") },
    ),
    true,
  );
});
