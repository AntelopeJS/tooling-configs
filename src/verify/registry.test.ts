import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { registryFault } from "./registry.ts";

const OUTAGE =
  "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n";

/** The reason `registryFault` gives for a failed step whose `command.txt` holds `command`, or `null`. */
function faultOf(t: TestContext, command: string): string | null {
  const evidence = mkdtempSync(join(tmpdir(), "registry-fault-"));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const folder = join(evidence, "01-step");
  mkdirSync(folder);
  writeFileSync(join(folder, "command.txt"), command);
  writeFileSync(join(folder, "stderr.txt"), OUTAGE);
  writeFileSync(join(folder, "exit-code.txt"), "1\n");
  return registryFault(evidence, [
    {
      name: "step",
      folder: "01-step",
      checks: [{ name: "right", pass: false, detail: "" }],
    },
  ]);
}

test("an install after an environment prefix, a quoted program path, a docker line without a cd line or the ajs entry run by node is NOT VERIFIED (catches a gate that reads the first word as the program)", (t) => {
  for (const command of [
    "cd /work/app\nCI=1 NO_COLOR=1 pnpm install --frozen-lockfile\n",
    "cd '/work/my app'\n'/opt/pnpm bin/pnpm' add left-pad\n",
    "docker pull redis:7\n",
    "docker buildx build -t app .\n",
    "cd /work\nnode /work/node_modules/@antelopejs/core/dist/ajs.js module install left-pad\n",
  ])
    assert.notEqual(faultOf(t, command), null, command);
});

test("a command that only mentions a fetching word, or that puts a flag before the subcommand, stays FAIL (catches a gate that finds the subcommand anywhere in the command)", (t) => {
  for (const command of [
    "cd /work\npnpm run install\n",
    "cd /work\nnode scripts/install.js pnpm install\n",
    "cd /work\nsh -c 'pnpm install'\n",
    "cd /work\npnpm --filter install test\n",
    "cd /work\npnpm -r install\n",
    "cd /work\nnode /work/other/core/ajs.js module install left-pad\n",
    "",
  ])
    assert.equal(faultOf(t, command), null, command);
});
