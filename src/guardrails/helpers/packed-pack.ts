import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { makeExecutable } from "../exec-bit.ts";
import { packTarball } from "../pack-tarball.ts";
import { PACKAGE_ROOT } from "./test-repo.ts";

/**
 * Copies the pack's working tree into a fresh git repository, with the exec bits its index records, packs it there through {@link packTarball},
 * and extracts the tarball. Returns the copy as `source` and the extracted package as `packed`, both linked to the pack's
 * `node_modules`; `t.after` deletes them.
 */
export async function packedPack(t: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), "packed-pack-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = join(scratch, "source");
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: PACKAGE_ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path && existsSync(join(PACKAGE_ROOT, path)));
  for (const path of files)
    cpSync(join(PACKAGE_ROOT, path), join(source, path), {
      recursive: true,
      verbatimSymlinks: true,
    });
  const modules = join(PACKAGE_ROOT, "node_modules");
  symlinkSync(modules, join(source, "node_modules"));
  execFileSync("git", ["init", "-q"], { cwd: source });
  for (const line of execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  }).split("\0"))
    if (line.startsWith("100755 "))
      makeExecutable(source, line.slice(line.indexOf("\t") + 1), 0o755);
  const destination = join(scratch, "tarball");
  const result = await packTarball("pnpm", source, destination);
  if (result.status !== 0) throw new Error(result.output);
  const [tarball = ""] = readdirSync(destination);
  execFileSync("tar", ["-xzf", `tarball/${tarball}`], { cwd: scratch });
  const packed = join(scratch, "package");
  symlinkSync(modules, join(packed, "node_modules"));
  return { source, packed };
}
