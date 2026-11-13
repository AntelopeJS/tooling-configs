import { runsOnWindows, windowsByDefault } from "../workflow-windows.ts";
import { perRepo, type Check } from "../check.ts";
import { isStackRepo } from "../stack.ts";
import { finding } from "../types.ts";

const CHECK = "windows-ci";
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const WORKFLOWS_REPO = ".github";
const CI_NODE = ".github/workflows/ci-node.yml";

/** Reports every framework and DMS stack repository whose workflows run no job on Windows. */
export const windowsCi: Check = {
  id: CHECK,
  async run(context) {
    const repos = await context.repos();
    const workflowsRepo = repos.find(({ name }) => name === WORKFLOWS_REPO);
    const windowsDefault = async (ref: string) => {
      if (workflowsRepo === undefined) return false;
      const ciNode = await context.file(workflowsRepo, CI_NODE, ref);
      return ciNode !== undefined && windowsByDefault(ciNode);
    };
    const stack = repos.filter(({ name }) => isStackRepo(name));
    return perRepo(stack, async (repo) => {
      const workflows = (await context.tree(repo)).filter((path) =>
        WORKFLOW.test(path),
      );
      for (const path of workflows)
        if (
          await runsOnWindows(
            (await context.file(repo, path)) ?? "",
            windowsDefault,
          )
        )
          return [];
      return [
        finding(
          { repo: repo.name, check: CHECK, subject: "windows" },
          workflows.length
            ? `No job in ${workflows.join(", ")} runs on Windows.`
            : "The repository has no workflow.",
          "The ci-node.yml caller passes windows: true or leaves it at a true default, or a workflow job runs on windows-latest.",
        ),
      ];
    });
  },
};
