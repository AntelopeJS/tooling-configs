import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isObject, type JsonValue } from "../garden/json.ts";
import { equal, exitIs, interrupted } from "./checks.ts";
import type { BuiltinJourney, VerifyContext } from "./context.ts";
import {
  declaredSurface,
  diffSurface,
  minorRule,
  type Surface,
} from "./surface.ts";
import type { App, Check } from "./types.ts";
import { CACHE_DIR, git } from "./workspace.ts";

/** A member the driver found by walking the loaded interface at runtime. */
interface RuntimeMember {
  path: string;
  kind: string;
}

const CALL_ARGS: JsonValue[] = ["verify-argument", 7];

function runtimeMembers(value: JsonValue | undefined): RuntimeMember[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((member) => ({
    path: String(member.path),
    kind: String(member.kind),
  }));
}

function splitPath(path: string) {
  const colon = path.indexOf(":");
  return {
    entry: path.slice(0, colon),
    keys: path.slice(colon + 1).split("."),
  };
}

function writeJson(folder: string, file: string, value: JsonValue): void {
  writeFileSync(join(folder, file), `${JSON.stringify(value, null, 2)}\n`);
}

/** Links the repository's node_modules under an extracted package, so its declarations resolve their imports. */
export function linkDependencies(packageFolder: string, repo: string): void {
  symlinkSync(
    join(repo, "node_modules"),
    join(packageFolder, "node_modules"),
    "dir",
  );
}

function readSurface(
  context: VerifyContext,
  folder: string,
  label: string,
): Surface | undefined {
  const step = context.step(`${label} declared surface`);
  try {
    const surface = declaredSurface(folder);
    writeJson(step, "surface.json", Object.fromEntries(surface));
    context.expect(step, [
      {
        name: `${label} declarations read`,
        pass: true,
        detail: `${surface.size} functions`,
      },
    ]);
    return surface;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    context.expect(
      step,
      [{ name: `${label} declarations read`, pass: false, detail }],
      { critical: true },
    );
    return undefined;
  }
}

function logged(
  context: VerifyContext,
  project: string,
  path: string,
  args: JsonValue[],
): Check {
  const calls = context.stubCalls(project);
  const seen = calls.some(
    (call) =>
      call.path === path && JSON.stringify(call.args) === JSON.stringify(args),
  );
  return {
    name: `the stub provider received ${path}(${JSON.stringify(args).slice(1, -1)})`,
    pass: seen,
    detail: JSON.stringify(calls.filter((call) => call.path.startsWith(path))),
  };
}

async function callProxy(
  context: VerifyContext,
  app: App,
  path: string,
): Promise<void> {
  const { entry, keys } = splitPath(path);
  const result = await context.call(`call ${path}`, app, {
    entry,
    path: keys,
    args: CALL_ARGS,
  });
  context.expect(result.folder, [
    {
      name: `${path} resolved through core`,
      pass: result.ok,
      detail: JSON.stringify(result.value ?? result.error),
    },
    equal(`${path} returned the stub provider's answer`, result.value, {
      stub: path,
      args: CALL_ARGS,
    }),
    logged(context, app.project, path, CALL_ARGS),
  ]);
}

async function callRegistering(
  context: VerifyContext,
  app: App,
  path: string,
): Promise<void> {
  const { entry, keys } = splitPath(path);
  const result = await context.driver(`register ${path}`, app, "/registering", {
    entry,
    path: keys,
  });
  context.expect(result.folder, [
    {
      name: `${path} register and unregister resolved through core`,
      pass: result.ok,
      detail: JSON.stringify(result.value ?? result.error),
    },
    logged(context, app.project, `${path}.register`, ["verify-registration"]),
    logged(context, app.project, `${path}.unregister`, ["verify-registration"]),
  ]);
}

async function callEvent(
  context: VerifyContext,
  app: App,
  path: string,
): Promise<void> {
  const { entry, keys } = splitPath(path);
  const result = await context.driver(`emit ${path}`, app, "/event", {
    entry,
    path: keys,
    args: CALL_ARGS,
  });
  context.expect(result.folder, [
    equal(
      `a handler registered on ${path} received the emitted arguments`,
      result.value,
      CALL_ARGS,
    ),
  ]);
}

async function callHook(
  context: VerifyContext,
  app: App,
  path: string,
  expected: JsonValue,
): Promise<void> {
  const result = await context.driver(`call ${path}`, app, "/hook", { path });
  context.expect(result.folder, [
    {
      name: `${path} resolved through core`,
      pass: result.ok,
      detail: JSON.stringify(result.value ?? result.error),
    },
    equal(
      `${path} returned the value verify.config.ts expects`,
      result.value,
      expected,
    ),
  ]);
}

function unreachable(
  context: VerifyContext,
  path: string,
  detail: string,
): void {
  context.expect(context.step(`no call for ${path}`), [
    { name: `${path} is called through core`, pass: false, detail },
  ]);
}

