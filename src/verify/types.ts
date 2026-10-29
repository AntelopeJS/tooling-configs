import type { JsonObject, JsonValue } from "../garden/json.ts";

/** A kind of one-way door, the closed list of Upd4ting/outer-loop#42. */
export type DoorKind =
  | "data"
  | "format"
  | "contract"
  | "outbound"
  | "exposure"
  | "publish";

/** Path rules for one door kind: the globs, the declared funnel modules and the journeys that contain it. */
export interface DoorRule {
  /** Repository paths whose change opens a door of this kind, on top of the pack's defaults for the repo kind. */
  globs: string[];
  /** The only modules allowed to make this kind's calls (outbound clients, raw deletes); also path rules. */
  funnels: string[];
  /** Journeys, as `feature/journey`, whose pass contains a Data or Format door of this kind. */
  containments: string[];
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
  /** Globs of the check's own files (its model, its tests): a diff that changes one also runs the check on the base. */
  files?: string[];
  /** Runs from the repository root; exits 0 while every finding breaks as recorded. */
  command: string[];
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

/** The answer of an HTTP request, or the network error when nothing answered. */
export interface HttpResult {
  folder: string;
  url: string;
  status: number | null;
  body: string;
  json: JsonValue | undefined;
  error: string | null;
}

/** The tree a step recorded: its folder and every path with its size. */
export interface TreeRecord {
  folder: string;
  lines: string[];
}

/** Options of `ajs project dev`: extra environment and extra flags such as `--watch`. */
export interface DevOptions {
  env?: { [name: string]: string };
  args?: string[];
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
  /** The export subpath, `.` by default. */
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
  command(
    name: string,
    program: string,
    args: string[],
    options?: DriveOptions,
  ): Promise<CommandResult>;
  edit(name: string, file: string, content: string): string;
  tree(name: string, root: string): TreeRecord;
  http(
    name: string,
    url: string,
    init?: { method?: string; body?: string },
  ): Promise<HttpResult>;
  /** Records the checks of a step. A failing `critical` step ends the journey. */
  expect(
    folder: string,
    checks: Check[],
    options?: { critical?: boolean },
  ): boolean;
  /** Ends the journey as not verified, for example when provider sandbox keys are missing. */
  notVerified(reason: string): never;
  service(name: string): ServiceEndpoint;
  /** Runs a command inside a service's container: the read-back through the native client. */
  native(name: string, service: string, args: string[]): Promise<CommandResult>;
  /** Writes the fixture project of the interface or module kind and returns its folder. Each call writes a fresh project, so a journey can hold several. */
  fixture(options?: { moduleConfig?: JsonObject }): string;
  /** Starts `ajs project dev` in a project and waits until it is ready. */
  dev(name: string, project: string, options?: DevOptions): Promise<App>;
  call(name: string, app: App, request: CallRequest): Promise<CallResult>;
  /** Stops an app with SIGINT by recorded PID. */
  stop(name: string, app: App): Promise<StopResult>;
  /** Creates a project from the template under verification with `ajs project init`. */
  scaffold(
    name: string,
    project: string,
    flags?: string[],
  ): Promise<CommandResult>;
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

/** The repo-owned layer of a shared verification skill: `.agents/skills/verify-<kind>/verify.config.ts`. */
export interface VerifyConfig<Api = never> {
  doors: DoorRules;
  formal?: FormalCheck[];
  /** Files whose change a user can observe; replaces the kind's default. */
  userFacing?: string[];
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
  interface?: InterfaceHooks<Api>;
  /** The template kind: its name in the offline manifest, whether it is a project template, and its readiness probe. */
  template?: { name?: string; project?: boolean; probe: TemplateProbe };
}
