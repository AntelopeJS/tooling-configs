import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
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
  addedDevDependencies,
  managedPackage,
  packageManager,
  parseManifest,
  repositoryTools,
  templatePackage,
  toolingVersions,
  usesCaptures,
  usesNuxt,
  type PackageManager,
} from "./package.ts";
import { recordedRelease } from "./adoption.ts";
import { droppedChecksSteps } from "./checks.ts";
import { isExecutable, makeExecutable } from "./exec-bit.ts";
import { pnpmWorkspaceArtifacts } from "./pnpm-workspace.ts";
import { renovateArtifacts } from "./renovate.ts";
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
import { CI_PATH, ciWorkflow, placeholderTestScript } from "./ci-workflow.ts";
import { backendBoundaryArtifacts } from "./backend-boundary.ts";
import { checkEntryOnlyConfiguration } from "./entry-only.ts";
import { planDocs, type DocsPlan } from "./docs-compat.ts";
import {
  inScaffoldExcludedPath,
  planWritingSkills,
} from "./template-agent-layer.ts";
import { checkTypecheckCoverage } from "./typecheck-coverage.ts";
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
  /** Whether sync owns .github/workflows/ci.yml: it exists, or no other workflow runs the checks. */
  managesCi: boolean;
  /** The docs-compat READMEs and caller `docs-files` lines, planned under the full profile only. */
  docs: DocsPlan | undefined;
  /** Whether package.json's `test` script only stands in for tests, so the CI caller turns its test job off. */
  placeholderTests: boolean;
  /** Whether `docs/captures.ts` exists, so package.json declares the capture tool's peers. */
  captures: boolean;
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
        context.placeholderTests,
      ),
      notes: [],
    }),
  },
  {
    path: "package.json",
    profiles: ["full", "template"],
    desired: (current, context) => {
      const content =
        context.profile === "full"
          ? managedPackage(current, context.versions, context)
          : templatePackage(current, context.versions, context);
      return { content, notes: droppedChecksSteps(current, content) };
    },
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
    profiles: ["full", "template"],
    desired: (_current, context) => ({
      content: context.suppressionBudget,
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
  executables: ReadonlySet<string>,
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
          !executables.has(artifact.path));
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
  const executables = new Set<string>();
  for (const file of [
    ...MANAGED_ARTIFACTS.map(({ path }) => path),
    ...PRESET_CONFIGS.flatMap(({ legacy }) => legacy),
  ]) {
    const path = join(root, file);
    if (existsSync(path)) {
      current.set(file, readFileSync(path, "utf8"));
      if (isExecutable(root, file)) executables.add(file);
    }
  }
  return { current, executables };
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
    nuxt: usesNuxt(root, manifest),
    claude: profile === "full" ? claudeProse(root, current) : "",
    baseline: "",
    suppressionBudget: adoptedBudget(root, current.get(SUPPRESSIONS_FILE)),
    managesCi: current.has(CI_PATH) || !hasChecksWorkflow(root),
    verificationSkill:
      profile === "template" && inScaffoldExcludedPath(verificationSkill)
        ? undefined
        : verificationSkill,
    glossary: ["GLOSSARY.md", "docs/GLOSSARY.md"].find((file) =>
      existsSync(join(root, file)),
    ),
    docs:
      profile === "full" && current.has("package.json")
        ? planDocs(root, manager)
        : undefined,
    placeholderTests:
      current.has("package.json") &&
      placeholderTestScript(manifest.scripts?.test),
    captures: usesCaptures(root),
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
    if (artifact.mode !== undefined)
      makeExecutable(root, artifact.path, artifact.mode);
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

/**
 * Measures debt only on first adoption, before sync has written the sync:check script; retired repositories stay retired.
 * Under the template profile the agent layer, `verify-template` and the writing skills, is synced only in the template source,
 * marked by its `.agents/skills/verify-template` folder or chosen with `--verify template`, because a scaffold ships without it,
 * and the AGENTS.md block, which a scaffold keeps, links no skill under it.
 */
export function syncRepository(
  root: string,
  options: {
    check?: boolean;
    profile?: AgentsBlockContext["profile"];
    verify?: VerifyChoice;
  } = {},
) {
  const profile = options.profile ?? "full";
  const { current, executables } = repositorySnapshot(root);
  const manifest = parseManifest(current.get("package.json") ?? "{}");
  const verify = planVerify(root, {
    flag: options.verify,
    manifest,
    profile,
  });
  const writing = planWritingSkills(root, profile, verify.kind);
  const actions = [...verify.actions, ...writing.actions];
  const context = repositoryContext(
    root,
    current,
    profile,
    verify.verificationSkill,
  );
  const standalone = [
    ...backendBoundaryArtifacts(root),
    ...renovateArtifacts(
      root,
      manifest,
      profile === "full" || verify.kind === "template",
    ),
    ...pnpmWorkspaceArtifacts(root, manifest, profile === "full"),
  ];
  let plan = [...planSync(current, executables, context), ...standalone];
  const errors = plan
    .filter((artifact) => artifact.kind === "error")
    .map(({ message }) => message);
  const entryOnly = checkEntryOnlyConfiguration(root);
  const coverage = checkTypecheckCoverage(root, Boolean(options.check));
  errors.push(...entryOnly.errors, ...verify.errors, ...writing.errors);
  errors.push(...coverage.errors);
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
    context.baseline = formatCeilings({
      ...baseline,
      pack: recordedRelease(undefined),
    });
    plan = [...planSync(current, executables, context), ...standalone];
  }
  const writes = plan.filter(
    (artifact) => artifact.kind === "write" || artifact.kind === "migrated",
  );
  if (!options.check && !errors.length) {
    writeArtifacts(root, writes);
    applyVerifyActions(root, actions);
  }
  const templateDependencies = ["knip"];
  if (context.typeAware) templateDependencies.push("oxlint-tsgolint");
  const dependenciesAdded =
    profile === "full"
      ? addedDevDependencies(manifest, context.versions, context).length > 0
      : templateDependencies.some((name) => !manifest.devDependencies?.[name]);
  return {
    artifacts: plan,
    paths: errors.length ? [] : [...writes, ...actions].map(({ path }) => path),
    removed: actions
      .filter((action) => action.kind === "remove")
      .map(({ path }) => path),
    errors,
    notes,
    verifyNotes: options.check || errors.length ? [] : verify.notes,
    advisories: [...entryOnly.advisories, ...coverage.advisories],
    dependenciesAdded,
  };
}
