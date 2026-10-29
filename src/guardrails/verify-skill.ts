import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  claudeLink,
  claudeLinkTarget,
  isVerifyKind,
  skillFolder,
  VERIFY_KINDS,
  type VerifyKind,
} from "../verify/kinds.ts";
import { syncedFiles } from "../verify/skills.ts";
import type { AgentsBlockContext } from "./agents-block.ts";
import type { Manifest } from "./package.ts";

/** What `--verify` accepts: a shared kind, or `custom` for a repository that owns its verification skill. */
export type VerifyChoice = VerifyKind | "custom";

/** Whether `value` is a valid `--verify` argument. */
export function isVerifyChoice(value: string): value is VerifyChoice {
  return value === "custom" || isVerifyKind(value);
}

/** One change to the synced layer of a shared verification skill. */
export type VerifyAction =
  | { kind: "write"; path: string; content: string }
  | { kind: "link"; path: string; target: string }
  | { kind: "remove"; path: string };

/** The resolved verification kind and the changes that bring the synced layer in line with it. */
export interface VerifyPlan {
  kind: VerifyChoice | undefined;
  /** The skill AGENTS.md points at, relative to the repository root. */
  verificationSkill: string | undefined;
  actions: VerifyAction[];
  errors: string[];
  notes: string[];
}

const SKILL_DIRECTORIES = [".agents/skills", ".claude/skills", "skills"];

function skillPath(kind: VerifyKind): string {
  return `${skillFolder(kind)}/SKILL.md`;
}

/** The repository's own verification skill: a folder named like `verif` with a SKILL.md, other than the shared kind folders. */
function ownVerificationSkill(root: string): string | undefined {
  const shared = VERIFY_KINDS.map(skillFolder);
  for (const directory of SKILL_DIRECTORIES) {
    if (!existsSync(join(root, directory))) continue;
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const folder = `${directory}/${entry.name}`;
      if (
        entry.isDirectory() &&
        entry.name.toLowerCase().includes("verif") &&
        !shared.includes(folder) &&
        existsSync(join(root, folder, "SKILL.md"))
      )
        return `${folder}/SKILL.md`;
    }
  }
  return undefined;
}

function inferKind(
  manifest: Manifest,
  profile: AgentsBlockContext["profile"],
): VerifyKind | undefined {
  if (profile === "template") return "template";
  const declared = manifest.antelopeJs;
  if (declared?.kind === "interface" || declared?.kind === "module")
    return declared.kind;
  if (Array.isArray(declared?.implements) && declared.implements.length > 0)
    return "module";
  return undefined;
}

interface VerifyResolution {
  kind: VerifyChoice | undefined;
  errors: string[];
}

function resolveKind(
  root: string,
  flag: VerifyChoice | undefined,
  manifest: Manifest,
  profile: AgentsBlockContext["profile"],
): VerifyResolution {
  const errors: string[] = [];
  if (flag === "custom" && ownVerificationSkill(root) === undefined)
    errors.push(
      "--verify custom needs your own verification skill: write it under .agents/skills/verify-<repo>/ first.",
    );
  if (flag !== undefined) return { kind: flag, errors };
  const synced = VERIFY_KINDS.filter((kind) =>
    existsSync(join(root, skillPath(kind))),
  );
  if (synced.length > 1)
    return {
      kind: undefined,
      errors: [
        `Several shared verification skills exist: ${synced.map(skillPath).join(", ")}. Keep one: run antelopejs-sync --verify <kind>.`,
      ],
    };
  if (synced.length === 1) return { kind: synced[0], errors };
  if (ownVerificationSkill(root) !== undefined)
    return { kind: "custom", errors };
  return { kind: inferKind(manifest, profile), errors };
}

function readIfPresent(root: string, path: string): string | undefined {
  const file = join(root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function planSharedKind(
  root: string,
  kind: VerifyKind,
): Pick<VerifyPlan, "actions" | "errors"> {
  const actions: VerifyAction[] = [];
  const errors: string[] = [];
  for (const { path, content } of syncedFiles(kind)) {
    if (lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory())
      errors.push(
        `${path} is a folder. Move it away, then rerun antelopejs-sync.`,
      );
    else if (readIfPresent(root, path) !== content)
      actions.push({ kind: "write", path, content });
  }
  const link = claudeLink(kind);
  const target = claudeLinkTarget(kind);
  const stat = lstatSync(join(root, link), { throwIfNoEntry: false });
  if (stat === undefined) actions.push({ kind: "link", path: link, target });
  else if (!stat.isSymbolicLink())
    errors.push(
      `${link} is not a symlink. Move it away, then rerun antelopejs-sync.`,
    );
  else if (readlinkSync(join(root, link)) !== target)
    actions.push({ kind: "link", path: link, target });
  return { actions, errors };
}

function planStaleKinds(
  root: string,
  keep: VerifyKind | undefined,
): Pick<VerifyPlan, "actions" | "notes"> {
  const actions: VerifyAction[] = [];
  const notes: string[] = [];
  for (const kind of VERIFY_KINDS) {
    if (kind === keep) continue;
    const before = actions.length;
    for (const { path } of syncedFiles(kind)) {
      const synced = lstatSync(join(root, path), { throwIfNoEntry: false });
      if (synced?.isFile() || synced?.isSymbolicLink())
        actions.push({ kind: "remove", path });
    }
    if (
      lstatSync(join(root, claudeLink(kind)), {
        throwIfNoEntry: false,
      })?.isSymbolicLink()
    )
      actions.push({ kind: "remove", path: claudeLink(kind) });
    if (actions.length === before) continue;
    const folder = skillFolder(kind);
    const kept =
      existsSync(join(root, folder)) &&
      readdirSync(join(root, folder)).some(
        (name) =>
          !syncedFiles(kind).some(({ path }) => path === `${folder}/${name}`),
      );
    notes.push(
      `Removed the synced files of verify-${kind}.${kept ? ` Kept its repo-owned files in ${folder}.` : ""}`,
    );
  }
  return { actions, notes };
}

/** Resolves the repository's verification kind and plans the synced layer; the repo-owned files are never touched. */
export function planVerify(
  root: string,
  options: {
    flag: VerifyChoice | undefined;
    manifest: Manifest;
    profile: AgentsBlockContext["profile"];
  },
): VerifyPlan {
  const { kind, errors } = resolveKind(
    root,
    options.flag,
    options.manifest,
    options.profile,
  );
  const shared = kind !== undefined && kind !== "custom" ? kind : undefined;
  const wanted = shared
    ? planSharedKind(root, shared)
    : { actions: [], errors: [] };
  const stale =
    kind === undefined
      ? { actions: [], notes: [] }
      : planStaleKinds(root, shared);
  return {
    kind,
    verificationSkill: shared ? skillPath(shared) : ownVerificationSkill(root),
    actions: [...wanted.actions, ...stale.actions],
    errors: [...errors, ...wanted.errors],
    notes: stale.notes,
  };
}

/** Applies planned changes; a replaced symlink is unlinked first so a write never goes through it. */
export function applyVerifyActions(
  root: string,
  actions: readonly VerifyAction[],
): void {
  for (const action of actions) {
    const path = join(root, action.path);
    if (action.kind === "remove") {
      unlinkSync(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
      unlinkSync(path);
    if (action.kind === "write") writeFileSync(path, action.content);
    else symlinkSync(action.target, path);
  }
}
