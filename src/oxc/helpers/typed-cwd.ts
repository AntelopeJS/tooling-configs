import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A new directory whose strict tsconfig lists the `file.ts` a `RuleTester` with this `cwd` lints, so a rule that asks the type checker gets one. */
export function typedCwd(): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-typed-cwd-"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, types: [], noEmit: true },
      include: ["file.ts"],
    }),
  );
  writeFileSync(join(root, "file.ts"), "export {};\n");
  return root;
}
