import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  agentsBlock,
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  type AgentsBlockContext,
} from "./agents-block.ts";
import {
  CEILINGS_FILE,
  formatCeilings,
  isRetired,
  readCeilings,
} from "./ceilings.ts";
import {
  managedPackage,
  packageManager,
  parseManifest,
  repositoryTools,
  toolingVersions,
  type PackageManager,
} from "./package.ts";
import { measureBaseline } from "./ratchet.ts";
import { adoptedBudget, SUPPRESSIONS_FILE } from "./suppression-budget.ts";
import {
  lefthook,
  PRESET_CONFIGS,
  presetConfig,
  SETUP_SCRIPT,
} from "./templates.ts";
import {
  ciNodeCallers,
  ciRenovateSyncCallers,
  hasChecksWorkflow,
  MISSING_CHECKS_WORKFLOW,
} from "./workflow.ts";
import {
  CI_PATH,
  ciWorkflow,
  MUTATION_PATH,
  mutationCaller,
} from "./ci-workflow.ts";
import { checkEntryOnlyConfiguration } from "./entry-only.ts";
import { planDocs, type DocsPlan } from "./docs-compat.ts";
import {
  applyVerifyActions,
  planVerify,
  type VerifyChoice,
} from "./verify-skill.ts";

export interface RepoContext extends AgentsBlockContext {
  manager: PackageManager;
  versions: ReturnType<typeof toolingVersions>;
  tools: ReturnType<typeof repositoryTools>;
  typeAware: boolean;
  nuxt: boolean;
  claude: string;
  baseline: string;
  suppressionBudget: string;
  packageName: string;
  /** Whether sync owns .github/workflows/ci.yml: it exists, or no other workflow runs the checks. */
  managesCi: boolean;
  /** The docs-compat READMEs and caller `docs-files` lines, planned under the full profile only. */
  docs: DocsPlan | undefined;
}

interface ArtifactContent {
  content: string;
  notes: string[];
}

interface ManagedArtifact {
  path: string;
  profiles: AgentsBlockContext["profile"][];
  desired: (
    current: string | undefined,
    context: RepoContext,
  ) => ArtifactContent;
  mode?: number;
}

const LEGACY_COMMENT_INSTRUCTION =
  "- Explain non-obvious constraints and decisions in comments; avoid restating the code. Document public contracts with TSDoc.";

const RETIRED_RATCHET = `${CEILINGS_FILE} has no debt left. Run ratchet:update to delete it, then run antelopejs-sync.`;

function managedAgents(current = "", context: RepoContext): ArtifactContent {
  const start = current.indexOf(AGENTS_BLOCK_START);
  const end = current.indexOf(AGENTS_BLOCK_END);
  if ((start === -1) !== (end === -1) || end < start)
    throw new Error(
      "AGENTS.md has incomplete guardrails markers. Repair the markers before syncing.",
    );
  const notes: string[] = [];
  const clean = (text: string) =>
    text
      .split("\n")
      .filter((line) => {
        if (line.replace(/\r$/, "") !== LEGACY_COMMENT_INSTRUCTION) return true;
        notes.push(
          "Removed the legacy comment instruction from AGENTS.md's hand-written part.",
        );
        return false;
      })
      .join("\n");
  let before = clean(start === -1 ? current : current.slice(0, start));
  const after =
    start === -1 ? "" : clean(current.slice(end + AGENTS_BLOCK_END.length));
  if (context.claude)
    before = `${before.trimEnd()}${before.trim() ? "\n\n" : ""}${clean(context.claude).trimEnd()}\n\n`;
  const block = agentsBlock(context);
  return {
    content:
      start === -1
        ? `${before}${before && !before.endsWith("\n") ? "\n" : ""}${before && !before.endsWith("\n\n") ? "\n" : ""}${block}`
        : `${before}${block.trimEnd()}${after}`,
    notes,
  };
}

