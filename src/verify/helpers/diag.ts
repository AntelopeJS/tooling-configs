import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function dumpEvidence(run: string): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".txt"))
        console.error(
          `DIAG ${path}\n${readFileSync(path, "utf8").slice(0, 600)}`,
        );
    }
  };
  walk(join(run, "evidence"));
}
