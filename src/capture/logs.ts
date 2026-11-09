import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Copies the logs the demo's `capture:start` writes under `.antelope/capture` out of the checkout, which a run
 * deletes, into a new temporary directory. Answers the line that names it, or nothing when the demo wrote no log.
 */
export function keepDemoLogs(demo: string): string[] {
  const logs = join(demo, ".antelope", "capture");
  if (!existsSync(logs)) return [];
  const kept = mkdtempSync(join(tmpdir(), "antelopejs-capture-logs-"));
  cpSync(logs, kept, { recursive: true });
  return [`the demo logs are kept in ${kept}`];
}
