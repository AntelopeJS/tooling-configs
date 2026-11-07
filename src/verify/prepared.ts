import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import type { VerifyContext } from "./context.ts";
import { removeTree } from "./workspace.ts";

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Copies a tree as it is: a symlink keeps its target, so pnpm's relative links in a copy never point back into the source. */
function copyTree(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
}

/** Copies what the run kept into the journey, with one step that names the journey that built it and holds that build's evidence. */
function reuse(
  context: VerifyContext,
  key: string,
  kept: string,
  folder: string,
): void {
  const step = context.step(`prepared ${key}`);
  const from = readFileSync(join(kept, "from.txt"), "utf8").trim();
  copyTree(join(kept, "evidence"), join(step, "build"));
  copyTree(join(kept, "folder"), folder);
  writeFileSync(
    join(step, "prepared.txt"),
    `${key}: ${folder} is a copy of what ${from} prepared; build/ holds the evidence of that build\n`,
  );
}

/** Keeps the built folder and the build's step evidence for the rest of the run, published by one rename; when another journey kept the key first, its copy stays. */
function keep(
  context: VerifyContext,
  kept: string,
  folder: string,
  steps: string[],
): void {
  mkdirSync(dirname(kept), { recursive: true });
  const staging = mkdtempSync(`${kept}.`);
  try {
    mkdirSync(join(staging, "evidence"));
    for (const step of steps)
      copyTree(join(context.folder, step), join(staging, "evidence", step));
    copyTree(folder, join(staging, "folder"));
    writeFileSync(
      join(staging, "from.txt"),
      `${relative(context.state.evidence, context.folder)}\n`,
    );
    renameSync(staging, kept);
  } catch (error) {
    if (!existsSync(kept)) throw error;
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
  if (existsSync(kept)) {
    reuse(context, key, kept, folder);
    return folder;
  }
  const earlier = new Set(readdirSync(context.folder));
  const checked = context.steps.length;
  mkdirSync(folder, { recursive: true });
  await buildAlone(context, key, folder, build);
  const passed = context.steps
    .slice(checked)
    .every((step) => step.checks.every((check) => check.pass));
  if (passed)
    keep(
      context,
      kept,
      folder,
      readdirSync(context.folder).filter((entry) => !earlier.has(entry)),
    );
  return folder;
}
