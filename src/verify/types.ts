import type { JsonObject, JsonValue } from "../garden/json.ts";

/** A kind of one-way door, the closed list of Upd4ting/outer-loop#42. */
export type DoorKind =
  | "data"
  | "format"
  | "contract"
  | "outbound"
  | "exposure"
  | "publish";

/** Path rules for one door kind: the globs and the declared funnel modules. */
export interface DoorRule {
  /** Repository paths whose change opens a door of this kind, on top of the pack's defaults for the repo kind. */
  globs: string[];
  /** The only modules allowed to make this kind's calls (outbound clients, raw deletes); also path rules. */
  funnels: string[];
  /** Why these paths are doors in this repository. */
  why: string;
}

/** Every door kind with its rule, or `null` when the kind cannot apply to the repository. */
export type DoorRules = { [Kind in DoorKind]: DoorRule | null };

/**
 * How `formal` decides whether a diff changed what the covered code does:
 * `emit` compares the structure of the covered files' JavaScript on the
 * base and on HEAD (top-level statements in order per file, function
 * declarations apart); `probe` runs `command` with a worktree of each commit as its last
 * argument and compares what it prints.
 */
export type BehaviourMethod =
  | { kind: "emit" }
  | { kind: "probe"; command: string[] };

/** A formal check, the source files it covers, its own files, the command that runs it and how its output names a violated and a passing rule. */
export interface FormalCheck {
  name: string;
  covers: string[];
  /** Globs of the check's own files (its model, its tests): a diff that changes one runs the check, even when no covered file changed, and also runs it on the base. */
  files?: string[];
  /** Runs from the repository root; exits 0 while every finding breaks as recorded. */
  command: string[];
  /** The first capture group names a rule the output reports as broken, and an optional group named `states`, after it, gives its counterexample length in decimal digits; a `states` group that is the first group, that captures anything but digits, or whose number is above `Number.MAX_SAFE_INTEGER` gives no length; a covered behaviour change keeps the base's findings as known only when every one has the same length at HEAD as on the base. Without `violation`, a non-zero exit is the one rule `property` broken. */
  violation: RegExp | null;
  /** The first capture group names a rule the output reports as holding; a base finding counts as fixed only when HEAD reports it so. Without `passing` and `violation`, a zero exit is the one rule `property` holding. */
  passing?: RegExp | null;
  /** How a diff is judged to change the covered behaviour; `emit` by default. */
  behaviour?: BehaviourMethod;
  /** The command run on a worktree of the base when the covered behaviour or the check's own files changed, to tell which findings HEAD fixed; `command` by default. */
  baseCommand?: string[];
}

/** A backing service the harness runs in Docker for every run, published on a free loopback port. */
export interface ServiceDefinition {
  image: string;
  /** The port the service listens on inside its container. */
  port: number;
  env?: { [name: string]: string };
  /** Runs inside the container until it exits 0: the readiness probe. */
  ready: string[];
  /** Runs inside the container before each journey, so every journey starts from a clean state. */
  reset?: string[];
}

/** Where a running service answers from the host. */
export interface ServiceEndpoint {
  name: string;
  container: string;
  host: string;
  port: number;
}

