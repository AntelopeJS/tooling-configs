import { join } from "node:path";

import { exitIs, exists, interrupted, refused } from "./checks.ts";
import type { BuiltinJourney } from "./context.ts";
import { INTERFACE_JOURNEYS } from "./interface.ts";
import type { VerifyKind } from "./kinds.ts";

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

/** Scaffolds a project from the template through `ajs`, installs it, runs its checks, runs it and stops it. */
const scaffold: BuiltinJourney = {
  title:
    "a project scaffolded from the template installs, passes its checks, starts and answers",
  entryPoint:
    "`ajs project init --template` from the interfaces manifest, then `pnpm run checks` and `ajs project dev`",
  async run(context) {
    const project = join(context.work, "app");
    const init = await context.scaffold("ajs project init", project);
    context.expect(
      init.folder,
      [exitIs(init, 0), exists(join(project, "antelope.config.ts"))],
      { critical: true },
    );
    context.tree("scaffolded tree", project);
    const install = await context.command(
      "pnpm install",
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      { cwd: project },
    );
    context.expect(install.folder, [exitIs(install, 0)], { critical: true });
    const checks = await context.command(
      "pnpm run checks",
      "pnpm",
      ["run", "checks"],
      { cwd: project },
    );
    context.expect(checks.folder, [exitIs(checks, 0)]);
    const app = await context.dev("ajs project dev", project);
    const stopped = await context.stop("SIGINT", app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};

/** The journeys each kind ships, by id; a feature file names them next to its repo-owned journeys. */
export const BUILTIN_JOURNEYS = {
  interface: INTERFACE_JOURNEYS,
  module: { "module-dev": moduleDev },
  template: { scaffold },
} satisfies { [Kind in VerifyKind]: { [id: string]: BuiltinJourney } };
