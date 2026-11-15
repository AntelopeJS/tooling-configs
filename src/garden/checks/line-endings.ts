import {
  enforcesLf,
  GITATTRIBUTES,
  LF_ATTRIBUTES,
} from "../../guardrails/gitattributes.ts";
import { perRepo, type Check } from "../check.ts";
import { isStackRepo } from "../stack.ts";
import { finding } from "../types.ts";

const LINE_ENDINGS = "line-endings";

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
