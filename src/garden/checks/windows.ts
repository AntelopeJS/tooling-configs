import {
  enforcesLf,
  GITATTRIBUTES,
  LF_ATTRIBUTES,
} from "../../guardrails/gitattributes.ts";
import { runsOnWindows, windowsByDefault } from "../workflow-windows.ts";
import { perRepo, type Check } from "../check.ts";
import { isStackRepo } from "../stack.ts";
import { finding } from "../types.ts";

const CHECK = "windows-ci";
const LINE_ENDINGS = "line-endings";
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

/** Reports every framework and DMS stack repository whose `.gitattributes` does not check text files out with LF, so a Windows clone keeps its shell scripts runnable. */
export const lineEndings: Check = {
  id: LINE_ENDINGS,
  async run(context) {
    const stack = (await context.repos()).filter(({ name }) =>
      isStackRepo(name),
    );
    return perRepo(stack, async (repo) => {
      const text = await context.file(repo, GITATTRIBUTES);
      if (text !== undefined && enforcesLf(text)) return [];
      return [
        finding(
          { repo: repo.name, check: LINE_ENDINGS, subject: "gitattributes" },
          text === undefined
            ? `${GITATTRIBUTES} does not exist.`
            : `${GITATTRIBUTES} has no \`${LF_ATTRIBUTES}\` line.`,
          `${GITATTRIBUTES} holds \`${LF_ATTRIBUTES}\`, as antelopejs-sync writes it.`,
        ),
      ];
    });
  },
};
