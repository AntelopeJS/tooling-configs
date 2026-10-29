import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";

import { skillFolder } from "./kinds.ts";
import { git, type Workspace } from "./workspace.ts";

/** The feature that always runs, whatever the diff touches. */
export const SMOKE_FEATURE = "smoke";

/** One feature file of the map, parsed from its frontmatter. */
export interface Feature {
  name: string;
  file: string;
  covers: string[];
  docs: string[];
  journeys: string[];
  body: string;
}

const DEFAULT_USER_FACING = {
  interface: ["src/**"],
  module: ["src/**"],
  template: ["**"],
};

const VERIFICATION_LAYER = [".agents/**", ".claude/**", ".github/**"];

/** Tests are user-facing in a template, whose whole tree is what `ajs` copies. */
const NOT_USER_FACING = {
  interface: [
    "**/*.test.ts",
    "**/test/**",
    "**/tests/**",
    ...VERIFICATION_LAYER,
  ],
  module: ["**/*.test.ts", "**/test/**", "**/tests/**", ...VERIFICATION_LAYER],
  template: VERIFICATION_LAYER,
};

function frontmatterLists(text: string): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  let current: string[] | undefined;
  for (const line of (match?.[1] ?? "").split("\n")) {
    const key = /^(\w+):\s*$/.exec(line);
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (key) {
      current = [];
      lists.set(key[1], current);
    } else if (item && current) current.push(item[1].replace(/^"|"$/g, ""));
  }
  return lists;
}

/** Reads every feature file under features/, README.md excluded. */
export function readFeatures(workspace: Workspace): Feature[] {
  const folder = join(workspace.skill, "features");
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .map((file) => {
      const body = readFileSync(join(folder, file), "utf8");
      const lists = frontmatterLists(body);
      return {
        name: file.replace(/\.md$/, ""),
        file: relative(workspace.root, join(folder, file)),
        covers: lists.get("covers") ?? [],
        docs: lists.get("docs") ?? [],
        journeys: lists.get("journeys") ?? [],
        body,
      };
    });
}

function matches(file: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(file, glob));
}

/** Whether a user can observe a change to `file`. */
function userFacing(workspace: Workspace, file: string): boolean {
  const globs =
    workspace.config.userFacing ?? DEFAULT_USER_FACING[workspace.kind];
  return (
    matches(file, globs) && !matches(file, NOT_USER_FACING[workspace.kind])
  );
}

function trackedFiles(workspace: Workspace): string[] {
  return git(workspace.root, ["ls-files"]).split("\n").filter(Boolean);
}

/** The features whose globs cover `file`. */
function featuresOf(file: string, features: Feature[]): string[] {
  return features
    .filter((feature) => matches(file, feature.covers))
    .map((feature) => feature.name);
}

function featureProblems(
  workspace: Workspace,
  feature: Feature,
  known: Set<string>,
  tracked: string[],
): string[] {
  const problems: string[] = [];
  if (feature.journeys.length === 0)
    problems.push(`${feature.file}: lists no journeys`);
  for (const journey of feature.journeys) {
    if (!known.has(journey))
      problems.push(
        `${feature.file}: journey ${journey} is neither built in nor in verify.config.ts journeys`,
      );
    if (!feature.body.includes(`\`${journey}\``))
      problems.push(`${feature.file}: journey \`${journey}\` is not described`);
  }
  if (feature.name !== SMOKE_FEATURE && feature.covers.length === 0)
    problems.push(`${feature.file}: lists no covers globs`);
  for (const glob of feature.covers)
    if (!tracked.some((file) => matchesGlob(file, glob)))
      problems.push(`${feature.file}: glob ${glob} matches no tracked file`);
  if (feature.docs.length === 0)
    problems.push(`${feature.file}: lists no docs pages`);
  for (const doc of feature.docs)
    if (!existsSync(join(workspace.root, doc)))
      problems.push(`${feature.file}: docs path ${doc} does not exist`);
  if (
    !existsSync(join(workspace.skill, "seeded-breaks", `${feature.name}.patch`))
  )
    problems.push(
      `${feature.file}: seeded-breaks/${feature.name}.patch is missing`,
    );
  return problems;
}

