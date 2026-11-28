import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A new directory whose strict tsconfig lists the `file.ts` a `RuleTester` with this `cwd` lints and the `modules` beside it, by file name, so a rule that asks the type checker gets one. */
export function typedCwd(modules: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "antelope-typed-cwd-"));
  const files = {
    ...modules,
    "file.ts": "export {};\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, types: [], noEmit: true },
      include: ["*.ts"],
    }),
  };
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  return root;
}
