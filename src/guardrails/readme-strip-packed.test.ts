import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { packedPack } from "./helpers/packed-pack.ts";
import { read, testRepo } from "./helpers/test-repo.ts";

test("antelopejs-readme-strip from a pnpm-packed tarball writes the strip with both fonts, where a package that leaves assets out of its files fails on the missing font", async (t) => {
  const { packed } = await packedPack(t);
  const root = testRepo(t);
  const result = spawnSync(
    process.execPath,
    [
      join(packed, "dist", "bin", "readme-strip.mjs"),
      "--kind",
      "provider",
      "--name",
      "postgres",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const svg = read(root, ".github/readme/strip.svg");
  assert.match(svg, />PROVIDER · POSTGRES<\/text>/);
  assert.deepEqual(
    [
      ...svg.matchAll(
        /font-family:'(Geist[XM])';src:url\(data:font\/woff2;base64,(.{6})/g,
      ),
    ].map(
      ([, family, head]) =>
        `${family}:${Buffer.from(head, "base64").toString("latin1")}`,
    ),
    ["GeistX:wOF2", "GeistM:wOF2"],
  );
});
