import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { VerifyContext } from "./context.ts";
import type { StepRecord } from "./results.ts";
import { removeTree } from "./workspace.ts";

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The path of `path` inside `root`, or `null` when it lies outside. */
function inside(root: string, path: string): string | null {
  const rest = relative(root, path);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest))
    return null;
  return rest;
}

/** A symlink under a built folder whose absolute target lies inside it, both as paths inside the folder. */
interface Link {
  path: string;
  target: string;
}

/** Under a built folder, its absolute symlinks into itself, and the first entry a copy would drop. */
interface Survey {
  links: Link[];
  special: string | null;
}

/** Surveys `folder` in one walk that follows no symlink; a target may name the folder by its real path. */
function survey(folder: string): Survey {
  const real = realpathSync(folder);
  const found: Survey = { links: [], special: null };
  for (const entry of readdirSync(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) {
      const pointed = readlinkSync(path);
      const target = isAbsolute(pointed)
        ? (inside(folder, pointed) ?? inside(real, pointed))
        : null;
      if (target !== null)
        found.links.push({ path: relative(folder, path), target });
    } else if (!entry.isFile() && !entry.isDirectory())
      found.special ??= relative(folder, path);
  }
  return found;
}

/**
 * Copies `source` to `target`, which ends up at `root`. Each of `links`
 * points to its target inside `root`, so no copy reaches another journey's
 * folder. Every other symlink keeps its target, so pnpm's relative links in a
 * copy never point back into the source.
 */
function copyTree(
  source: string,
  target: string,
  links: Link[] = [],
  root = target,
): void {
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
  for (const link of links) {
    unlinkSync(join(target, link.path));
    symlinkSync(join(root, link.target), join(target, link.path));
  }
}

/** Whether the run keeps a build: only one that recorded a check, passed every check and holds nothing a copy would drop. */
type Verdict = { kept: true; links: Link[] } | { kept: false; reason: string };

/** Judges the build of `folder` by the steps it recorded. */
function judge(steps: StepRecord[], folder: string): Verdict {
  const checks = steps.flatMap((step) => step.checks);
  if (checks.length === 0)
    return { kept: false, reason: "the build recorded no check" };
  if (!checks.every((check) => check.pass))
    return { kept: false, reason: "a check of the build failed" };
  const found = survey(folder);
  return found.special === null
    ? { kept: true, links: found.links }
    : {
        kept: false,
        reason: `${found.special} is not a file, directory or symlink, which a copy would drop`,
      };
}

/** The links `keep` recorded, each a path then its target, joined by NUL, the one character no path holds. */
function readLinks(kept: string): Link[] {
  const fields = readFileSync(join(kept, "links"), "utf8").split("\0");
  const links: Link[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2)
    links.push({ path: fields[at], target: fields[at + 1] });
  return links;
}

/** The journey that built what the run kept, as its path under the evidence. */
function builder(kept: string): string {
  return readFileSync(join(kept, "from.txt"), "utf8").trim();
}

/** Copies what the run kept into the journey, with one step that names the journey that built it and holds that build's evidence. */
function reuse(
  context: VerifyContext,
  key: string,
  kept: string,
  folder: string,
): void {
  const step = context.step(`prepared ${key}`);
  copyTree(join(kept, "evidence"), join(step, "build"));
  copyTree(join(kept, "folder"), folder, readLinks(kept));
  writeFileSync(
    join(step, "prepared.txt"),
    `${key}: ${folder} is a copy of what ${builder(kept)} prepared; build/ holds the evidence of that build\n`,
  );
}

/** Keeps the built folder and the build's step evidence for the rest of the run, published by one rename; when another journey kept the key first, its copy stays and this returns `false`. */
function keep(
  context: VerifyContext,
  kept: string,
  folder: string,
  built: { steps: string[]; links: Link[] },
): boolean {
  mkdirSync(dirname(kept), { recursive: true });
  const staging = mkdtempSync(`${kept}.`);
  try {
    mkdirSync(join(staging, "evidence"));
    for (const step of built.steps)
      copyTree(join(context.folder, step), join(staging, "evidence", step));
    copyTree(
      folder,
      join(staging, "folder"),
      built.links,
      join(kept, "folder"),
    );
    writeFileSync(
      join(staging, "links"),
      built.links.flatMap((link) => [link.path, link.target]).join("\0"),
    );
    writeFileSync(
      join(staging, "from.txt"),
      `${relative(context.state.evidence, context.folder)}\n`,
    );
    renameSync(staging, kept);
    return true;
  } catch (error) {
    if (!existsSync(kept)) throw error;
    return false;
  } finally {
    removeTree(staging);
  }
}

/** Runs `build` with a HOME of its own for its commands, deleted when it ends. */
async function buildAlone(
  context: VerifyContext,
  key: string,
  folder: string,
  build: (folder: string) => Promise<void>,
): Promise<void> {
  const outer = context.buildHome;
  const home = join(context.home, `.prepared-${key}`);
  mkdirSync(home, { recursive: true });
  context.buildHome = home;
  try {
    await build(folder);
  } finally {
    context.buildHome = outer;
    removeTree(home);
  }
}

/** Builds `key` in this journey, after a step that marks the steps after it as the build and says whether the run kept it. */
async function buildHere(
  context: VerifyContext,
  key: string,
  kept: string,
  folder: string,
  build: (folder: string) => Promise<void>,
): Promise<void> {
  const marker = context.step(`prepared ${key}`);
  const note = (outcome: string) =>
    writeFileSync(
      join(marker, "prepared.txt"),
      `${key}: ${folder} was built here by the steps after this one; ${outcome}\n`,
    );
  const earlier = new Set(readdirSync(context.folder));
  const checked = context.steps.length;
  mkdirSync(folder, { recursive: true });
  try {
    await buildAlone(context, key, folder, build);
  } catch (error) {
    note("not kept: the build threw, so the next journey builds again");
    throw error;
  }
  const verdict = judge(context.steps.slice(checked), folder);
  if (!verdict.kept) {
    note(`not kept: ${verdict.reason}, so the next journey builds again`);
    return;
  }
  const steps = readdirSync(context.folder).filter(
    (entry) => !earlier.has(entry),
  );
  note(
    keep(context, kept, folder, { steps, links: verdict.links })
      ? "kept, so later journeys of the run copy it"
      : `not kept: ${builder(kept)} kept ${key} first, so later journeys copy that build`,
  );
}

/** `JourneyContext.prepared` for one journey of the run. */
export async function prepare(
  context: VerifyContext,
  key: string,
  build: (folder: string) => Promise<void>,
): Promise<string> {
  if (!KEY.test(key))
    throw new Error(
      `prepared key ${JSON.stringify(key)} must be lowercase letters and digits joined by dashes`,
    );
  const folder = join(context.work, key);
  if (existsSync(folder))
    throw new Error(`${folder} already exists: a journey prepares ${key} once`);
  const kept = join(context.state.dir, "prepared", key);
  if (
    existsSync(kept) &&
    builder(kept) === relative(context.state.evidence, context.folder)
  )
    removeTree(kept);
  if (existsSync(kept)) reuse(context, key, kept, folder);
  else await buildHere(context, key, kept, folder, build);
  return folder;
}
