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
import { applyVerifyActions, planVerify } from "../guardrails/verify-skill.ts";

const source = fileURLToPath(new URL("..", import.meta.url));
const oxlintPackage = dirname(
  fileURLToPath(import.meta.resolve("oxlint/package.json")),
);
const tsgolint = fileURLToPath(
  new URL(
    "bin/tsgolint.js",
    import.meta.resolve("oxlint-tsgolint/package.json"),
  ),
);
const nodeTypes = fileURLToPath(
  new URL("..", import.meta.resolve("@types/node/package.json")),
);

/** interface-payment#11 `.agents/skills/verify-interface/verify.config.ts:128` and interface-auth#30 `:251`, reduced. */
const VERIFY_CONFIG = `import type { InterfaceCall } from "@antelopejs/tooling-configs/verify";

import type * as AuthInterface from "../../../src/index.ts";

interface SuiteReport {
  stats: { passes: number };
}

export function summarize(stdout: string): number {
  const report: SuiteReport = JSON.parse(stdout);
  return report.stats.passes;
}

export const signServerResponse: InterfaceCall<typeof AuthInterface> = {
  call: async (api) => {
    // SAFETY: SignServerResponse only reads the response it returns.
    const res = {} as never;
    const returned = await api.SignServerResponse(res);
    return { same: returned === res };
  },
  expect: { same: true },
};
`;

/** dms `.agents/probes/*.cjs`: repository-authored code beside the skills, not written by sync. */
const PROBE = `export function probe(): void {
  debugger;
}
`;

/** tooling-configs#93: Node API calls in a skill folder, as in redis `.agents/skills/verify-module` and template-blank-typescript `verify.config.ts`. */
const NODE_CALLS = `import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readManifest(): string {
  return readFileSync(join(process.cwd(), "package.json"), "utf8");
}
`;

/** A consumer as `antelopejs-sync` leaves it: its root `oxlint.config.ts`, a root `tsconfig.json` that sets no `types` (as every AntelopeJS repository's does) beside `@types/node` installed, the verify-interface synced layer and `.claude/skills` link, and the pack resolved by name. */
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
        "./verify": "./src/verify/index.ts",
      },
    }),
  );
  symlinkSync(source, join(root, pack, "src"));
  symlinkSync(oxlintPackage, join(root, "node_modules/oxlint"));
  write("oxlint.config.ts", PRESET_CONFIGS[0].content);
  write(".gitignore", "node_modules\n");
  mkdirSync(join(root, "node_modules/@types"), { recursive: true });
  symlinkSync(join(nodeTypes, "node"), join(root, "node_modules/@types/node"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  write(
    "package.json",
    JSON.stringify({
      name: "@antelopejs/interface-auth",
      antelopeJs: { kind: "interface" },
    }),
  );
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
  const plan = planVerify(root, {
    flag: "interface",
    manifest: { antelopeJs: { kind: "interface" } },
    profile: "full",
  });
  applyVerifyActions(root, plan.actions);
  write(".agents/skills/verify-interface/verify.config.ts", VERIFY_CONFIG);
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
        OXLINT_TSGOLINT_PATH: tsgolint,
      },
      encoding: "utf8",
      maxBuffer: 1 << 28,
    },
  );
  if (result.stdout.length === 0) throw new Error(result.stderr);
  const { diagnostics } = JSON.parse(result.stdout);
  return diagnostics
    .map(
      ({ code, filename, labels }: Diagnostic) =>
        `${filename}:${labels[0]?.span.line} ${code}`,
    )
    .sort();
}

test("the synced oxlint.config.ts skips the pack's .claude/skills link, lints the repository's own verify.config.ts with resolved types (interface-auth#30, interface-payment#11), and reports the repository's files outside every tsconfig but not the root configs sync writes", (t) => {
  const root = syncedConsumer();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(lint(root), [
    ".agents/probes/probe.ts:1 antelopejs(require-tsconfig-include)",
    ".agents/probes/probe.ts:2 eslint(no-debugger)",
    ".agents/skills/verify-interface/verify.config.ts:10 typescript(no-unsafe-assignment)",
  ]);
});

test("a skill folder calling Node APIs lints clean: the synced skill tsconfig resolves Node types without the root tsconfig setting them (tooling-configs#93)", (t) => {
  const root = syncedConsumer();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, ".agents/skills/verify-interface/node-calls.ts"),
    NODE_CALLS,
  );
  assert.deepEqual(
    lint(root).filter((finding) => finding.includes("node-calls.ts")),
    [],
  );
});
