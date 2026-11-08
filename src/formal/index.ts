import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { num, object, parseJson, str } from "../garden/json.ts";

const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 =
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const DOCKER_IMAGE = "eclipse-temurin:21-jre";
const JVM_OPTIONS = ["-XX:+UseParallelGC"];
const TLC_FLAGS = ["-deadlock"];
const JVM_ENV = ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"];
const CACHE_ENV = "ANTELOPEJS_FORMAL_CACHE";
const COUNT_MODULE = "AntelopeJSCount";
const COUNT_MARK = "antelopejs-violating";

/** Exit codes of a check: 0 when every rule matches its record, 1 when a rule changed, 2 when TLC could not run. */
export const EXIT = { ok: 0, changed: 1, tool: 2 } as const;

/** Each recorded finding: the invariant a spec breaks today, with the number of states in TLC's shortest counterexample. */
export type Findings = Readonly<Record<string, number>>;

/** Recorded findings with the number of distinct reachable states that break each one. */
export type Violating = Readonly<Record<string, number>>;

/** What {@link checkSpec} model-checks. */
export interface CheckSpecOptions {
  /** The folder holding `<spec>.tla`, the modules it extends and `<config>.cfg`. */
  dir: string;
  /** The module name of the spec, without `.tla`. */
  spec: string;
  /** The configuration file name, without `.cfg`; defaults to `spec`. */
  config?: string;
  /** The invariants of the configuration expected to break. */
  findings: Findings;
  /**
   * The violating-state count of some `findings`: the distinct states inside
   * the model, where every `CONSTRAINT` holds, that break the rule. A finding
   * without one is judged by its length alone, so a new path that breaks it
   * in at least as many states goes unnoticed. A configuration with an
   * `ACTION_CONSTRAINT` cannot be counted.
   */
  violating?: Violating;
}

interface Config {
  constants: string[];
  invariants: string[];
  bounds: string[];
}

interface Module {
  name: string;
  bytes: Buffer;
}

interface TlcRun {
  name: string;
  /** The module TLC checks: the spec, or {@link COUNT_MODULE}. */
  module: string;
  workers: "auto" | "1";
  cfg: string;
}

/** A recorded violating-state count and the run that measures it. */
interface Count {
  expected: number;
  run: TlcRun;
}

interface Finding {
  rule: string;
  states: number;
  run: TlcRun;
  count: Count | undefined;
}

interface Holding {
  rules: string[];
  run: TlcRun;
}

/** Everything one check reads besides the runner's constants and the JVM environment; the cache key covers all of it. */
interface Plan {
  spec: string;
  header: string;
  modules: Module[];
  holds: Holding | undefined;
  findings: Finding[];
}

interface Workspace {
  jar: string;
  work: string;
}

/** A finished check as the result cache keeps it: what it printed and how it exits. */
interface Outcome {
  output: string;
  exit: typeof EXIT.ok | typeof EXIT.changed;
}

function fail(message: string): never {
  console.error(`check: ${message}`);
  process.exit(EXIT.tool);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function cacheDir(): string {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheRoot, "antelopejs-formal");
}

async function ensureJar(): Promise<string> {
  const dir = cacheDir();
  const jar = path.join(dir, `tla2tools-${TLC_VERSION}.jar`);
  if (existsSync(jar) && sha256(readFileSync(jar)) === TLC_SHA256) return jar;
  mkdirSync(dir, { recursive: true });
  console.log(`Downloading ${TLC_URL}`);
  const response = await fetch(TLC_URL);
  if (!response.ok) fail(`download failed: HTTP ${response.status}`);
  const partial = `${jar}.${process.pid}.part`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(readFileSync(partial));
  if (actual !== TLC_SHA256) {
    rmSync(partial, { force: true });
    fail(`tla2tools.jar has SHA-256 ${actual}, expected ${TLC_SHA256}`);
  }
  renameSync(partial, jar);
  return jar;
}

function onPath(program: string): boolean {
  return spawnSync(program, ["-version"], { stdio: "ignore" }).status === 0;
}

let dockerRuns = 0;

