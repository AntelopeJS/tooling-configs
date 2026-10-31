import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { valeFiles } from "./vale-style.ts";

const target = fileURLToPath(
  new URL("../../actions/docs/vale", import.meta.url),
);

rmSync(target, { recursive: true, force: true });
for (const [path, text] of valeFiles()) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), text);
}