/**
 * Checks the repo-owned layer against the repository: a smoke feature
 * exists, every user-facing file is covered, every feature names known
 * journeys, docs pages that exist and a seeded break, every config journey is
 * used, and every applicable door kind has a seeded door. One line per problem.
 */
export function checkMap(workspace: Workspace, builtins: string[]): string[] {
  const features = readFeatures(workspace);
  const tracked = trackedFiles(workspace);
  const configJourneys = Object.keys(workspace.config.journeys ?? {});
  const known = new Set([...builtins, ...configJourneys]);
  const problems: string[] = [];
  if (!features.some((feature) => feature.name === SMOKE_FEATURE))
    problems.push(
      `${skillFolder(workspace.kind)}/features/${SMOKE_FEATURE}.md is missing: every verdict runs the smoke feature`,
    );
  for (const file of tracked.filter((path) => userFacing(workspace, path)))
    if (featuresOf(file, features).length === 0)
      problems.push(`unmapped: ${file} matches no feature glob`);
  for (const feature of features)
    problems.push(...featureProblems(workspace, feature, known, tracked));
  for (const journey of configJourneys)
    if (!features.some((feature) => feature.journeys.includes(journey)))
      problems.push(
        `verify.config.ts journey ${journey} is in no feature file`,
      );
  for (const [kind, rule] of Object.entries(workspace.config.doors))
    if (
      rule &&
      !existsSync(join(workspace.skill, "seeded-doors", `${kind}.patch`))
    )
      problems.push(
        `seeded-doors/${kind}.patch is missing: the ${kind} door applies to this repository`,
      );
  return problems;
}

/** What a diff asks a verdict to run. */
export interface Plan {
  baseRef: string;
  baseSha: string;
  headSha: string;
  changed: string[];
  touched: { feature: string; files: string[] }[];
  unmapped: string[];
  docs: string[];
  run: string[];
  dirty: string[];
}

/** The files a change touches: committed since the merge base, staged, unstaged and untracked. */
function changedFiles(workspace: Workspace, baseSha: string): string[] {
  const committed = git(workspace.root, ["diff", "--name-only", baseSha]).split(
    "\n",
  );
  const untracked = git(workspace.root, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).split("\n");
  return [...new Set([...committed, ...untracked].filter(Boolean))].sort();
}

/**
 * Maps the change from the merge base of `baseRef` onto features: every
 * touched feature plus the smoke feature runs, and a user-facing file outside
 * every glob is an unmapped surface.
 */
export function planFor(workspace: Workspace, baseRef: string): Plan {
  const features = readFeatures(workspace);
  const baseSha = git(workspace.root, ["merge-base", baseRef, "HEAD"]);
  const changed = changedFiles(workspace, baseSha);
  const touched = features
    .map((feature) => ({
      feature: feature.name,
      files: changed.filter((file) => matches(file, feature.covers)),
    }))
    .filter((entry) => entry.files.length > 0);
  const unmapped = changed.filter(
    (file) =>
      userFacing(workspace, file) && featuresOf(file, features).length === 0,
  );
  const touchedNames = new Set(touched.map((entry) => entry.feature));
  const docs = [
    ...new Set(
      features
        .filter((feature) => touchedNames.has(feature.name))
        .flatMap((feature) => feature.docs),
    ),
  ];
  const run = [
    SMOKE_FEATURE,
    ...[...touchedNames].filter((name) => name !== SMOKE_FEATURE),
  ];
  const dirty = git(workspace.root, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ])
    .split("\n")
    .filter(Boolean);
  return {
    baseRef,
    baseSha,
    headSha: git(workspace.root, ["rev-parse", "HEAD"]),
    changed,
    touched,
    unmapped,
    docs,
    run,
    dirty,
  };
}