function javaInvocation(jar: string, work: string) {
  const java = process.env.JAVA;
  if (java) return { program: java, prefix: [] };
  if (onPath("java")) return { program: "java", prefix: [] };
  dockerRuns += 1;
  const name = process.env.TLC_DOCKER_PREFIX ?? "antelopejs-formal-tlc";
  const jars = path.dirname(jar);
  return {
    program: "docker",
    prefix: [
      "run",
      "--rm",
      "--name",
      `${name}-${process.pid}-${dockerRuns}`,
      "--user",
      `${process.getuid?.()}:${process.getgid?.()}`,
      "-v",
      `${jars}:${jars}:ro`,
      "-v",
      `${work}:${work}`,
      "-w",
      work,
      DOCKER_IMAGE,
      "java",
    ],
  };
}

function readConfig(dir: string, config: string, findings: Findings): Config {
  const text = readFileSync(path.join(dir, `${config}.cfg`), "utf8");
  const constants = Array.from(
    text.matchAll(/^\s+(\w+)\s*=\s*(.+?)\s*$/gm),
    ([, name, value]) => `  ${name} = ${value}`,
  );
  const invariants = Array.from(
    text.matchAll(/^INVARIANT\s+(\w+)/gm),
    ([, name]) => name,
  );
  const bounds = Array.from(
    text.matchAll(/^\s*(?:(?:ACTION_)?CONSTRAINTS?|SYMMETRY|VIEW)\b.*$/gm),
    ([line]) => line.trim(),
  );
  for (const line of bounds)
    if (!/^(?:CONSTRAINT|ACTION_CONSTRAINT|SYMMETRY|VIEW)[ \t]+\w+$/.test(line))
      fail(
        `${config}.cfg: "${line}" is not one keyword and one name; write one CONSTRAINT, ACTION_CONSTRAINT, SYMMETRY or VIEW line per name`,
      );
  for (const name of Object.keys(findings))
    if (!invariants.includes(name))
      fail(`finding ${name} is not an INVARIANT in ${config}.cfg`);
  return { constants, invariants, bounds };
}

function cfgText(config: Config, invariants: string[]): string {
  return [
    "SPECIFICATION Spec",
    "CONSTANTS",
    ...config.constants,
    ...config.bounds,
    ...invariants.map((rule) => `INVARIANT ${rule}`),
    "",
  ].join("\n");
}

function readModules(dir: string): Module[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tla"))
    .sort()
    .map((name) => ({ name, bytes: readFileSync(path.join(dir, name)) }));
}

/**
 * A module whose `AntelopeJSCount_<rule>` invariants always hold and print
 * {@link COUNT_MARK} once for each distinct reachable state that breaks
 * `<rule>`. TLC also checks invariants on successors outside a `CONSTRAINT`,
 * once per transition into them, so those states print nothing.
 */
function countModule(spec: string, rules: string[], config: Config): Module {
  const outside = config.bounds.flatMap((line) => {
    const [kind, name] = line.split(/\s+/);
    return kind === "CONSTRAINT" ? [`~${name} \\/ `] : [];
  });
  const text = [
    `---- MODULE ${COUNT_MODULE} ----`,
    `EXTENDS ${spec}, TLC`,
    ...rules.map(
      (rule) =>
        `${COUNT_MODULE}_${rule} == ${outside.join("")}${rule} \\/ PrintT("${COUNT_MARK}")`,
    ),
    "====",
    "",
  ].join("\n");
  return { name: `${COUNT_MODULE}.tla`, bytes: Buffer.from(text) };
}