export const MANAGED_ARTIFACTS: readonly ManagedArtifact[] = [
  ...PRESET_CONFIGS.map((preset): ManagedArtifact => ({
    path: preset.path,
    profiles: ["full", "template"],
    desired: (current, context) => ({
      content: presetConfig(current, preset, context.tools),
      notes: [],
    }),
  })),
  {
    path: "lefthook.yml",
    profiles: ["full"],
    desired: (current, context) => ({
      content: lefthook(
        current,
        context.manager,
        context.tools,
        context.ratchet,
      ),
      notes: [],
    }),
  },
  {
    path: CI_PATH,
    profiles: ["full", "template"],
    desired: (current, context) => ({
      content: ciWorkflow(
        current,
        current === undefined ? [] : ciNodeCallers(current),
        current === undefined ? [] : ciRenovateSyncCallers(current),
        context.docs,
      ),
      notes: [],
    }),
  },
  {
    path: MUTATION_PATH,
    profiles: ["full"],
    desired: (_current, context) => ({
      content: mutationCaller(context.packageName),
      notes: [],
    }),
  },
  {
    path: "package.json",
    profiles: ["full"],
    desired: (current, context) => ({
      content: managedPackage(current, context.versions, context),
      notes: [],
    }),
  },
  {
    path: ".nvmrc",
    profiles: ["full"],
    desired: () => ({ content: "24\n", notes: [] }),
  },
  {
    path: ".agents/setup",
    profiles: ["full"],
    desired: () => ({ content: SETUP_SCRIPT, notes: [] }),
    mode: 0o755,
  },
  { path: "AGENTS.md", profiles: ["full", "template"], desired: managedAgents },
  {
    path: "CLAUDE.md",
    profiles: ["full"],
    desired: (_current, context) => ({
      content: "@AGENTS.md\n",
      notes: context.claude
        ? [
            "Moved CLAUDE.md content into AGENTS.md's hand-written part before the managed block.",
          ]
        : [],
    }),
  },
  {
    path: CEILINGS_FILE,
    profiles: ["full"],
    desired: (current, context) => ({
      content: current ?? context.baseline,
      notes: [],
    }),
  },
  {
    path: SUPPRESSIONS_FILE,
    profiles: ["full"],
    desired: (current, context) => ({
      content: current ?? context.suppressionBudget,
      notes: [],
    }),
  },
];

export type PlannedArtifact =
  | { kind: "unchanged"; path: string }
  | { kind: "write"; path: string; content: string; mode: number | undefined }
  | {
      kind: "migrated";
      path: string;
      content: string;
      mode: number | undefined;
      notes: string[];
    }
  | { kind: "error"; path: string; message: string };

