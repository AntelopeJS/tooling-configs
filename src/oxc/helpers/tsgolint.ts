import { mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";

/**
 * The native tsgolint executable for this platform. oxlint spawns `OXLINT_TSGOLINT_PATH` directly, and Windows cannot
 * execute the package's `bin/tsgolint.js` script.
 */
export const TSGOLINT = createRequire(
  import.meta.resolve("oxlint-tsgolint/package.json"),
).resolve(
  `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${WINDOWS ? ".exe" : ""}`,
);

/** Links {@link TSGOLINT} into `root`'s `node_modules/.bin` under the name oxlint looks for there: `tsgolint`, or `tsgolint.exe` on Windows. */
export function linkTsgolint(root: string): void {
  const bin = join(root, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(TSGOLINT, join(bin, WINDOWS ? "tsgolint.exe" : "tsgolint"));
}