function runTlc(workspace: Workspace, run: TlcRun) {
  const { jar, work } = workspace;
  const { name, workers } = run;
  const cfg = path.join(work, `${name}.cfg`);
  writeFileSync(cfg, run.cfg);
  const java = javaInvocation(jar, work);
  const result = spawnSync(
    java.program,
    [
      ...java.prefix,
      ...JVM_OPTIONS,
      "-cp",
      jar,
      "tlc2.TLC",
      "-config",
      cfg,
      "-workers",
      workers,
      ...TLC_FLAGS,
      "-metadir",
      path.join(work, `states-${name}`),
      `${run.module}.tla`,
    ],
    { cwd: work, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) fail(`cannot run ${java.program}: ${result.error.message}`);
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(path.join(work, `${name}.out`), output);
  const violated = /Invariant (\w+) is violated/.exec(output)?.[1];
  const distinct = /([\d,]+) distinct states found, 0 states left/.exec(
    output,
  )?.[1];
  if (!violated && !output.includes("No error has been found"))
    fail(
      `TLC did not finish ${name}; output in ${path.join(work, `${name}.out`)}\n${output.slice(-2000)}`,
    );
  const steps = Array.from(
    output.matchAll(/^State \d+: <(\w+)/gm),
    ([, action]) => action,
  );
  const marks = output.match(new RegExp(`^"${COUNT_MARK}"$`, "gm"));
  return { violated, distinct, steps, violating: marks?.length ?? 0 };
}

function resultKey(plan: Plan): string {
  return sha256(
    JSON.stringify({
      runner: sha256(readFileSync(fileURLToPath(import.meta.url))),
      tlc: TLC_VERSION,
      jar: TLC_SHA256,
      jvm: JVM_OPTIONS,
      jvmEnv: JVM_ENV.map((name) => process.env[name] ?? null),
      flags: TLC_FLAGS,
      ...plan,
      modules: plan.modules.map(({ name, bytes }) => [name, sha256(bytes)]),
    }),
  );
}

function readOutcome(file: string): Outcome | undefined {
  try {
    const entry = object(parseJson(readFileSync(file, "utf8")), file);
    const exit = num(entry, "exit");
    if (exit === EXIT.ok || exit === EXIT.changed)
      return { output: str(entry, "output"), exit };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Stores an outcome for later replays; a cache that cannot be written, read-only or full, only costs the next run a TLC run. */
function writeOutcome(entry: string, outcome: Outcome): void {
  const temp = `${entry}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(temp, JSON.stringify(outcome));
    renameSync(temp, entry);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      return;
    }
  }
}

async function modelCheck(plan: Plan): Promise<Outcome & { work: string }> {
  const { spec, header, modules, holds, findings } = plan;
  const jar = await ensureJar();
  const work = mkdtempSync(path.join(os.tmpdir(), `formal-${spec}-`));
  for (const { name, bytes } of modules)
    writeFileSync(path.join(work, name), bytes);
  const workspace = { jar, work };
  const lines: string[] = [];
  const print = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  print(header);
  let changed = false;
  if (holds) {
    const held = runTlc(workspace, holds.run);
    if (held.violated) {
      changed = true;
      const shortest = runTlc(workspace, {
        ...holds.run,
        name: "holds-shortest",
        workers: "1",
      });
      print(`BROKEN ${shortest.violated}: ${shortest.steps.join(" -> ")}`);
    } else print(`holds  ${holds.rules.join(", ")} (${held.distinct} states)`);
  }
  for (const { rule, states, run, count } of findings) {
    const found = runTlc(workspace, run);
    if (!found.violated) {
      changed = true;
      print(`HOLDS  ${rule}: the finding is gone (${found.distinct} states)`);
      continue;
    }
    const length = found.steps.length;
    const violating =
      count === undefined ? undefined : runTlc(workspace, count.run).violating;
    const same = length === states && violating === count?.expected;
    changed ||= !same;
    const counted =
      count === undefined
        ? ""
        : `, ${violating} violating (recorded ${count.expected})`;
    print(
      `${same ? "finding" : "CHANGED"} ${rule}: ${length} states (recorded ${states})${counted}: ${found.steps.join(" -> ")}`,
    );
  }
  if (!changed) print("Every rule matches the record in SKILL.md.");
  return {
    output: lines.join("\n"),
    exit: changed ? EXIT.changed : EXIT.ok,
    work,
  };
}

/**
 * Model-checks `<dir>/<spec>.tla` with TLC under the constants, bounds and
 * invariants of `<dir>/<config>.cfg`. Every invariant must hold except the
 * `findings`, each of which must still break with a shortest counterexample
 * of exactly its recorded number of states and, when `violating` names it,
 * in exactly that many distinct reachable states, which a further one-worker
 * run counts through a generated `AntelopeJSCount` module. The rules
 * expected to hold are checked on every core; when one breaks, a one-worker
 * rerun picks the rule and the shortest trace that `BROKEN` prints, so both
 * are the same on every run. Prints one line per rule (`holds`, `finding`, `BROKEN`, `CHANGED` or `HOLDS`) and exits the
 * process
 * with {@link EXIT}`.changed` when a rule differs from its record, or
 * {@link EXIT}`.tool` when TLC could not run; returns when everything
 * matches.
 *
 * TLC is the pinned tla2tools.jar 1.7.4, downloaded once into
 * `$XDG_CACHE_HOME/antelopejs-formal` (default `~/.cache/antelopejs-formal`)
 * and checked against its SHA-256. Java comes from `$JAVA`, else `java` on
 * PATH, else the `eclipse-temurin:21-jre` Docker image, run with `--rm` in a
 * container named after `$TLC_DOCKER_PREFIX` (default
 * `antelopejs-formal-tlc`).
 *
 * The printed lines and the exit code of a check TLC finished are kept in
 * `results/<key>.json` under that folder, and a later check with the same key
 * replays them without starting Java, after one line naming the key. The key
 * is a SHA-256 of this runner's own source, the TLC version, the jar's
 * SHA-256, the JVM options and TLC flags with `$JAVA_TOOL_OPTIONS`,
 * `$JDK_JAVA_OPTIONS` and `$_JAVA_OPTIONS`, the spec and configuration
 * names, the printed header, the bytes of every `.tla` file in `dir`, the
 * module, configuration and worker count of each TLC run, `findings` and
 * `violating`. A replay keeps no TLC output
 * folder. `ANTELOPEJS_FORMAL_CACHE=off` neither reads nor writes the cache.
 * Entries are never pruned; each is a few hundred bytes, one per distinct
 * input.
 */
export async function checkSpec(options: CheckSpecOptions): Promise<void> {
  const { dir, spec, config = spec, findings, violating = {} } = options;
  const parsed = readConfig(dir, config, findings);
  for (const rule of Object.keys(violating))
    if (!Object.hasOwn(findings, rule))
      fail(`violating ${rule} is not a finding`);
  if (
    Object.keys(violating).length > 0 &&
    parsed.bounds.some((line) => line.startsWith("ACTION_CONSTRAINT"))
  )
    fail(
      `violating counts states outside an ACTION_CONSTRAINT; ${config}.cfg has one`,
    );
  const holding = parsed.invariants.filter(
    (rule) => !Object.hasOwn(findings, rule),
  );
  const plan: Plan = {
    spec,
    header: `TLC ${TLC_VERSION} on ${spec}.tla (${config}.cfg) with ${parsed.constants.map((line) => line.trim()).join(", ")}`,
    modules: [
      ...readModules(dir),
      countModule(spec, Object.keys(violating), parsed),
    ],
    holds:
      holding.length > 0
        ? {
            rules: holding,
            run: {
              name: "holds",
              module: spec,
              workers: "auto",
              cfg: cfgText(parsed, holding),
            },
          }
        : undefined,
    findings: Object.entries(findings).map(([rule, states]) => ({
      rule,
      states,
      run: {
        name: rule,
        module: spec,
        workers: "1",
        cfg: cfgText(parsed, [rule]),
      },
      count: Object.hasOwn(violating, rule)
        ? {
            expected: violating[rule],
            run: {
              name: `count-${rule}`,
              module: COUNT_MODULE,
              workers: "1",
              cfg: cfgText(parsed, [`${COUNT_MODULE}_${rule}`]),
            },
          }
        : undefined,
    })),
  };
  const key = resultKey(plan);
  const entry =
    process.env[CACHE_ENV] === "off"
      ? undefined
      : path.join(cacheDir(), "results", `${key}.json`);
  const replayed = entry === undefined ? undefined : readOutcome(entry);
  if (replayed) {
    console.log(
      `TLC result ${key.slice(0, 12)} replayed from the cache; ${CACHE_ENV}=off reruns TLC`,
    );
    console.log(replayed.output);
    if (replayed.exit !== EXIT.ok) process.exit(replayed.exit);
    return;
  }
  const outcome = await modelCheck(plan);
  if (entry !== undefined)
    writeOutcome(entry, { output: outcome.output, exit: outcome.exit });
  if (outcome.exit !== EXIT.ok) {
    console.log(`TLC output kept in ${outcome.work}`);
    process.exit(outcome.exit);
  }
  rmSync(outcome.work, { recursive: true, force: true });
}
