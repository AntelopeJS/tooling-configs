import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { authoredSizes } from "./files.ts";

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue)$/u;
const BLANKET_DISABLE =
  /(?:\/\*|\/\/)\s*((?:eslint|oxlint)-disable(?:-line|-next-line)?)\s*(?:--[^\n]*?)?(?:\*\/|$)/gmu;

function fileText(root: string, file: string, staged: boolean): string {
  if (!staged) {
    const path = join(root, file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }
  const result = spawnSync("git", ["show", `:${file}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : "";
}

/** Reports disable directives without a rule list: oxlint honours them before any rule runs, so they also silence no-comments. */
export function checkBlanketDisables(
  root: string,
  files?: string[],
  staged = false,
): string[] {
  const failures: string[] = [];
  for (const file of authoredSizes(root, files, staged).keys()) {
    if (!CODE_FILE.test(file)) continue;
    const text = fileText(root, file, staged);
    for (const match of text.matchAll(BLANKET_DISABLE)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(
        `${file}:${line}: \`${match[1]}\` without a rule list disables every rule, the comment ban included. Name the rule(s) and give a reason, for example: oxlint-disable-next-line no-debugger -- debugging this operation.`,
      );
    }
  }
  return failures;
}
