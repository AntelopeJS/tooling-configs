import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

import { loadRun } from "./workspace.ts";

const WORKSPACE = pathToFileURL(join(import.meta.dirname, "workspace.ts")).href;

/** A run folder holding the run.json `new` writes, with `processes` recorded there by an older version. */
function runFolder(
  t: TestContext,
  processes: { name: string; pid: number }[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "verify-records-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      dir,
      evidence: join(dir, "evidence"),
      processes,
      containers: [],
    }),
  );
  return dir;
}

/** Starts a `journey`-like command that records `count` processes one at a time, then drops every fifth, and resolves with its exit code. */
async function command(
  dir: string,
  writer: number,
  count: number,
): Promise<number | null> {
  const script = `import { loadRun, recordProcesses } from ${JSON.stringify(WORKSPACE)};
const state = loadRun(${JSON.stringify(dir)});
for (let index = 0; index < ${count}; index++)
  recordProcesses(state, { add: [{ name: "app ${writer}-" + index, pid: ${writer * 100_000} + index }] });
for (let index = 0; index < ${count}; index += 5)
  recordProcesses(state, { drop: [${writer * 100_000} + index] });
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: "inherit",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  return code;
}

function names(dir: string): string[] {
  return loadRun(dir)
    .processes.map((record) => record.name)
    .sort();
}

test("four commands that record processes at once lose none of each other's records; one shared run.json each command reads, changes and writes back keeps only the last writer's", async (t) => {
  const dir = runFolder(t, [{ name: "older", pid: 1 }]);
  const codes = await Promise.all(
    [1, 2, 3, 4].map((writer) => command(dir, writer, 150)),
  );
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const expected = [1, 2, 3, 4].flatMap((writer) =>
    Array.from({ length: 150 }, (_, index) => index)
      .filter((index) => index % 5 !== 0)
      .map((index) => `app ${writer}-${index}`),
  );
  assert.deepEqual(names(dir), ["older", ...expected].sort());
});

test("a crashed command's half-written temporary file, unreadable records file and old run.json.lock held by a live PID neither block another command nor end up in the run; a lock that waits while its holder's PID runs hangs it", async (t) => {
  const dir = runFolder(t);
  writeFileSync(
    join(dir, "processes-4242-0a1b.json.3c4d.tmp"),
    '[{"name":"half',
  );
  writeFileSync(join(dir, "processes-4243-0a1b.json"), '[{"name":"cut');
  writeFileSync(join(dir, "run.json.lock"), String(process.pid));
  writeFileSync(join(dir, "run.json.lock.tmp"), "");
  assert.equal(await command(dir, 1, 5), 0);
  assert.deepEqual(names(dir), ["app 1-1", "app 1-2", "app 1-3", "app 1-4"]);
});