/** One expectation a step met or missed, with what was observed. */
export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** What one driven command produced, read back from its evidence folder. */
export interface CommandResult {
  folder: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** A journey's HTTP request. `headers` win over the `content-type: application/json` a `body` gets by default. */
export interface HttpInit {
  method?: string;
  body?: string;
  headers?: { [name: string]: string };
}

/** The answer of an HTTP request, or the network error when nothing answered. */
export interface HttpResult {
  folder: string;
  url: string;
  status: number | null;
  /** The response headers, names lower-cased; empty when nothing answered. */
  headers: { [name: string]: string };
  body: string;
  json: JsonValue | undefined;
  error: string | null;
}

/** The tree a step recorded: its folder and every path with its size. */
export interface TreeRecord {
  folder: string;
  lines: string[];
}

/** Options of `context.dev`: extra environment and extra flags such as `--watch`. */
export interface DevOptions {
  env?: { [name: string]: string };
  args?: string[];
  /**
   * The program and arguments that start the project in place of `ajs project dev`, for a project that is not an `ajs` project, such as `["node", "ace", "serve"]`. `args` follow it.
   */
  command?: [program: string, ...args: string[]];
}

/** Options of a driven command. */
export interface DriveOptions {
  cwd?: string;
  env?: { [name: string]: string };
  timeoutMs?: number;
}

/** A request to the driver module: call an interface member through core, then chain methods on the awaited result. */
export interface CallRequest {
  /** The interface package; defaults to the interface under verification, or the module's only implemented interface. */
  interface?: string;
  /** The export subpath; defaults to the interface's only entry, else `.`. */
  entry?: string;
  /** The member path inside the entry, for example `["GetClient"]`. */
  path: string[];
  args?: JsonValue[];
  /** Methods called in turn on the awaited result, each `[method, ...args]`. */
  chain?: JsonValue[][];
}

/** What the driver answered: the awaited value, or the error the call threw. */
export interface CallResult extends HttpResult {
  ok: boolean;
  value: JsonValue | undefined;
}

/** A running `ajs project dev` and the ports it answers on. */
export interface App {
  name: string;
  pid: number;
  folder: string;
  project: string;
  /** The driver module's port in a fixture project, or the port given to a scaffolded project. */
  port: number;
}

/** How a stopped app ended, with its output. */
export interface StopResult {
  folder: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** The API a journey drives the product through. Every call records its evidence in a numbered step folder. */
export interface JourneyContext {
  /** The repository under verification. */
  readonly repo: string;
  /** The journey's scratch folder, removed by `clean`. */
  readonly work: string;
  /** The journey's own HOME. */
  readonly home: string;
  /** Runs a program. A project whose `.antelope/cache` gains more than one module during it keeps no cache for later journeys; run `ajs` through `ajs` to keep one. */
  command(
    name: string,
    program: string,
    args: string[],
    options?: DriveOptions,
  ): Promise<CommandResult>;
  edit(name: string, file: string, content: string): string;
  tree(name: string, root: string): TreeRecord;
  http(name: string, url: string, init?: HttpInit): Promise<HttpResult>;
  /** Records the checks of a step. A failing `critical` step ends the journey. */
  expect(
    folder: string,
    checks: Check[],
    options?: { critical?: boolean },
  ): boolean;
  /**
   * Ends the journey as not verified, for example when provider sandbox keys
   * are missing or something the journey depends on outside the harness's
   * services and apps stopped answering. An environment failure is never a
   * failing check.
   */
  notVerified(reason: string): never;
  service(name: string): ServiceEndpoint;
  /** Runs a command inside a service's container: the read-back through the native client. */
  native(name: string, service: string, args: string[]): Promise<CommandResult>;
  /**
   * Writes the fixture project of the interface or module kind and returns its folder. Each call writes a fresh project, so a journey can hold several.
   * The project's `.antelope/cache` starts as a copy of a cache of registry modules an earlier passing journey of the run left exactly as a fresh `ajs` install leaves it, none installed from a lock record, so `ajs` installs a registry module once per run.
   */
  fixture(options?: { moduleConfig?: JsonObject }): string;
  /** Starts `ajs project dev`, or `options.command`, in a project, records its PID for `stop` and `clean`, and waits until it is ready. */
  dev(name: string, project: string, options?: DevOptions): Promise<App>;
  call(name: string, app: App, request: CallRequest): Promise<CallResult>;
  /** Stops an app with SIGINT by recorded PID. */
  stop(name: string, app: App): Promise<StopResult>;
  /**
   * Creates a project from the template under verification with `ajs project init`, or a module with `ajs module init` when `template.module` is set.
   * Once a project init succeeds, the project's `.antelope/cache` starts as a copy of a cache of registry modules an earlier passing journey of the run left exactly as a fresh `ajs` install leaves it, none installed from a lock record.
   */
  scaffold(
    name: string,
    project: string,
    flags?: string[],
  ): Promise<CommandResult>;
  /**
   * Builds a folder once per run and gives every journey its own copy, for
   * the preparation many journeys repeat, such as a scaffolded and installed
   * project. Returns `<work>/<key>`. The first journey of the run that asks
   * for `key` runs `build` on that empty folder with its usual recorded
   * steps, after a step `prepared <key>` that marks them as the build and says
   * whether the run kept it. The run keeps a copy of the folder and of the
   * build's step evidence only when `build` returns, recorded at least one
   * check, passed every check, and left nothing in the folder but files,
   * directories and symlinks. A later journey of the run, in this `journey`
   * command or a later one, gets a fresh copy of the kept folder and one
   * step, `prepared <key>`, that names the journey that built it and holds
   * that build's evidence under `build/`. A build that is not kept is built
   * again by the next journey. Rerunning the journey that built builds again.
   * In a copy, an absolute symlink into the built folder points to the same
   * path in the copy; every other symlink keeps its target. A file the build
   * left with another hard link, such as a package file pnpm links from its
   * store, is linked into each copy rather than copied, so a journey replaces
   * such a file instead of writing it in place. `build` writes
   * only inside the folder it is given: what it writes elsewhere, such as a
   * sibling in the journey's work folder or the repository, stays with the
   * journey that built. Two journeys that ask for the same key at once, in
   * concurrent `journey` commands, both build, and the first to finish is
   * kept. The commands `build` runs get a HOME of their own, deleted when
   * `build` ends, so what they write there (`ajs config set git`, caches) is
   * never kept and every journey continues with its own HOME. Every journey
   * passes the same `build` for a key. `key` is lowercase letters and digits
   * joined by dashes. `clean` deletes what the run kept.
   */
  prepared(
    key: string,
    build: (folder: string) => Promise<void>,
  ): Promise<string>;
}

/** A repo-owned journey of `verify.config.ts`, named by id in a feature file. */
export interface Journey {
  title: string;
  entryPoint: string;
  run(context: JourneyContext): Promise<void>;
}

/** An exported function of an interface that is not a proxy, called through core by the driver module. */
export interface InterfaceCall<Api> {
  call(api: Api): Promise<JsonValue>;
  /** The value the call must resolve to. */
  expect: JsonValue;
}

/** Repo-owned hooks of the interface kind for contracts that are not interface proxies. */
export interface InterfaceHooks<Api> {
  /** Runs in the stub provider module after the generic stubs attach, for example to call `internal.SetClient`; `services` are the run's backing services as they answer from the host. */
  provide?(api: Api, services: ServiceEndpoint[]): void | Promise<void>;
  /** Plain exported functions, by path such as `.:GetClient`, called by the driver module. */
  calls?: { [path: string]: InterfaceCall<Api> };
  /** Exported functions only a provider calls, by path, with why the consumer never calls them. */
  providerSide?: { [path: string]: string };
}

/** How the template kind knows the scaffolded project is up. */
export interface TemplateProbe {
  /** A path on the port the harness passes as `PORT`; the welcome page or endpoint. */
  path?: string;
  status?: number;
  body?: RegExp;
  /** A line of `ajs project dev` output that means ready, for a template with no HTTP endpoint. */
  log?: RegExp;
  /** How long the process must keep running after `log` matches, 3000 ms by default: core prints nothing once modules start. */
  settleMs?: number;
}

/** A module the fixture project loads next to the module under verification: its `antelope.config.ts` source and config. */
export type CompanionModule = {
  source: JsonObject;
  config?: JsonObject;
};

/**
 * How `ajs` creates from a template. A project template (`project`) is listed
 * under `projectTemplates` and created with `ajs project init`; a module
 * template (`module`) is listed under `templates` and created with
 * `ajs module init`; any other template is listed under `templates` and
 * created as the app module of a project with `ajs project init`.
 */
export type TemplateInit =
  | { project?: boolean; module?: false }
  | { module: true; project?: false };

/** The repo-owned layer of a shared verification skill: `.agents/skills/verify-<kind>/verify.config.ts`. */
export interface VerifyConfig<Api = never> {
  doors: DoorRules;
  formal?: FormalCheck[];
  /** Files whose change a user can observe; replaces the kind's default. */
  userFacing?: string[];
  /** Files whose change runs every feature, not only the touched ones; replaces the kind's default. */
  shared?: string[];
  services?: { [name: string]: ServiceDefinition };
  /** Extra environment for every driven command. */
  env?: { [name: string]: string };
  /** Commands run in the repository by `new`, replacing the default build. */
  setup?: string[][];
  journeys?: { [id: string]: Journey };
  /** Provider sandbox keys read from the environment; without every one the run is not verified, never PASS. */
  saas?: { env: string[]; sandbox: string };
  /** The module kind's configuration of the module under verification. */
  moduleConfig?(services: ServiceEndpoint[]): JsonObject;
  /** Other modules every fixture project loads, keyed by module name, such as the provider of an interface the module imports that nothing else implements. */
  companions?(services: ServiceEndpoint[]): { [name: string]: CompanionModule };
  interface?: InterfaceHooks<Api>;
  /** The template kind: its name in the offline manifest, how `ajs` creates from it, and its readiness probe. */
  template?: { name?: string; probe: TemplateProbe } & TemplateInit;
}