async function callMember(
  context: VerifyContext,
  app: App,
  path: string,
  members: RuntimeMember[],
): Promise<void> {
  const hooks = context.workspace.config.interface ?? {};
  const providerSide = hooks.providerSide?.[path];
  const hook = hooks.calls?.[path];
  const kind = members.find((member) => member.path === path)?.kind;
  if (providerSide !== undefined) {
    const step = context.step(`provider side ${path}`);
    context.expect(step, [
      {
        name: `${path} is called by providers only`,
        pass: providerSide.trim() !== "",
        detail: providerSide,
      },
    ]);
  } else if (hook !== undefined)
    await callHook(context, app, path, hook.expect);
  else if (kind === undefined)
    unreachable(
      context,
      path,
      "declared in the .d.ts files but the loaded package does not export it",
    );
  else if (kind === "async") await callProxy(context, app, path);
  else if (kind === "registering") await callRegistering(context, app, path);
  else if (kind === "event") await callEvent(context, app, path);
  else
    unreachable(
      context,
      path,
      `a plain ${kind}: add interface.calls["${path}"] to verify.config.ts, or interface.providerSide["${path}"] with why consumers never call it`,
    );
}

/** Loads the packed interface with a stub provider and a consumer, and calls every declared function through core. */
const everyFunction: BuiltinJourney = {
  title: "every declared function answers through core from a stub provider",
  entryPoint:
    "a consumer module calling the packed interface in `ajs project dev`",
  async run(context) {
    const declared = readSurface(context, context.state.pack, "head");
    const project = context.fixture();
    const app = await context.dev("ajs project dev", project);
    const surface = await context.driver(
      "runtime surface",
      app,
      "/surface",
      {},
    );
    const members = runtimeMembers(surface.value);
    context.expect(surface.folder, [
      {
        name: "the consumer walked the loaded interface",
        pass: surface.ok && members.length > 0,
        detail: `${members.length} members`,
      },
    ]);
    for (const path of declared?.keys() ?? [])
      await callMember(context, app, path, members);
    const stopped = await context.stop("SIGINT", app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};

function publishedVersion(output: string): string | null {
  const text = output.trim();
  return text === "" ? null : text.replace(/^"|"$/g, "");
}

async function fetchPublished(
  context: VerifyContext,
  name: string,
  version: string,
): Promise<string | undefined> {
  const folder = join(CACHE_DIR, "published", name.replace("/", "+"), version);
  mkdirSync(folder, { recursive: true });
  const env = {
    npm_config_offline: "false",
    npm_config_prefer_offline: "false",
  };
  const packed = await context.command(
    `npm pack ${name}@${version}`,
    "npm",
    ["pack", `${name}@${version}`, "--pack-destination", folder],
    { env },
  );
  const tarball = readdirSync(folder).find((file) => file.endsWith(".tgz"));
  if (packed.exitCode !== 0 || tarball === undefined) {
    context.expect(packed.folder, [exitIs(packed, 0)], { critical: true });
    return undefined;
  }
  const extracted = join(context.work, "published");
  mkdirSync(extracted, { recursive: true });
  const untar = await context.command("extract published", "tar", [
    "-xzf",
    join(folder, tarball),
    "-C",
    extracted,
  ]);
  context.expect(untar.folder, [exitIs(untar, 0)], { critical: true });
  const root = join(extracted, "package");
  linkDependencies(root, context.repo);
  return root;
}

function changeTitles(context: VerifyContext): string[] {
  if (context.state.title !== "") return [context.state.title];
  const base = git(context.repo, ["merge-base", context.state.baseRef, "HEAD"]);
  return git(context.repo, ["log", "--format=%s", `${base}..HEAD`])
    .split("\n")
    .filter(Boolean);
}

/** Compares the packed declarations with the published ones: an added, changed or removed function needs a new minor. */
const minorBump: BuiltinJourney = {
  title: "an added, changed or removed function releases as a new minor",
  entryPoint:
    "the published package against the packed head, as a module author upgrading sees it",
  async run(context) {
    const name = String(context.workspace.manifest.name);
    const headVersion = String(context.workspace.manifest.version);
    const view = await context.command(
      `npm view ${name}`,
      "npm",
      ["view", name, "version", "--json"],
      {
        env: {
          npm_config_offline: "false",
          npm_config_prefer_offline: "false",
        },
      },
    );
    const missing = view.exitCode !== 0 && /E404/.test(view.stderr);
    if (view.exitCode !== 0 && !missing)
      context.notVerified(
        `npm view ${name} failed: ${view.stderr.trim().slice(-200)}`,
      );
    const published = missing ? null : publishedVersion(view.stdout);
    const head = readSurface(context, context.state.pack, "head");
    const root =
      published === null
        ? undefined
        : await fetchPublished(context, name, published);
    const before =
      root === undefined
        ? undefined
        : readSurface(context, root, `published ${published}`);
    const diff = diffSurface(before ?? new Map(), head ?? new Map());
    const titles = changeTitles(context);
    const verdict = minorRule({ published, headVersion, titles, diff });
    const step = context.step("minor rule");
    writeJson(step, "minor-rule.json", {
      published,
      headVersion,
      titles,
      ...diff,
      ...verdict,
    });
    context.expect(step, [
      {
        name:
          verdict.required === "minor"
            ? `releases at least the next minor of ${published}`
            : "no function changed against the published version",
        pass: verdict.ok,
        detail: verdict.reason,
      },
    ]);
  },
};

/** The journeys the interface kind ships, by id. */
export const INTERFACE_JOURNEYS = {
  "every-function": everyFunction,
  "minor-bump": minorBump,
} satisfies { [id: string]: BuiltinJourney };
