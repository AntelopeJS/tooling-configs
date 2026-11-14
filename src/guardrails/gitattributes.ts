import type { AgentsBlockContext } from "./agents-block.ts";

/** The repository attributes file git reads at checkout. */
export const GITATTRIBUTES = ".gitattributes";

/** Checks text files out with LF on every platform, whatever `core.autocrlf` says, so a shell script still runs after a Windows clone. */
export const LF_ATTRIBUTES = "* text=auto eol=lf";

/** Whether `text` holds the LF line, whitespace between its fields aside. */
export function enforcesLf(text: string): boolean {
  return text
    .split("\n")
    .some((line) => line.trim().split(/\s+/).join(" ") === LF_ATTRIBUTES);
}

/** `current` unchanged when it already enforces LF, else with the LF line first, so the patterns it already lists still override it. */
function lfGitattributes(current: string | undefined): string {
  if (current === undefined) return `${LF_ATTRIBUTES}\n`;
  return enforcesLf(current) ? current : `${LF_ATTRIBUTES}\n${current}`;
}

/** The `.gitattributes` sync manages under both profiles, templates included, since a scaffold is cloned on Windows too. */
export const GITATTRIBUTES_ARTIFACT = {
  path: GITATTRIBUTES,
  profiles: ["full", "template"] satisfies AgentsBlockContext["profile"][],
  desired: (current: string | undefined) => ({
    content: lfGitattributes(current),
    notes: [],
  }),
};
