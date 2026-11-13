import { runsOnWindows } from "../workflow-windows.ts";
import { perRepo, type Check } from "../check.ts";
import { isStackRepo } from "../stack.ts";
import { finding } from "../types.ts";

const CHECK = "windows-ci";
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Reports every framework and DMS stack repository whose workflows run no job on Windows. */
export const windowsCi: Check = {
  id: CHECK,
  async run(context) {
    const stack = (await context.repos()).filter(({ name }) =>
      isStackRepo(name),
    );
    return perRepo(stack, async (repo) => {
      const workflows = (await context.tree(repo)).filter((path) =>
        WORKFLOW.test(path),
      );
      for (const path of workflows)
        if (runsOnWindows((await context.file(repo, path)) ?? "")) return [];
      return [
        finding(
          { repo: repo.name, check: CHECK, subject: "windows" },
          workflows.length
            ? `No job in ${workflows.join(", ")} runs on Windows.`
            : "The repository has no workflow.",
          "The ci-node.yml caller passes windows: true, or a workflow job runs on windows-latest.",
        ),
      ];
    });
  },
};
