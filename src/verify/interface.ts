import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  isObject,
  isString,
  type JsonValue,
  optStr,
  parseJson,
} from "../garden/json.ts";
import { equal, exitIs, interrupted } from "./checks.ts";
import type { BuiltinJourney, VerifyContext } from "./context.ts";
import {
  declaredSurface,
  diffSurface,
  minorRule,
  type Surface,
} from "./surface.ts";
import { onInterrupt } from "./record.ts";
import { relativeSlashed } from "./slash.ts";
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

interface PublishedView {
  version: string | null;
  integrity: string | null;
}

/** Reads the latest version and its sha512 integrity from `npm view <name> version dist.integrity --json`. */
function publishedView(output: string): PublishedView {
  const text = output.trim();
  if (text === "") return { version: null, integrity: null };
  const parsed = parseJson(text);
  if (isString(parsed)) return { version: parsed, integrity: null };
  if (!isObject(parsed)) return { version: null, integrity: null };
  return {
    version: optStr(parsed, "version") ?? null,
    integrity: sha512Token(optStr(parsed, "dist.integrity")),
  };
}

/** The `sha512-` token of a Subresource Integrity value, which may list several hashes; `null` when it has none, which npm also checks but this cache cannot. */
function sha512Token(integrity: string | undefined): string | null {
  return (
    (integrity ?? "")
      .split(/\s+/)
      .find((token) => token.startsWith("sha512-")) ?? null
  );
}

const ONLINE = {
  npm_config_offline: "false",
  npm_config_prefer_offline: "false",
};

function tarballsIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(folder, entry));
}

/** The registry's integrity string of a file: `sha512-` and the base64 of its SHA-512. */
function integrityOf(file: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
}

/** Packs into a staging folder next to the cache, so the cache only ever receives a complete tarball that matches the published integrity. */
async function packPublished(
  context: VerifyContext,
  published: { name: string; version: string; integrity: string | null },
  folder: string,
): Promise<string | undefined> {
  const { name, version, integrity } = published;
  mkdirSync(dirname(folder), { recursive: true });
  const staging = mkdtempSync(`${folder}.pack-`);
  const release = onInterrupt(() =>
    rmSync(staging, { recursive: true, force: true }),
  );
  try {
    const packed = await context.command(
      `npm pack ${name}@${version}`,
      "npm",
      ["pack", `${name}@${version}`, "--pack-destination", staging],
      { env: ONLINE },
    );
    const [staged] = tarballsIn(staging);
    if (packed.exitCode !== 0 || staged === undefined) {
      context.expect(packed.folder, [exitIs(packed, 0)], { critical: true });
      return undefined;
    }
    if (integrity !== null) {
      const actual = integrityOf(staged);
      context.expect(
        context.step(`check packed ${name}@${version}`),
        [
          {
            name: `the packed tarball of ${name}@${version} has the integrity the registry publishes`,
            pass: actual === integrity,
            detail: `packed ${actual}, published ${integrity}`,
          },
        ],
        { critical: true },
      );
    }
    if (integrity === null) {
      const uncached = join(context.work, basename(staged));
      copyFileSync(staged, uncached);
      return uncached;
    }
    mkdirSync(folder, { recursive: true });
    const cached = join(folder, basename(staged));
    renameSync(staged, cached);
    return cached;
  } finally {
    release();
    rmSync(staging, { recursive: true, force: true });
  }
}

async function extractPublished(
  context: VerifyContext,
  tarball: string,
): Promise<string> {
  const extracted = join(context.work, "published");
  rmSync(extracted, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true });
  const untar = await context.command(
    "extract published",
    "tar",
    ["-xzf", relativeSlashed(extracted, tarball), "-C", "."],
    { cwd: extracted },
  );
  context.expect(untar.folder, [exitIs(untar, 0)], { critical: true });
  const root = join(extracted, "package");
  linkDependencies(root, context.repo);
  return root;
}

/**
 * A private copy, under the journey's work folder, of the cached tarball of a
 * version, only when it is the folder's single tarball and the copy's
 * integrity is the published one. Hashing and extracting the same copy keeps
 * another run that replaces the cached file in between from changing what
 * this journey reads.
 */
function trustedTarball(
  files: string[],
  integrity: string | null,
  work: string,
): string | undefined {
  const [only] = files;
  if (files.length !== 1 || integrity === null) return undefined;
  const copy = join(work, basename(only));
  try {
    copyFileSync(only, copy);
  } catch {
    return undefined;
  }
  return integrityOf(copy) === integrity ? copy : undefined;
}

/** Extracts a published version from the cache when its one tarball has the published integrity, and packs it again otherwise. */
async function fetchPublished(
  context: VerifyContext,
  name: string,
  published: { version: string; integrity: string | null },
): Promise<string | undefined> {
  const { version, integrity } = published;
  const folder = join(CACHE_DIR, "published", name.replace("/", "+"), version);
  const files = tarballsIn(folder);
  mkdirSync(context.work, { recursive: true });
  const trusted = trustedTarball(files, integrity, context.work);
  if (trusted !== undefined) {
    context.expect(context.step(`reuse cached ${name}@${version}`), [
      {
        name: `the cached tarball of ${name}@${version} has the published integrity, so it is reused and no npm pack ran`,
        pass: true,
        detail: `${files[0]}: ${integrity}`,
      },
    ]);
    return extractPublished(context, trusted);
  }
  if (files.length > 0) {
    for (const file of files) rmSync(file, { force: true });
    context.expect(context.step(`discard cached ${name}@${version}`), [
      {
        name: `the cached tarballs of ${name}@${version} are deleted and packed again, as ${files.length === 1 ? "the one" : `none of the ${files.length}`} cannot be trusted`,
        pass: tarballsIn(folder).length === 0,
        detail: `${files.join(", ")} against ${integrity ?? "no published integrity"}`,
      },
    ]);
  }
  const packed = await packPublished(
    context,
    { name, version, integrity },
    folder,
  );
  return packed === undefined ? undefined : extractPublished(context, packed);
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
      ["view", name, "version", "dist.integrity", "--json"],
      { env: ONLINE },
    );
    const missing = view.exitCode !== 0 && /E404/.test(view.stderr);
    if (view.exitCode !== 0 && !missing)
      context.notVerified(
        `npm view ${name} failed: ${view.stderr.trim().slice(-200)}`,
      );
    const { version: published, integrity } = missing
      ? { version: null, integrity: null }
      : publishedView(view.stdout);
    const head = readSurface(context, context.state.pack, "head");
    const root =
      published === null
        ? undefined
        : await fetchPublished(context, name, {
            version: published,
            integrity,
          });
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
