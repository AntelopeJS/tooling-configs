/** The repository kinds whose verification skill is synced from this pack. */
export const VERIFY_KINDS = ["interface", "module", "template"] as const;

/** A repository kind with a shared verification skill. */
export type VerifyKind = (typeof VERIFY_KINDS)[number];

/** Whether `value` names a shared verification kind. */
export function isVerifyKind(value: string): value is VerifyKind {
  return VERIFY_KINDS.some((kind) => kind === value);
}

/** The skill folder of a kind, relative to the repository root. */
export function skillFolder(kind: VerifyKind): string {
  return `.agents/skills/verify-${kind}`;
}

/** The `.claude/skills` link that exposes a kind's skill folder to Claude Code. */
export function claudeLink(kind: VerifyKind): string {
  return `.claude/skills/verify-${kind}`;
}

/** Where the link points, relative to the link's own folder. */
export function claudeLinkTarget(kind: VerifyKind): string {
  return `../../${skillFolder(kind)}`;
}

/** The files `antelopejs-sync` writes into a shared skill folder; everything else there is the repository's own. */
export const SYNCED_SKILL_FILES = [
  "SKILL.md",
  "package.json",
  "tsconfig.json",
] as const;

/** A file of a shared skill folder that `antelopejs-sync` owns. */
export type SyncedSkillFile = (typeof SYNCED_SKILL_FILES)[number];

/**
 * Every path under the agent directories that `antelopejs-sync` writes for the shared skills:
 * each kind's synced files and its `.claude/skills` link, which shows the whole folder, repository files included, a second time.
 */
export function syncedAgentPaths(): string[] {
  return VERIFY_KINDS.flatMap((kind) => [
    ...SYNCED_SKILL_FILES.map((file) => `${skillFolder(kind)}/${file}`),
    claudeLink(kind),
  ]);
}
