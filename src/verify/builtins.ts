import { join } from "node:path";

import { exitIs, exists, interrupted, refused } from "./checks.ts";
import type { BuiltinJourney, VerifyContext } from "./context.ts";
import { INTERFACE_JOURNEYS } from "./interface.ts";
import type { VerifyKind } from "./kinds.ts";
import { templateInit } from "./sources.ts";

/** Loads the module from its local source next to its backing services, then stops it. */
const moduleDev: BuiltinJourney = {
  title:
    "the module loads from its local source against its backing services and stops on Ctrl+C",
  entryPoint:
    "`ajs project dev` on a project that installs the module as `local`",
  async run(context) {
    const project = context.fixture();
    const app = await context.dev("ajs project dev", project);
    const surface = await context.driver(
      "implemented interfaces",
      app,
      "/surface",
      {},
    );
    context.expect(surface.folder, [
      {
        name: "the consumer loaded every implemented interface",
        pass: surface.ok,
        detail: JSON.stringify(surface.value).slice(0, 300),
      },
    ]);
    const stopped = await context.stop("SIGINT", app);
    context.expect(stopped.folder, [interrupted(stopped)]);
    const after = await context.http(
      "port after stop",
      `http://127.0.0.1:${app.port}/health`,
    );
    context.expect(after.folder, [refused(after)]);
  },
};

/**
 * What `ajs <group> init` creates, by group: the file it writes at the root,
 * whether `pnpm run build` must run before `ajs project dev`, and the flags
 * of `ajs project dev`. A module builds first and runs in its `playground`
 * project, which loads the module's build output.
 */
const CREATED = {
  project: { file: "antelope.config.ts", build: false, dev: ["--watch"] },
  module: {
    file: "package.json",
    build: true,
    dev: ["--watch", "--project", "playground"],
  },
} as const;

/** Scaffolds a project, or a module for a module template, from the template into `project` with `ajs project init` or `ajs module init` and installs it. */
async function scaffoldInto(
  context: VerifyContext,
  project: string,
): Promise<void> {
  const init = await context.scaffold(
    `ajs ${templateInit(context.workspace)} init`,
    project,
  );
  context.expect(init.folder, [exitIs(init, 0)], { critical: true });
  context.tree("scaffolded tree", project);
  const install = await context.command(
    "pnpm install",
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline"],
    { cwd: project },
  );
  context.expect(install.folder, [exitIs(install, 0)], { critical: true });
}

/**
 * The journey's copy of the project scaffolded from the template and
 * installed, built once per run under the key `scaffolded`, which a repo
 * journey shares by preparing it with the same init and install. The copy is
 * checked for the file its init writes whichever journey built it, and the
 * journey's own HOME is pointed at the offline manifest again, since the
 * build's HOME is gone.
 */
async function scaffoldProject(context: VerifyContext): Promise<string> {
  const project = await context.prepared("scaffolded", (folder) =>
    scaffoldInto(context, folder),
  );
  const tree = context.tree("scaffolded project", project);
  const created = CREATED[templateInit(context.workspace)];
  context.expect(tree.folder, [exists(join(project, created.file))], {
    critical: true,
  });
  await context.configureGit();
  return project;
}

/** Scaffolds and installs a project from the template, runs it until it is ready, and stops it. */
const scaffoldDev: BuiltinJourney = {
  title:
    "a project, or a module, scaffolded from the template installs, starts and answers",
  entryPoint:
    "`ajs project init --template` from the interfaces manifest, then `ajs project dev --watch`, as the template's `pnpm dev` runs it; for a module template `ajs module init --template`, `pnpm run build`, then `ajs project dev --watch --project playground`",
  async run(context) {
    const created = CREATED[templateInit(context.workspace)];
    const project = await scaffoldProject(context);
    if (created.build) {
      const build = await context.command(
        "pnpm run build",
        "pnpm",
        ["run", "build"],
        { cwd: project },
      );
      context.expect(build.folder, [exitIs(build, 0)], { critical: true });
    }
    const app = await context.dev(
      `ajs project dev ${created.dev.join(" ")}`,
      project,
      { args: [...created.dev] },
    );
    const stopped = await context.stop("SIGINT", app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};

/** Scaffolds and installs a project from the template and runs its own `pnpm run checks`. */
const scaffoldChecks: BuiltinJourney = {
  title:
    "a project, or a module, scaffolded from the template passes its own checks",
  entryPoint:
    "`ajs project init --template`, or `ajs module init --template` for a module template, from the interfaces manifest, then `pnpm run checks`",
  async run(context) {
    const project = await scaffoldProject(context);
    const checks = await context.command(
      "pnpm run checks",
      "pnpm",
      ["run", "checks"],
      { cwd: project },
    );
    context.expect(checks.folder, [exitIs(checks, 0)]);
  },
};

/** The journeys each kind ships, by id; a feature file names them next to its repo-owned journeys. */
export const BUILTIN_JOURNEYS = {
  interface: INTERFACE_JOURNEYS,
  module: { "module-dev": moduleDev },
  template: { "scaffold-dev": scaffoldDev, "scaffold-checks": scaffoldChecks },
} satisfies { [Kind in VerifyKind]: { [id: string]: BuiltinJourney } };
