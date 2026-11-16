import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { read } from "../guardrails/helpers/test-repo.ts";
import { runConcurrently } from "./jobs.ts";

const RECORD = pathToFileURL(join(import.meta.dirname, "record.ts")).href;

/** A feature process whose `Math.random` always draws the same number, as two processes seeded alike do, and that writes the port `freePort` hands it to `<dir>/<feature>`. */
function seeded(dir: string, feature: string): string[] {
  return [
    "--input-type=module",
    "-e",
    `import { writeFileSync } from "node:fs";
Math.random = () => 0.6011;
const { freePort } = await import(${JSON.stringify(RECORD)});
writeFileSync(${JSON.stringify(join(dir, feature))}, String(await freePort()));`,
  ];
}

test("two feature processes of one --jobs call, seeded alike, get different ports, where an allocator that dedupes within one process hands both the same port", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-jobs-ports-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const code = await runConcurrently(
    dir,
    [
      { feature: "a", ids: [] },
      { feature: "b", ids: [] },
    ],
    2,
    () => [],
    ({ feature }) => seeded(dir, feature),
  );
  assert.equal(code, 0);
  const ports = ["a", "b"].map((feature) => Number(read(dir, feature)));
  assert.notEqual(ports[0], ports[1], `both got ${ports[0]}`);
});
