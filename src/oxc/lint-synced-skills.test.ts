import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PRESET_CONFIGS } from "../guardrails/templates.ts";
import {
  applyDocsSkillActions,
  planDocsSkills,
} from "../guardrails/docs-skills.ts";
import { TSGOLINT } from "./helpers/tsgolint.ts";

const source = fileURLToPath(new URL("..", import.meta.url));
const oxlintPackage = dirname(
  fileURLToPath(import.meta.resolve("oxlint/package.json")),
);
const nodeTypes = fileURLToPath(
  new URL("..", import.meta.resolve("@types/node/package.json")),
);

/** dms `.agents/probes/*.cjs`: repository-authored code beside the skills, not written by sync. */
const PROBE = `export function probe(): void {
  debugger;
}
`;

/** A consumer as `antelopejs-sync` leaves it: its root `oxlint.config.ts`, a root `tsconfig.json` that sets no `types` (as every AntelopeJS repository's does) beside `@types/node` and TypeScript 5 installed, the writing skills' synced layer and `.claude/skills` links, and the pack resolved by name. */
function syncedConsumer() {
  const root = mkdtempSync(join(tmpdir(), "antelope-synced-skills-"));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const pack = "node_modules/@antelopejs/tooling-configs";
  write(
    `${pack}/package.json`,
    JSON.stringify({
      name: "@antelopejs/tooling-configs",
      type: "module",
      exports: {
        "./oxc/lint": "./src/oxc/lint.ts",
        "./oxc/anti-slop": "./src/oxc/anti-slop/index.ts",
        "./oxc/guardrails": "./src/oxc/guardrails/index.ts",
      },
    }),
  );
  symlinkSync(source, join(root, pack, "src"));
  symlinkSync(oxlintPackage, join(root, "node_modules/oxlint"));
  write("oxlint.config.ts", PRESET_CONFIGS[0].content);
  write(".gitignore", "node_modules\n");
  mkdirSync(join(root, "node_modules/@types"), { recursive: true });
  symlinkSync(join(nodeTypes, "node"), join(root, "node_modules/@types/node"));
  write(
    "node_modules/typescript/package.json",
    JSON.stringify({ name: "typescript", version: "5.9.3" }),
  );
  spawnSync("git", ["init", "-q"], { cwd: root });
  write("package.json", JSON.stringify({ name: "@antelopejs/interface-auth" }));
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "commonjs",
        strict: true,
        rootDir: "src",
        outDir: "dist",
      },
      include: ["src"],
    }),
  );
  write(
    "src/index.ts",
    'import type { ServerResponse } from "node:http";\n\nexport async function SignServerResponse(res: ServerResponse): Promise<ServerResponse> {\n  return res;\n}\n',
  );
  applyDocsSkillActions(root, planDocsSkills(root).actions);
  write(".agents/probes/probe.ts", PROBE);
  return root;
}

interface Diagnostic {
  code: string;
  filename: string;
  labels: { span: { line: number } }[];
}

function lint(root: string): string[] {
  const result = spawnSync(
    process.execPath,
    [join(oxlintPackage, "bin/oxlint"), "-f", "json"],
    {
      cwd: root,
      env: {
        ...process.env,
        OXLINT_TSGOLINT_PATH: TSGOLINT,
      },
      encoding: "utf8",
      maxBuffer: 1 << 28,
    },
  );
  if (!result.stdout.startsWith("{"))
    throw new Error(
      `oxlint returned no JSON report (exit ${result.status}): ${result.stdout}${result.stderr}`,
    );
  const { diagnostics } = JSON.parse(result.stdout);
  return diagnostics
    .map(
      ({ code, filename, labels }: Diagnostic) =>
        `${filename}:${labels[0]?.span.line} ${code}`,
    )
    .sort();
}

test("the synced oxlint.config.ts skips the pack's .claude/skills links, and reports the repository's files outside every tsconfig, and those under a tsconfig that lists no types, but not the root configs sync writes", (t) => {
  const root = syncedConsumer();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(lint(root), [
    ".agents/probes/probe.ts:1 antelopejs(require-tsconfig-include)",
    ".agents/probes/probe.ts:2 eslint(no-debugger)",
    "src/index.ts:1 antelopejs(require-tsconfig-types)",
  ]);
});

test("the synced oxlint.config.ts skips a repository-authored file under .claude/skills", (t) => {
  const root = syncedConsumer();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude/skills/own"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/own/script.ts"), PROBE);
  assert.deepEqual(
    lint(root).filter((line) => line.startsWith(".claude/")),
    [],
  );
});
