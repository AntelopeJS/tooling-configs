import { spawnSync } from "node:child_process";
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
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const TLC_VERSION = "1.7.4";
const TLC_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const TLC_SHA256 =
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const DOCKER_IMAGE = "eclipse-temurin:21-jre";

/** Exit codes of a check: 0 when every rule matches its record, 1 when a rule changed, 2 when TLC could not run. */
export const EXIT = { ok: 0, changed: 1, tool: 2 } as const;

/** Each recorded finding: the invariant a spec breaks today, with the number of states in TLC's shortest counterexample. */
export type Findings = Readonly<Record<string, number>>;

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
}

interface Config {
  constants: string[];
  invariants: string[];
  bounds: string[];
}

interface TlcRun {
  jar: string;
  work: string;
  spec: string;
  name: string;
  config: Config;
  workers: string;
}

function fail(message: string): never {
  console.error(`check: ${message}`);
  process.exit(EXIT.tool);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function ensureJar(): Promise<string> {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  const dir = path.join(cacheRoot, "antelopejs-formal");
  const jar = path.join(dir, `tla2tools-${TLC_VERSION}.jar`);
  if (existsSync(jar) && sha256(jar) === TLC_SHA256) return jar;
  mkdirSync(dir, { recursive: true });
  console.log(`Downloading ${TLC_URL}`);
  const response = await fetch(TLC_URL);
  if (!response.ok) fail(`download failed: HTTP ${response.status}`);
  const partial = `${jar}.${process.pid}.part`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(partial);
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
    text.matchAll(
      /^(?:CONSTRAINT|ACTION_CONSTRAINT|SYMMETRY|VIEW)\s+\w+\s*$/gm,
    ),
    ([line]) => line.trim(),
  );
  for (const name of Object.keys(findings))
    if (!invariants.includes(name))
      fail(`finding ${name} is not an INVARIANT in ${config}.cfg`);
  return { constants, invariants, bounds };
}

function runTlc(run: TlcRun, invariants: string[]) {
  const { jar, work, spec, name, config, workers } = run;
  const cfg = path.join(work, `${name}.cfg`);
  writeFileSync(
    cfg,
    [
      "SPECIFICATION Spec",
      "CONSTANTS",
      ...config.constants,
      ...config.bounds,
      ...invariants.map((rule) => `INVARIANT ${rule}`),
      "",
    ].join("\n"),
  );
  const java = javaInvocation(jar, work);
  const result = spawnSync(
    java.program,
    [
      ...java.prefix,
      "-XX:+UseParallelGC",
      "-cp",
      jar,
      "tlc2.TLC",
      "-config",
      cfg,
      "-workers",
      workers,
      "-deadlock",
      "-metadir",
      path.join(work, `states-${name}`),
      `${spec}.tla`,
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
  return { violated, distinct, steps };
}

/**
 * Model-checks `<dir>/<spec>.tla` with TLC under the constants, bounds and
 * invariants of `<dir>/<config>.cfg`. Every invariant must hold except the
 * `findings`, each of which must still break with a shortest counterexample
 * of exactly its recorded number of states. Prints one line per rule
 * (`holds`, `finding`, `BROKEN`, `CHANGED` or `HOLDS`) and exits the process
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
 */
export async function checkSpec(options: CheckSpecOptions): Promise<void> {
  const { dir, spec, config = spec, findings } = options;
  const parsed = readConfig(dir, config, findings);
  const jar = await ensureJar();
  const work = mkdtempSync(path.join(os.tmpdir(), `formal-${spec}-`));
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".tla")))
    copyFileSync(path.join(dir, file), path.join(work, file));
  const run = { jar, work, spec, config: parsed };
  const holding = parsed.invariants.filter(
    (rule) => !Object.hasOwn(findings, rule),
  );
  console.log(
    `TLC ${TLC_VERSION} on ${spec}.tla (${config}.cfg) with ${parsed.constants.map((line) => line.trim()).join(", ")}`,
  );
  let changed = false;
  if (holding.length > 0) {
    const held = runTlc({ ...run, name: "holds", workers: "auto" }, holding);
    if (held.violated) {
      changed = true;
      console.log(`BROKEN ${held.violated}: ${held.steps.join(" -> ")}`);
    } else
      console.log(`holds  ${holding.join(", ")} (${held.distinct} states)`);
  }
  for (const [rule, expected] of Object.entries(findings)) {
    const found = runTlc({ ...run, name: rule, workers: "1" }, [rule]);
    if (!found.violated) {
      changed = true;
      console.log(
        `HOLDS  ${rule}: the finding is gone (${found.distinct} states)`,
      );
      continue;
    }
    const length = found.steps.length;
    const tag = length === expected ? "finding" : "CHANGED";
    changed ||= length !== expected;
    console.log(
      `${tag} ${rule}: ${length} states (recorded ${expected}): ${found.steps.join(" -> ")}`,
    );
  }
  if (changed) {
    console.log(`TLC output kept in ${work}`);
    process.exit(EXIT.changed);
  }
  rmSync(work, { recursive: true, force: true });
  console.log("Every rule matches the record in SKILL.md.");
}
