import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

import {
  isObject,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "../garden/json.ts";
import { ajsEntry, writeFixture, type Fixture } from "./fixture.ts";
import {
  freePort,
  killGroup,
  httpRecorded,
  readOutput,
  recordTree,
  runRecorded,
  startRecorded,
  type BackgroundHandle,
} from "./record.ts";
import type {
  App,
  CallRequest,
  CallResult,
  Check,
  CommandResult,
  DriveOptions,
  HttpResult,
  JourneyContext,
  ServiceEndpoint,
  StopResult,
  TreeRecord,
} from "./types.ts";
import type { JourneyEnd, StepRecord } from "./results.ts";
import {
  isolatedEnv,
  saveRun,
  type RunState,
  type Workspace,
} from "./workspace.ts";

/** A journey the pack ships for a kind; it may use the harness internals. */
export interface BuiltinJourney {
  title: string;
  entryPoint: string;
  run(context: VerifyContext): Promise<void>;
}

class JourneyAbort extends Error {}

class NotVerified extends Error {}

const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Running {
  app: App;
  handle: BackgroundHandle;
}

/** The harness side of a journey: every driving call writes its evidence into a new numbered step folder. */
export class VerifyContext implements JourneyContext {
  readonly repo: string;
  readonly folder: string;
  readonly work: string;
  readonly home: string;
  readonly steps: StepRecord[] = [];
  private readonly running: Running[] = [];
  private readonly fixtures = new Map<string, Fixture>();
  private index = 0;

  constructor(
    readonly workspace: Workspace,
    readonly state: RunState,
    feature: string,
    journey: string,
  ) {
    this.repo = workspace.root;
    this.folder = join(state.evidence, feature, journey);
    this.work = join(state.dir, "work", feature, journey);
    this.home = join(state.dir, "homes", feature, journey);
    for (const folder of [this.folder, this.work, this.home]) {
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { recursive: true });
    }
  }

  /** A fresh numbered step folder. */
  step(name: string): string {
    this.index += 1;
    const folder = join(
      this.folder,
      `${String(this.index).padStart(2, "0")}-${slug(name)}`,
    );
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  private env(extra: { [name: string]: string } = {}): NodeJS.ProcessEnv {
    return isolatedEnv(this.workspace, this.home, extra);
  }

  command(
    name: string,
    program: string,
    args: string[],
    options: DriveOptions = {},
  ): Promise<CommandResult> {
    return runRecorded(this.step(name), {
      program,
      args,
      cwd: options.cwd ?? this.work,
      env: this.env(options.env),
      timeoutMs: options.timeoutMs,
    });
  }

  /** Runs `ajs <args>` of the repository's `@antelopejs/core`. */
  ajs(
    name: string,
    args: string[],
    options: DriveOptions = {},
  ): Promise<CommandResult> {
    return this.command(
      name,
      process.execPath,
      [ajsEntry(this.repo), ...args],
      options,
    );
  }

  edit(name: string, file: string, content: string): string {
    const folder = this.step(name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
    writeFileSync(join(folder, "edit.txt"), `${file}\n---\n${content}`);
    return folder;
  }

  tree(name: string, root: string): TreeRecord {
    const folder = this.step(name);
    return { folder, lines: recordTree(folder, root) };
  }

  http(
    name: string,
    url: string,
    init: { method?: string; body?: string } = {},
  ): Promise<HttpResult> {
    return httpRecorded(this.step(name), url, init);
  }

  expect(
    folder: string,
    checks: Check[],
    options: { critical?: boolean } = {},
  ): boolean {
    const name = relative(this.folder, folder) || "journey";
    this.steps.push({
      name,
      folder: relative(this.state.evidence, folder),
      checks,
    });
    appendFileSync(
      join(folder, "checks.json"),
      `${JSON.stringify(checks, null, 2)}\n`,
    );
    const passed = checks.every((check) => check.pass);
    if (!passed && options.critical)
      throw new JourneyAbort(`critical step ${name} failed`);
    return passed;
  }

  notVerified(reason: string): never {
    throw new NotVerified(reason);
  }

  service(name: string): ServiceEndpoint {
    const found = this.state.containers.find(
      (container) => container.service === name,
    );
    if (!found)
      throw new Error(
        `No service ${name} in this run; declare it under services in verify.config.ts.`,
      );
    return { name, container: found.name, host: found.host, port: found.port };
  }

  services(): ServiceEndpoint[] {
    return this.state.containers.map((container) =>
      this.service(container.service),
    );
  }

  native(
    name: string,
    service: string,
    args: string[],
  ): Promise<CommandResult> {
    return this.command(name, "docker", [
      "exec",
      this.service(service).container,
      ...args,
    ]);
  }

  fixture(options: { moduleConfig?: JsonObject } = {}): string {
    const config =
      options.moduleConfig ??
      this.workspace.config.moduleConfig?.(this.services()) ??
      {};
    const fixture = writeFixture(this.workspace, this.state, this.work, config);
    this.fixtures.set(fixture.project, fixture);
    this.tree("fixture project", fixture.project);
    return fixture.project;
  }

  /** The log the stub provider wrote, one call per line: the provider's view of what core delivered. */
  stubCalls(project: string): { path: string; args: JsonValue }[] {
    const file = this.fixtures.get(project)?.env.VERIFY_CALL_LOG;
    if (!file) return [];
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => parseJson(line))
      .filter(isObject)
      .map((entry) => ({ path: String(entry.path), args: entry.args ?? null }));
  }

  async dev(
    name: string,
    project: string,
    options: { env?: { [name: string]: string } } = {},
  ): Promise<App> {
    const port = await freePort();
    const fixture = this.fixtures.get(project);
    const env = {
      ...fixture?.env,
      VERIFY_DRIVER_PORT: String(port),
      PORT: String(port),
      ...options.env,
    };
    const folder = this.step(name);
    const handle = startRecorded(folder, {
      program: process.execPath,
      args: [ajsEntry(this.repo), "project", "dev"],
      cwd: project,
      env: this.env(env),
    });
    writeFileSync(join(folder, "port.txt"), `${port}\n`);
    const app: App = { name, pid: handle.pid, folder, project, port };
    this.running.push({ app, handle });
    this.state.processes.push({
      name: `${name} (${project})`,
      pid: handle.pid,
    });
    saveRun(this.state);
    await this.waitReady(app, handle, fixture !== undefined);
    return app;
  }

  private async probe(
    app: App,
    fixture: boolean,
    folder: string,
  ): Promise<Check> {
    const probe = this.workspace.config.template?.probe;
    if (!fixture && probe?.log) {
      const output = readOutput(app.folder);
      return {
        name: `dev output matches ${probe.log}`,
        pass: probe.log.test(`${output.stdout}${output.stderr}`),
        detail: output.stderr.slice(-300),
      };
    }
    const path = fixture ? "/health" : (probe?.path ?? "/");
    const answer = await httpRecorded(
      folder,
      `http://127.0.0.1:${app.port}${path}`,
    );
    const status = fixture ? 200 : (probe?.status ?? 200);
    const body = !fixture && probe?.body ? probe.body : /./s;
    return {
      name: `GET ${path} answers ${status} with ${body}`,
      pass: answer.status === status && body.test(answer.body),
      detail:
        answer.error ??
        `status ${answer.status}, body ${answer.body.slice(0, 300)}`,
    };
  }

  private async waitReady(
    app: App,
    handle: BackgroundHandle,
    fixture: boolean,
  ): Promise<void> {
    const folder = this.step("ready");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let exited = false;
    void handle.exited.then(() => {
      exited = true;
    });
    let check = await this.probe(app, fixture, folder);
    while (!check.pass && !exited && Date.now() < deadline) {
      await sleep(POLL_MS);
      check = await this.probe(app, fixture, folder);
    }
    writeFileSync(
      join(folder, "ready.txt"),
      `${check.pass ? "ready" : exited ? "exited before ready" : "timed out"}\n`,
    );
    this.expect(folder, [check], { critical: true });
  }

  /** Posts a JSON body to a route of the driver module. */
  async driver(
    name: string,
    app: App,
    route: string,
    body: JsonObject,
  ): Promise<CallResult> {
    const result = await httpRecorded(
      this.step(name),
      `http://127.0.0.1:${app.port}${route}`,
      { method: "POST", body: JSON.stringify(body), timeoutMs: 30_000 },
    );
    const json =
      result.json !== undefined && isObject(result.json) ? result.json : {};
    return {
      ...result,
      ok: json.ok === true,
      value: json.ok === true ? json.value : json.error,
    };
  }

  call(name: string, app: App, request: CallRequest): Promise<CallResult> {
    const body: JsonObject = {
      path: request.path,
      args: request.args ?? [],
      chain: request.chain ?? [],
      entry: request.entry ?? ".",
    };
    if (request.interface) body.interface = request.interface;
    return this.driver(name, app, "/call", body);
  }

  async stop(name: string, app: App): Promise<StopResult> {
    const folder = this.step(name);
    writeFileSync(join(folder, "command.txt"), `kill -INT ${app.pid}\n`);
    const running = this.running.find((entry) => entry.app.pid === app.pid);
    try {
      process.kill(app.pid, "SIGINT");
    } catch {
      writeFileSync(join(folder, "note.txt"), "process was already gone\n");
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), STOP_TIMEOUT_MS);
    });
    const outcome = running
      ? await Promise.race([running.handle.exited, timeout])
      : { exitCode: null, signal: null };
    clearTimeout(timer);
    if (!outcome) {
      killGroup(app.pid);
      writeFileSync(
        join(folder, "note.txt"),
        `no exit within ${STOP_TIMEOUT_MS} ms of SIGINT; killed the process group\n`,
      );
    }
    const exit = outcome ?? { exitCode: null, signal: "SIGKILL" };
    writeFileSync(
      join(folder, "exit-code.txt"),
      `${exit.exitCode ?? `signal ${exit.signal}`}\n`,
    );
    this.untrack(app.pid);
    return { ...exit, ...readOutput(app.folder), folder };
  }

  private untrack(pid: number): void {
    const index = this.running.findIndex((entry) => entry.app.pid === pid);
    if (index !== -1) this.running.splice(index, 1);
    this.state.processes = this.state.processes.filter(
      (record) => record.pid !== pid,
    );
    saveRun(this.state);
  }

  async scaffold(
    name: string,
    project: string,
    flags: string[] = ["--pm", "pnpm", "--no-git-init"],
  ): Promise<CommandResult> {
    const set = await this.ajs("config set git", [
      "config",
      "set",
      "git",
      this.state.manifestUrl,
    ]);
    this.expect(
      set.folder,
      [
        {
          name: "git setting points at the offline manifest",
          pass: set.exitCode === 0,
          detail: set.stderr.slice(-300),
        },
      ],
      { critical: true },
    );
    return this.ajs(name, [
      "project",
      "init",
      relative(this.work, project),
      "--template",
      this.state.templateName,
      ...flags,
    ]);
  }

  /** Stops every app the journey left running. */
  async cleanup(): Promise<void> {
    for (const entry of this.running.slice())
      await this.stop(`cleanup ${entry.app.name}`, entry.app);
  }

  /** Records why the journey ended without a verdict on the product. */
  static reasonOf(failure: Error): JourneyEnd {
    if (failure instanceof NotVerified)
      return { error: null, notVerified: failure.message };
    if (failure instanceof JourneyAbort)
      return { error: failure.message, notVerified: null };
    return { error: failure.stack ?? failure.message, notVerified: null };
  }
}
