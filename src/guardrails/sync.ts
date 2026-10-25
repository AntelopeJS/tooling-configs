import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  agentsBlock,
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  type AgentsBlockContext,
} from "./agents-block.ts";
import { CEILINGS_FILE, formatCeilings } from "./ceilings.ts";
import {
  managedPackage,
  packageManager,
  parseManifest,
  toolingVersions,
  type PackageManager,
} from "./package.ts";
import { measureBaseline } from "./ratchet.ts";
import {
  lefthook,
  PRESET_CONFIGS,
  presetConfig,
  SETUP_SCRIPT,
} from "./templates.ts";

export interface RepoContext extends AgentsBlockContext {
  manager: PackageManager;
  versions: ReturnType<typeof toolingVersions>;
  baseline: string;
}

interface ManagedArtifact {
  path: string;
  profiles: AgentsBlockContext["profile"][];
  desired: (current: string | undefined, context: RepoContext) => string;
  mode?: number;
}

function managedAgents(current = "", context: RepoContext): string {
  const start = current.indexOf(AGENTS_BLOCK_START);
  const end = current.indexOf(AGENTS_BLOCK_END);
  const block = agentsBlock(context);
  if (start === -1 && end === -1)
    return `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${block}`;
  if (start === -1 || end < start)
    throw new Error(
      "AGENTS.md has incomplete guardrails markers. Repair the markers before syncing.",
    );
  return `${current.slice(0, start)}${block.trimEnd()}${current.slice(end + AGENTS_BLOCK_END.length)}`;
}

export const MANAGED_ARTIFACTS: readonly ManagedArtifact[] = [
  ...PRESET_CONFIGS.map((preset): ManagedArtifact => ({
    path: preset.path,
    profiles: ["full", "template"],
    desired: (current) => presetConfig(current, preset),
  })),
  {
    path: "lefthook.yml",
    profiles: ["full"],
    desired: (_current, context) => lefthook(context.manager),
  },
  {
    path: "package.json",
    profiles: ["full"],
    desired: (current, context) => managedPackage(current, context.versions),
  },
  { path: ".nvmrc", profiles: ["full"], desired: () => "24\n" },
  {
    path: ".agents/setup",
    profiles: ["full"],
    desired: () => SETUP_SCRIPT,
    mode: 0o755,
  },
  { path: "AGENTS.md", profiles: ["full", "template"], desired: managedAgents },
  { path: "CLAUDE.md", profiles: ["full"], desired: () => "@AGENTS.md\n" },
  {
    path: CEILINGS_FILE,
    profiles: ["full"],
    desired: (current, context) => current ?? context.baseline,
  },
];

export interface PlannedArtifact {
  path: string;
  content: string;
  mode: number | undefined;
}

export function planSync(
  current: ReadonlyMap<string, string>,
  modes: ReadonlyMap<string, number>,
  context: RepoContext,
): PlannedArtifact[] {
  const plan: PlannedArtifact[] = [];
  for (const artifact of MANAGED_ARTIFACTS) {
    if (!artifact.profiles.includes(context.profile)) continue;
    const content = artifact.desired(current.get(artifact.path), context);
    if (
      current.get(artifact.path) !== content ||
      (artifact.mode !== undefined &&
        modes.get(artifact.path) !== artifact.mode)
    )
      plan.push({ path: artifact.path, content, mode: artifact.mode });
  }
  return plan;
}

function verificationSkill(root: string): string | undefined {
  for (const directory of [".agents/skills", ".claude/skills", "skills"]) {
    if (!existsSync(join(root, directory))) continue;
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}/SKILL.md`;
      if (
        entry.isDirectory() &&
        entry.name.toLowerCase().includes("verif") &&
        existsSync(join(root, path))
      )
        return path;
    }
  }
  return undefined;
}

export function syncRepository(
  root: string,
  options: { check?: boolean; profile?: AgentsBlockContext["profile"] } = {},
) {
  const profile = options.profile ?? "full";
  const current = new Map<string, string>();
  const modes = new Map<string, number>();
  for (const artifact of MANAGED_ARTIFACTS) {
    const path = join(root, artifact.path);
    if (existsSync(path)) {
      current.set(artifact.path, readFileSync(path, "utf8"));
      modes.set(artifact.path, statSync(path).mode & 0o777);
    }
  }
  const manifest = parseManifest(current.get("package.json") ?? "{}");
  const context: RepoContext = {
    profile,
    manager: packageManager(manifest),
    versions: toolingVersions(),
    baseline: "",
    verificationSkill: verificationSkill(root),
    glossary: ["GLOSSARY.md", "docs/GLOSSARY.md"].find((file) =>
      existsSync(join(root, file)),
    ),
  };
  if (profile === "full" && !options.check && !current.has(CEILINGS_FILE)) {
    const lint = PRESET_CONFIGS[0];
    const desired = presetConfig(current.get(lint.path), lint);
    context.baseline = formatCeilings(
      measureBaseline(
        root,
        desired === current.get(lint.path) ? undefined : desired,
      ),
    );
  }
  const plan = planSync(current, modes, context);
  if (!options.check) {
    for (const artifact of plan) {
      const path = join(root, artifact.path);
      mkdirSync(dirname(path), { recursive: true });
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
        unlinkSync(path);
      writeFileSync(path, artifact.content);
      if (artifact.mode !== undefined) chmodSync(path, artifact.mode);
    }
  }
  const dependenciesAdded =
    profile === "full" &&
    (!manifest.devDependencies?.lefthook || !manifest.devDependencies?.knip);
  return { paths: plan.map(({ path }) => path), dependenciesAdded };
}
