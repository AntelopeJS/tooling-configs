import { authoredSizes } from "./files.ts";
import { revisionSuppressions, worktreeSuppressions } from "./suppressions.ts";

/** Reports disable directives without a rule list: oxlint honours them before any rule runs, so they also silence no-comments. */
export function checkBlanketDisables(
  root: string,
  files?: string[],
  staged = false,
): string[] {
  const authored = [...authoredSizes(root, files, staged).keys()];
  const suppressions = staged
    ? revisionSuppressions(root, "", authored)
    : worktreeSuppressions(root, authored);
  return suppressions.flatMap((suppression) =>
    suppression.kind === "rule" && suppression.rule === "*"
      ? [
          `${suppression.file}:${suppression.line}: \`${suppression.directive}\` without a rule list disables every rule, the comment ban included. Name the rule(s) and give a reason, for example: oxlint-disable-next-line no-debugger -- debugging this operation.`,
        ]
      : [],
  );
}
