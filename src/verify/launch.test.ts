import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installNodeFake, pathWith } from "./helpers/fake-bin.ts";
import { spawnLaunched } from "./launch.ts";

function echoArgs(t: test.TestContext): NodeJS.ProcessEnv {
  const folder = mkdtempSync(join(tmpdir(), "launch-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  installNodeFake(
    folder,
    "echo-args",
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  );
  return { ...process.env, PATH: pathWith(folder) };
}

test("an npm shim gets each argument whole, cmd.exe operators and spaces included, where a quoter that lets them out runs a second command", (t) => {
  const env = echoArgs(t);
  const args = ["a&b", "c|d", "e f", "g^h", "<i>", ""];
  const run = spawnLaunched("echo-args", args, { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), args);
});

test("an argument holding a quote or a percent sign is refused on Windows, where cmd.exe would split or expand it, and passed on whole elsewhere", (t) => {
  const env = echoArgs(t);
  for (const argument of ['{"q":"a&b"}', "%PATH%", 'x" & echo INJECTED & "y']) {
    if (process.platform === "win32")
      assert.throws(
        () => spawnLaunched("echo-args", [argument], { env, encoding: "utf8" }),
        /Cannot pass .* through cmd\.exe/,
      );
    else {
      const run = spawnLaunched("echo-args", [argument], {
        env,
        encoding: "utf8",
      });
      assert.deepEqual(JSON.parse(run.stdout), [argument]);
    }
  }
});
