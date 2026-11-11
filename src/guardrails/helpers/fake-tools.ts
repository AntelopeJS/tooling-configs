import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { toolingVersions } from "../package.ts";
import { PACKAGE_ROOT } from "./test-repo.ts";

const PRESET_SOURCES = {
  "oxc/lint": "src/oxc/lint.ts",
  "oxc/anti-slop": "src/oxc/anti-slop/index.ts",
  "oxc/guardrails": "src/oxc/guardrails/index.ts",
} as const;

function resolved(specifier: string): string {
  return dirname(createRequire(import.meta.url).resolve(specifier));
}

function script(body: string): string {
  return `#!${process.execPath}\n${body}\n`;
}

/**
 * A fake `pnpm install` that links into `node_modules` only what the
 * repository's package.json declares: oxlint and oxlint-tsgolint from this
 * checkout, and a stub of the pack that serves its preset from source.
 */
function pnpmScript(log: string): string {
  const links = {
    oxlint: resolved("oxlint/package.json"),
    "oxlint-tsgolint": resolved("oxlint-tsgolint/package.json"),
  };
  const presets = Object.fromEntries(
    Object.entries(PRESET_SOURCES).map(([name, source]) => [
      name,
      pathToFileURL(join(PACKAGE_ROOT, source)).href,
    ]),
  );
  return script(`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, "pnpm " + args.join(" ") + "\\n");
if (args[0] !== "install") process.exit(0);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const declared = { ...manifest.dependencies, ...manifest.devDependencies };
for (const [name, target] of Object.entries(${JSON.stringify(links)})) {
  if (!declared[name]) continue;
  const link = path.join("node_modules", name);
  fs.mkdirSync("node_modules", { recursive: true });
  if (!fs.existsSync(link)) fs.symlinkSync(target, link, "dir");
}
if (declared["oxlint-tsgolint"]) {
  fs.mkdirSync(path.join("node_modules", ".bin"), { recursive: true });
  const bin = path.join("node_modules", ".bin", "tsgolint");
  if (!fs.existsSync(bin)) fs.symlinkSync(${JSON.stringify(join(PACKAGE_ROOT, "node_modules/.bin/tsgolint"))}, bin);
}
if (declared["@antelopejs/tooling-configs"]) {
  const stub = path.join("node_modules", "@antelopejs", "tooling-configs");
  fs.mkdirSync(stub, { recursive: true });
  const exports = {};
  for (const [name, url] of Object.entries(${JSON.stringify(presets)})) {
    const file = name.replace("/", "-") + ".mjs";
    exports["./" + name] = "./" + file;
    const plugin = name !== "oxc/lint";
    fs.writeFileSync(
      path.join(stub, file),
      "export * from " + JSON.stringify(url) + ";\\n" + (plugin ? "export { default } from " + JSON.stringify(url) + ";\\n" : ""),
    );
  }
  fs.writeFileSync(
    path.join(stub, "package.json"),
    JSON.stringify({ name: "@antelopejs/tooling-configs", version: ${JSON.stringify(toolingVersions().pack)}, type: "module", exports }),
  );
}
`);
}

/**
 * A fake `gh` that answers the `delete_branch_on_merge` read from a state file
 * (`false` at first) and turns it on at a PATCH, or refuses the PATCH.
 */
function ghScript(log: string, state: string, refuses: boolean): string {
  return script(`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, "gh " + args.join(" ") + "\\n");
if (args.includes("PATCH")) {
  if (${JSON.stringify(refuses)}) {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  fs.writeFileSync(${JSON.stringify(state)}, "on");
  process.exit(0);
}
process.stdout.write(fs.existsSync(${JSON.stringify(state)}) ? "true\\n" : "false\\n");
`);
}

export interface FakeTools {
  /** The environment that puts the fake `pnpm` and `gh` first on PATH. */
  env: { PATH: string };
  /** Every call the fakes received, in order, as `<tool> <arguments>`. */
  calls(): string[];
  /** Whether a PATCH turned `delete_branch_on_merge` on. */
  patched(): boolean;
}

/** A directory of fake `pnpm` and `gh` executables for a CLI run; `refusesPatch` makes the PATCH fail as a token without admin rights does. */
export function fakeTools(
  t: TestContext,
  { refusesPatch = false }: { refusesPatch?: boolean } = {},
): FakeTools {
  const directory = mkdtempSync(join(tmpdir(), "antelope-fake-tools-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "calls.log");
  const state = join(directory, "delete-branch-on-merge");
  writeFileSync(log, "");
  for (const [name, content] of [
    ["pnpm", pnpmScript(log)],
    ["gh", ghScript(log, state, refusesPatch)],
  ]) {
    writeFileSync(join(directory, name), content);
    chmodSync(join(directory, name), 0o755);
  }
  return {
    env: {
      PATH: [directory, process.env.PATH ?? ""].join(delimiter),
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    patched: () => existsSync(state),
  };
}
