import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { resultEntries, scratchCache } from "./helpers/cache.ts";

const RUNNER = new URL("index.ts", import.meta.url).href;
const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

interface Check {
  dir?: string;
  config?: string;
  findings: Record<string, number>;
}

function check(options: Check, env: Record<string, string> = {}) {
  const spec = { dir: FIXTURES, spec: "Counter", ...options };
  const script = `import { checkSpec } from ${JSON.stringify(RUNNER)};\nawait checkSpec(${JSON.stringify(spec)});\n`;
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TLC_DOCKER_PREFIX: "tooling-configs-formal-test",
        ANTELOPEJS_FORMAL_CACHE: "off",
        ...env,
      },
    },
  );
  return {
    status: run.status,
    lines: run.stdout.split("\n").filter((line) => line !== ""),
    stderr: run.stderr,
  };
}

function rules(lines: string[]) {
  return lines.filter(
    (line) =>
      !line.startsWith("Downloading ") &&
      !line.startsWith("TLC output kept in "),
  );
}

test("a spec whose rules match the record exits 0 and prints one line per rule", () => {
  const run = check({ findings: { BelowThree: 4, NotTwo: 3 } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(rules(run.lines), [
    "TLC 1.7.4 on Counter.tla (Counter.cfg) with Limit = 4",
    "holds  Bounded (5 states)",
    "finding BelowThree: 4 states (recorded 4): Initial -> Inc -> Inc -> Inc",
    "finding NotTwo: 3 states (recorded 3): Initial -> Inc -> Inc",
    "Every rule matches the record in SKILL.md.",
  ]);
});

test("a rule that breaks without a record exits 1 with BROKEN", () => {
  const run = check({ findings: { NotTwo: 3 } });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(rules(run.lines), [
    "TLC 1.7.4 on Counter.tla (Counter.cfg) with Limit = 4",
    "BROKEN BelowThree: Initial -> Inc -> Inc -> Inc",
    "finding NotTwo: 3 states (recorded 3): Initial -> Inc -> Inc",
  ]);
  assert.match(run.lines.at(-1) ?? "", /^TLC output kept in /);
});

test("a finding that breaks at another length exits 1 with CHANGED", () => {
  const run = check({ findings: { BelowThree: 4, NotTwo: 5 } });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(
    run.lines.includes(
      "CHANGED NotTwo: 3 states (recorded 5): Initial -> Inc -> Inc",
    ),
    run.lines.join("\n"),
  );
});

test("a recorded finding that now holds exits 1 with HOLDS", () => {
  const run = check({ findings: { Bounded: 2, BelowThree: 4, NotTwo: 3 } });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(rules(run.lines), [
    "TLC 1.7.4 on Counter.tla (Counter.cfg) with Limit = 4",
    "HOLDS  Bounded: the finding is gone (5 states)",
    "finding BelowThree: 4 states (recorded 4): Initial -> Inc -> Inc -> Inc",
    "finding NotTwo: 3 states (recorded 3): Initial -> Inc -> Inc",
  ]);
});

test("another configuration keeps its constraint", () => {
  const run = check({ config: "Counter.small", findings: { NotTwo: 3 } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(rules(run.lines), [
    "TLC 1.7.4 on Counter.tla (Counter.small.cfg) with Limit = 4",
    "holds  Bounded, BelowThree (2 states)",
    "finding NotTwo: 3 states (recorded 3): Initial -> Inc -> Inc",
    "Every rule matches the record in SKILL.md.",
  ]);
});

test("a finding that is not an invariant of the configuration exits 2", () => {
  const run = check({ findings: { Missing: 1 } });
  assert.equal(run.status, 2);
  assert.equal(
    run.stderr,
    "check: finding Missing is not an INVARIANT in Counter.cfg\n",
  );
  assert.deepEqual(run.lines, []);
});

test("a Java that cannot start exits 2", () => {
  const run = check({ findings: {} }, { JAVA: "/nonexistent/java" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^check: cannot run \/nonexistent\/java: /);
});

test("a cached jar with another hash is downloaded again, then reused", (t) => {
  const cache = mkdtempSync(join(tmpdir(), "formal-cache-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  mkdirSync(join(cache, "antelopejs-formal"));
  writeFileSync(
    join(cache, "antelopejs-formal", "tla2tools-1.7.4.jar"),
    "not a jar",
  );
  const first = check(
    { findings: { BelowThree: 4, NotTwo: 3 } },
    { XDG_CACHE_HOME: cache },
  );
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    first.lines[0],
    "Downloading https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  );
  const second = check(
    { findings: { BelowThree: 4, NotTwo: 3 } },
    { XDG_CACHE_HOME: cache },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    second.lines[0],
    "TLC 1.7.4 on Counter.tla (Counter.cfg) with Limit = 4",
  );
});

const MATCHING = { BelowThree: 4, NotTwo: 3 };
const NO_JAVA = { JAVA: "/nonexistent/java" };
const CANNOT_RUN = /^check: cannot run \/nonexistent\/java: /;
const REPLAYED =
  /^TLC result [0-9a-f]{12} replayed from the cache; ANTELOPEJS_FORMAL_CACHE=off reruns TLC$/;

function cacheOn() {
  return { ANTELOPEJS_FORMAL_CACHE: "on", XDG_CACHE_HOME: scratchCache() };
}

function fixturesCopy(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "formal-spec-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

interface Miss {
  input: string;
  edit?: (dir: string) => void;
  findings?: Record<string, number>;
  env?: Record<string, string>;
}

const MISSES: Miss[] = [
  {
    input: "the spec module",
    edit: (dir) => appendFileSync(join(dir, "Counter.tla"), "\n"),
  },
  {
    input: "a module the spec does not extend",
    edit: (dir) =>
      writeFileSync(join(dir, "Unused.tla"), "---- MODULE Unused ----\n====\n"),
  },
  {
    input: "a bound of the configuration",
    edit: (dir) =>
      writeFileSync(
        join(dir, "Counter.cfg"),
        "SPECIFICATION Spec\nCONSTANTS\n  Limit = 4\nCONSTRAINT Small\nINVARIANT Bounded\nINVARIANT BelowThree\nINVARIANT NotTwo\n",
      ),
  },
  {
    input: "a recorded counterexample length",
    findings: { BelowThree: 4, NotTwo: 5 },
  },
  { input: "the JVM options", env: { JAVA_TOOL_OPTIONS: "-Xss4m" } },
];

describe("a cached result", () => {
  const cache = cacheOn();
  let first: ReturnType<typeof check>;
  before(() => {
    first = check({ findings: MATCHING }, cache);
  });
  after(() => rmSync(cache.XDG_CACHE_HOME, { recursive: true, force: true }));

  test("replays from another folder with the same files without starting Java", (t) => {
    const replay = check(
      { dir: fixturesCopy(t), findings: MATCHING },
      { ...cache, ...NO_JAVA },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.lines[0] ?? "", REPLAYED);
    assert.deepEqual(replay.lines.slice(1), rules(first.lines));
  });

  for (const { input, edit, findings = MATCHING, env = {} } of MISSES)
    test(`is not replayed after a change to ${input}`, (t) => {
      const dir = fixturesCopy(t);
      edit?.(dir);
      const run = check({ dir, findings }, { ...cache, ...env, ...NO_JAVA });
      assert.equal(run.status, 2, run.lines.join("\n"));
      assert.match(run.stderr, CANNOT_RUN);
    });

  test("is not replayed with ANTELOPEJS_FORMAL_CACHE=off", () => {
    const run = check(
      { findings: MATCHING },
      { ...cache, ...NO_JAVA, ANTELOPEJS_FORMAL_CACHE: "off" },
    );
    assert.equal(run.status, 2, run.lines.join("\n"));
    assert.match(run.stderr, CANNOT_RUN);
  });
});

test("a replayed CHANGED still exits 1", (t) => {
  const cache = cacheOn();
  t.after(() => rmSync(cache.XDG_CACHE_HOME, { recursive: true, force: true }));
  const findings = { BelowThree: 4, NotTwo: 5 };
  const first = check({ findings }, cache);
  const replay = check({ findings }, { ...cache, ...NO_JAVA });
  assert.equal(first.status, 1, first.stderr);
  assert.equal(replay.status, 1, replay.stderr);
  assert.match(replay.lines[0] ?? "", REPLAYED);
  assert.deepEqual(replay.lines.slice(1), rules(first.lines));
});

test("a corrupt cached result reruns TLC, which replaces it", (t) => {
  const cache = cacheOn();
  t.after(() => rmSync(cache.XDG_CACHE_HOME, { recursive: true, force: true }));
  assert.equal(check({ findings: MATCHING }, cache).status, 0);
  const entries = resultEntries(cache.XDG_CACHE_HOME);
  assert.equal(entries.length, 1);
  for (const entry of entries) writeFileSync(entry, '{"exit":0,"output":"TLC');
  const corrupt = check({ findings: MATCHING }, { ...cache, ...NO_JAVA });
  assert.equal(corrupt.status, 2, corrupt.lines.join("\n"));
  assert.match(corrupt.stderr, CANNOT_RUN);
  assert.equal(check({ findings: MATCHING }, cache).status, 0);
  const replay = check({ findings: MATCHING }, { ...cache, ...NO_JAVA });
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.lines[0] ?? "", REPLAYED);
});

test("a cache that cannot be written still lets a passing check pass; a cache write that throws fails it", (t) => {
  const cache = cacheOn();
  const results = join(cache.XDG_CACHE_HOME, "antelopejs-formal", "results");
  mkdirSync(results, { recursive: true });
  chmodSync(results, 0o555);
  t.after(() => {
    chmodSync(results, 0o755);
    rmSync(cache.XDG_CACHE_HOME, { recursive: true, force: true });
  });
  const run = check({ findings: MATCHING }, cache);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(resultEntries(cache.XDG_CACHE_HOME), []);
});