function planSync(
  current: ReadonlyMap<string, string>,
  modes: ReadonlyMap<string, number>,
  context: RepoContext,
): PlannedArtifact[] {
  const plan: PlannedArtifact[] = [];
  for (const preset of PRESET_CONFIGS) {
    for (const file of preset.legacy) {
      if (current.has(file))
        plan.push({
          kind: "error",
          path: file,
          message: `${file}: move its settings into ${preset.path} extending "${context.tools.presets[preset.path]}". Delete ${file}, then rerun antelopejs-sync.`,
        });
    }
  }
  for (const artifact of MANAGED_ARTIFACTS) {
    if (!artifact.profiles.includes(context.profile)) continue;
    if (artifact.path === CEILINGS_FILE && !context.ratchet) continue;
    if (artifact.path === CI_PATH && !context.managesCi) continue;
    try {
      const { content, notes } = artifact.desired(
        current.get(artifact.path),
        context,
      );
      const changed =
        current.get(artifact.path) !== content ||
        (artifact.mode !== undefined &&
          (artifact.mode & 0o111) !== 0 &&
          ((modes.get(artifact.path) ?? 0) & 0o111) === 0);
      if (notes.length)
        plan.push({
          kind: "migrated",
          path: artifact.path,
          content,
          mode: artifact.mode,
          notes,
        });
      else if (changed)
        plan.push({
          kind: "write",
          path: artifact.path,
          content,
          mode: artifact.mode,
        });
      else plan.push({ kind: "unchanged", path: artifact.path });
    } catch (error) {
      plan.push({
        kind: "error",
        path: artifact.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  plan.push(...plannedDocs(context.docs));
  return plan;
}

function plannedDocs(docs: DocsPlan | undefined): PlannedArtifact[] {
  if (!docs) return [];
  return [
    ...docs.errors.map((message): PlannedArtifact => ({
      kind: "error",
      path: "README.md",
      message,
    })),
    ...docs.readmes.map(({ path, current, content }): PlannedArtifact =>
      current === content
        ? { kind: "unchanged", path }
        : { kind: "write", path, content, mode: undefined },
    ),
  ];
}

function repositorySnapshot(root: string) {
  const current = new Map<string, string>();
  const modes = new Map<string, number>();
  for (const file of [
    ...MANAGED_ARTIFACTS.map(({ path }) => path),
    ...PRESET_CONFIGS.flatMap(({ legacy }) => legacy),
  ]) {
    const path = join(root, file);
    if (existsSync(path)) {
      current.set(file, readFileSync(path, "utf8"));
      modes.set(file, statSync(path).mode & 0o777);
    }
  }
  return { current, modes };
}

function linksTo(root: string, link: string, target: string): boolean {
  const path = join(root, link);
  return (
    lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true &&
    resolve(root, readlinkSync(path)) === join(root, target)
  );
}

function claudeProse(
  root: string,
  current: ReadonlyMap<string, string>,
): string {
  if (
    linksTo(root, "CLAUDE.md", "AGENTS.md") ||
    linksTo(root, "AGENTS.md", "CLAUDE.md")
  )
    return "";
  const claude = current.get("CLAUDE.md")?.trim() ?? "";
  if (
    !claude.includes("\n") &&
    /^(?:@?(?:\.\/)?AGENTS\.md|(?:See |Refer to )?\[AGENTS\.md\]\((?:\.\/)?AGENTS\.md\)(?: for .*)?\.?)$/i.test(
      claude,
    )
  )
    return "";
  return claude;
}

function repositoryContext(
  root: string,
  current: ReadonlyMap<string, string>,
  profile: AgentsBlockContext["profile"],
  verificationSkill: string | undefined,
): RepoContext {
  const manifest = parseManifest(current.get("package.json") ?? "{}");
  const lint = PRESET_CONFIGS[0];
  const desiredLint = current.get(lint.path) ?? lint.content;
  const manager = packageManager(manifest);
  return {
    profile,
    ratchet: current.has(CEILINGS_FILE),
    manager,
    versions: toolingVersions(),
    tools: repositoryTools(manifest),
    typeAware: /\btypeAware["']?\s*:\s*true\b/.test(desiredLint),
    nuxt: Boolean(
      manifest.dependencies?.nuxt ||
      manifest.devDependencies?.nuxt ||
      readdirSync(root).some((name) => name.startsWith("nuxt.config.")),
    ),
    claude: profile === "full" ? claudeProse(root, current) : "",
    baseline: "",
    suppressionBudget:
      profile === "full" && !current.has(SUPPRESSIONS_FILE)
        ? adoptedBudget(root)
        : "",
    packageName: manifest.name ?? "",
    managesCi: current.has(CI_PATH) || !hasChecksWorkflow(root),
    verificationSkill,
    glossary: ["GLOSSARY.md", "docs/GLOSSARY.md"].find((file) =>
      existsSync(join(root, file)),
    ),
    docs:
      profile === "full" && current.has("package.json")
        ? planDocs(root, manager)
        : undefined,
  };
}

function writeArtifacts(
  root: string,
  artifacts: Extract<PlannedArtifact, { kind: "write" | "migrated" }>[],
): void {
  for (const artifact of artifacts) {
    const path = join(root, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      unlinkSync(path);
    writeFileSync(path, artifact.content);
    if (artifact.mode !== undefined) chmodSync(path, artifact.mode);
  }
}

function repositoryNotices(root: string, context: RepoContext): string[] {
  const notices: string[] = [];
  if (
    context.profile === "full" &&
    !hasChecksWorkflow(root) &&
    existsSync(join(root, CI_PATH))
  )
    notices.push(MISSING_CHECKS_WORKFLOW);
  if (context.ratchet && isRetired(readCeilings(root)))
    notices.push(RETIRED_RATCHET);
  return notices;
}

/** Measures debt only on first adoption, before sync has written the sync:check script; retired repositories stay retired. */
export function syncRepository(
  root: string,
  options: {
    check?: boolean;
    profile?: AgentsBlockContext["profile"];
    verify?: VerifyChoice;
  } = {},
) {
  const profile = options.profile ?? "full";
  const { current, modes } = repositorySnapshot(root);
  const manifest = parseManifest(current.get("package.json") ?? "{}");
  const verify = planVerify(root, {
    flag: options.verify,
    manifest,
    profile,
  });
  const context = repositoryContext(
    root,
    current,
    profile,
    verify.verificationSkill,
  );
  let plan = planSync(current, modes, context);
  const errors = plan
    .filter((artifact) => artifact.kind === "error")
    .map(({ message }) => message);
  const entryOnly = checkEntryOnlyConfiguration(root);
  errors.push(...entryOnly.errors, ...verify.errors);
  const notes = plan.flatMap((artifact) =>
    artifact.kind === "migrated" ? artifact.notes : [],
  );
  (options.check ? errors : notes).push(...repositoryNotices(root, context));
  if (
    !errors.length &&
    profile === "full" &&
    !options.check &&
    !current.has(CEILINGS_FILE) &&
    manifest.scripts?.["sync:check"] === undefined
  ) {
    const lint = PRESET_CONFIGS[0];
    const desired = presetConfig(current.get(lint.path), lint, context.tools);
    const baseline = measureBaseline(
      root,
      desired === current.get(lint.path) ? undefined : desired,
    );
    context.ratchet = !isRetired(baseline);
    context.baseline = formatCeilings(baseline);
    plan = planSync(current, modes, context);
  }
  const writes = plan.filter(
    (artifact) => artifact.kind === "write" || artifact.kind === "migrated",
  );
  if (!options.check && !errors.length) {
    writeArtifacts(root, writes);
    applyVerifyActions(root, verify.actions);
  }
  const requiredDependencies = ["lefthook", "knip"];
  if (context.typeAware) requiredDependencies.push("oxlint-tsgolint");
  const dependenciesAdded =
    profile === "full" &&
    requiredDependencies.some((name) => !manifest.devDependencies?.[name]);
  return {
    artifacts: plan,
    paths: errors.length
      ? []
      : [...writes, ...verify.actions].map(({ path }) => path),
    removed: verify.actions
      .filter((action) => action.kind === "remove")
      .map(({ path }) => path),
    errors,
    notes,
    verifyNotes: options.check || errors.length ? [] : verify.notes,
    advisories: entryOnly.advisories,
    dependenciesAdded,
  };
}
