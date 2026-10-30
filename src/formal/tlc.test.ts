import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = new URL("index.ts", import.meta.url).href;
const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

interface Check {
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
