import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { CHECKS_SKIP_ENV } from "../guardrails/checks.ts";
import {
  commit,
  PACKAGE_ROOT,
  put,
  read,
} from "../guardrails/helpers/test-repo.ts";
import { DEV_STACK_VARIABLES } from "../lease/env.ts";
import {
  externalEnv,
  lease as leaseCommand,
  statusRows,
  type Outcome,
} from "../lease/helpers/cli.ts";
import {
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

const LEASED = {
  DMS_BACK_PORT: "41001",
  DMS_FRONT_PORT: "41002",
  DMS_INSPECT_PORT: "41003",
  DMS_SMTP_PORT: "41004",
  DMS_CLIENT_BASE_URL: "http://localhost:41002",
  MONGO_URL: "mongodb://127.0.0.1:41005",
  MONGO_DATABASE: "dms_lease",
  DMS_BACK_LOG: "/lease/logs/back.log",
  DMS_FRONT_LOG: "/lease/logs/front.log",
  PORT: "41001",
};

const PRINT_ENV = "process.stdout.write(JSON.stringify(process.env))";

function scratchDir(t: TestContext, prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function envRepo(
  t: TestContext,
  extra = "",
  files: Record<string, string> = {},
) {
  const tmp = scratchDir(t, "verify-lease-env-");
  const root = verifyRepo(t, {
    ...files,
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    [`${SKILL}/verify.config.ts`]: `export default {
  doors: ${PUBLISH_DOORS},
  ${extra}
  journeys: {
    seen: {
      title: "prints its environment",
      entryPoint: "node",
      async run(context) {
        const result = await context.command("env", process.execPath, ["-e", ${JSON.stringify(PRINT_ENV)}]);
        context.expect(result.folder, [{ name: "ran", pass: result.exitCode === 0, detail: "" }]);
      },
    },
  },
};
`,
    [`${SKILL}/features/smoke.md`]: feature([], ["seen"]),
  });
  return { root, tmp };
}

function seen(
  root: string,
  tmp: string,
  env: Record<string, string>,
): Record<string, string | undefined> {
  const run = newRun(root, tmp, env);
  const journey = verify(root, tmp, ["journey", run, "smoke"], env);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  return JSON.parse(read(run, "evidence/smoke/seen/01-env/stdout.txt"));
}

/** What a lease exports to a command, with the operator's own tmp recorded as `operator`. */
function leased(lease: string, operator: string) {
  return {
    ...LEASED,
    ANTELOPEJS_LEASE: "lease",
    ANTELOPEJS_LEASE_DIR: lease,
    ANTELOPEJS_LEASE_PARENT_TMPDIR: operator,
    TMPDIR: join(lease, "tmp"),
  };
}

test("a journey does not see the dev-stack variables a lease exported to verify (fails when the journey inherits them)", (t) => {
  const { root, tmp } = envRepo(t);
  const lease = scratchDir(t, "verify-lease-dir-");
  const environment = seen(root, tmp, leased(lease, tmp));
  for (const name of Object.keys(LEASED))
    assert.equal(environment[name], undefined, name);
});

test("every variable the lease exports, but the TMPDIR it restores, is covered by the journey filter (fails when DEV_STACK_VARIABLES gains a name the filter misses)", (t) => {
  const { root, tmp } = envRepo(t);
  const lease = scratchDir(t, "verify-lease-dir-");
  const exported = Object.fromEntries(
    DEV_STACK_VARIABLES.map((name) => [name, `leased-${name}`]),
  );
  const environment = seen(root, tmp, {
    ...leased(lease, tmp),
    ...exported,
    TMPDIR: join(lease, "tmp"),
  });
  for (const name of DEV_STACK_VARIABLES.filter((name) => name !== "TMPDIR"))
    assert.equal(environment[name], undefined, name);
});

test("a variable set in the config env still reaches the journey under a lease (fails when the filter also drops the repo's own values)", (t) => {
  const { root, tmp } = envRepo(
    t,
    `env: { MONGO_URL: "mongodb://configured", DMS_CLIENT_BASE_URL: "http://configured" },`,
  );
  const lease = scratchDir(t, "verify-lease-dir-");
  const environment = seen(root, tmp, leased(lease, tmp));
  assert.equal(environment.MONGO_URL, "mongodb://configured");
  assert.equal(environment.DMS_CLIENT_BASE_URL, "http://configured");
  assert.equal(environment.DMS_BACK_PORT, undefined);
});

test("outside a lease the operator's own PORT, MONGO_URL, MONGO_DATABASE and DMS_BACK_PORT reach the journey (fails when the dev-stack filter runs without a lease)", (t) => {
  const { root, tmp } = envRepo(t);
  const environment = seen(root, tmp, {
    PORT: "5010",
    MONGO_URL: "mongodb://operator",
    MONGO_DATABASE: "operator_db",
    DMS_BACK_PORT: "5011",
  });
  assert.deepEqual(
    [
      environment.PORT,
      environment.MONGO_URL,
      environment.MONGO_DATABASE,
      environment.DMS_BACK_PORT,
    ],
    ["5010", "mongodb://operator", "operator_db", "5011"],
  );
  assert.equal(environment.TMPDIR, tmp);
});

test("a journey under a lease sees the operator's original TMPDIR, not the lease's (fails when TMPDIR is dropped or left as the lease's tmp)", (t) => {
  const { root, tmp } = envRepo(t);
  const operator = scratchDir(t, "verify-operator-tmp-");
  const lease = scratchDir(t, "verify-lease-dir-");
  const environment = seen(root, tmp, leased(lease, operator));
  assert.equal(environment.TMPDIR, operator);
});

test("a journey under a lease whose caller had no TMPDIR gets none, and its run lands in the platform default (fails when the lease's tmp or a made-up TMPDIR is handed over)", (t) => {
  const { root, tmp } = envRepo(t);
  const lease = scratchDir(t, "verify-lease-dir-");
  const env = { ...leased(lease, ""), TMP: tmp };
  const run = newRun(root, tmp, env);
  assert.equal(run.startsWith(join(tmp, "antelopejs-verify")), true, run);
  const journey = verify(root, tmp, ["journey", run, "smoke"], env);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  const environment = JSON.parse(
    read(run, "evidence/smoke/seen/01-env/stdout.txt"),
  );
  assert.equal(environment.TMPDIR, undefined);
});

test("the lease's tmp is dropped whatever its spelling: a trailing slash or a symlinked lease directory (fails when the lease is told apart by comparing TMPDIR with the lease's tmp path)", (t) => {
  const { root, tmp } = envRepo(t);
  const operator = scratchDir(t, "verify-operator-tmp-");
  const lease = scratchDir(t, "verify-lease-dir-");
  mkdirSync(join(lease, "tmp"));
  const link = join(scratchDir(t, "verify-lease-link-"), "link");
  symlinkSync(lease, link);
  for (const leaseTmp of [`${join(lease, "tmp")}/`, join(link, "tmp")]) {
    const environment = seen(root, tmp, {
      ...leased(lease, operator),
      TMPDIR: leaseTmp,
    });
    assert.equal(environment.TMPDIR, operator, leaseTmp);
  }
});

const SETUP = `setup: [[process.execPath, "-e", ${JSON.stringify(PRINT_ENV)}]],`;

function setupEnvironment(run: string): Record<string, string | undefined> {
  return JSON.parse(
    read(run, join("evidence/setup", `01-${process.execPath}`, "stdout.txt")),
  );
}

test("setup under a lease does not see the dev-stack variables and gets the operator's TMPDIR (fails when setup inherits process.env whole)", (t) => {
  const { root, tmp } = envRepo(t, SETUP);
  const lease = scratchDir(t, "verify-lease-dir-");
  const environment = setupEnvironment(newRun(root, tmp, leased(lease, tmp)));
  for (const name of Object.keys(LEASED))
    assert.equal(environment[name], undefined, name);
  assert.equal(environment.TMPDIR, tmp);
});

test("a variable set in the config env still reaches setup under a lease (fails when the lease filter runs after the config env, which drops it)", (t) => {
  const { root, tmp } = envRepo(
    t,
    `${SETUP}\n  env: { MONGO_URL: "mongodb://configured" },`,
  );
  const lease = scratchDir(t, "verify-lease-dir-");
  const environment = setupEnvironment(newRun(root, tmp, leased(lease, tmp)));
  assert.equal(environment.MONGO_URL, "mongodb://configured");
  assert.equal(environment.DMS_BACK_PORT, undefined);
});

test("outside a lease, setup gets the operator's own PORT and MONGO_URL (fails when setup is filtered without a lease)", (t) => {
  const { root, tmp } = envRepo(t, SETUP);
  const environment = setupEnvironment(
    newRun(root, tmp, { PORT: "5010", MONGO_URL: "mongodb://operator" }),
  );
  assert.equal(environment.PORT, "5010");
  assert.equal(environment.MONGO_URL, "mongodb://operator");
});

const FORMAL = `formal: [{
    name: "probe",
    covers: [],
    files: ["check.txt"],
    command: [process.execPath, "-e", ${JSON.stringify(PRINT_ENV)}],
    violation: null,
  }],`;

function formalEnvironments(
  root: string,
  tmp: string,
  env: Record<string, string>,
): Record<string, string | undefined>[] {
  put(root, "check.txt", "changed\n");
  commit(root);
  const run = newRun(root, tmp, env);
  const formal = verify(root, tmp, ["formal", run], env);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  return ["stdout.txt", "base-stdout.txt"].map((file) =>
    JSON.parse(read(run, join("evidence/formal/probe", file))),
  );
}

test("a formal check, on the head and on the base, sees neither the dev-stack variables nor the lease's tmp under a lease (fails when runCommand spawns with the whole process environment)", (t) => {
  const { root, tmp } = envRepo(t, FORMAL, { "check.txt": "base\n" });
  const operator = scratchDir(t, "verify-operator-tmp-");
  const lease = scratchDir(t, "verify-lease-dir-");
  mkdirSync(join(lease, "tmp"));
  const environments = formalEnvironments(root, tmp, leased(lease, operator));
  assert.equal(environments.length, 2);
  for (const environment of environments) {
    for (const name of Object.keys(LEASED))
      assert.equal(environment[name], undefined, name);
    assert.equal(environment.TMPDIR, operator);
  }
});

test("a lease that recorded no parent TMPDIR keeps TMPDIR for the run and the journey, as before the lease was told apart (fails when a missing key is read as an operator with no TMPDIR)", (t) => {
  const { root, tmp } = envRepo(t);
  const lease = scratchDir(t, "verify-lease-dir-");
  const env = {
    ...leased(lease, tmp),
    ANTELOPEJS_LEASE_PARENT_TMPDIR: undefined,
    TMP: tmp,
  };
  const run = newRun(root, tmp, env);
  assert.equal(
    run.startsWith(join(lease, "tmp", "antelopejs-verify")),
    true,
    run,
  );
  const journey = verify(root, tmp, ["journey", run, "smoke"], env);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  const environment = JSON.parse(
    read(run, "evidence/smoke/seen/01-env/stdout.txt"),
  );
  assert.equal(environment.TMPDIR, join(lease, "tmp"));
});

test("an operator's own ANTELOPEJS_LEASE without a lease directory drops nothing (fails when the marker alone declares a lease)", (t) => {
  const { root, tmp } = envRepo(t);
  const environment = seen(root, tmp, {
    ANTELOPEJS_LEASE: "mine",
    ANTELOPEJS_LEASE_DIR: "",
    ANTELOPEJS_LEASE_PARENT_TMPDIR: "",
    PORT: "5010",
    MONGO_URL: "mongodb://operator",
  });
  assert.deepEqual(
    [environment.PORT, environment.MONGO_URL, environment.TMPDIR],
    ["5010", "mongodb://operator", tmp],
  );
});

test("a TMPDIR set for the command under a lease is honoured by the run, the journey and setup (fails when TMPDIR is replaced whatever its value)", (t) => {
  const { root, tmp } = envRepo(t, SETUP);
  const operator = scratchDir(t, "verify-operator-tmp-");
  const lease = scratchDir(t, "verify-lease-dir-");
  const explicit = scratchDir(t, "verify-explicit-tmp-");
  const env = { ...leased(lease, operator), TMPDIR: explicit };
  const run = newRun(root, tmp, env);
  assert.equal(run.startsWith(join(explicit, "antelopejs-verify")), true, run);
  assert.equal(setupEnvironment(run).TMPDIR, explicit);
  const journey = verify(root, tmp, ["journey", run, "smoke"], env);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  const environment = JSON.parse(
    read(run, "evidence/smoke/seen/01-env/stdout.txt"),
  );
  assert.equal(environment.TMPDIR, explicit);
});

test("setup under a lease sees no ANTELOPEJS_LEASE variable (fails when only the journey filters the lease's own variables)", (t) => {
  const { root, tmp } = envRepo(t, SETUP);
  const lease = scratchDir(t, "verify-lease-dir-");
  const environment = setupEnvironment(newRun(root, tmp, leased(lease, tmp)));
  for (const name of [
    "ANTELOPEJS_LEASE",
    "ANTELOPEJS_LEASE_DIR",
    "ANTELOPEJS_LEASE_PARENT_TMPDIR",
  ])
    assert.equal(environment[name], undefined, name);
});

test("a run created under the real lease run lives in the operator's tmp and survives lease down (fails when runs are written under the lease's own TMPDIR)", async (t) => {
  const { root } = envRepo(t);
  const operator = scratchDir(t, "verify-operator-tmp-");
  const home = scratchDir(t, "verify-lease-home-");
  const {
    GITHUB_BASE_REF: _base,
    [CHECKS_SKIP_ENV]: _skip,
    ANTELOPEJS_LEASE: _lease,
    ANTELOPEJS_LEASE_DIR: _dir,
    ANTELOPEJS_LEASE_PARENT_TMPDIR: _parent,
    ...inherited
  } = externalEnv(home);
  const env = { ...inherited, CI: "1", TMPDIR: operator };
  let run = "";
  let leaseDir = "";
  let down: Outcome | undefined;
  try {
    const created = await leaseCommand(
      [
        "run",
        "--",
        process.execPath,
        join(PACKAGE_ROOT, "src/bin/verify.ts"),
        "new",
      ],
      root,
      env,
    );
    assert.equal(created.code, 0, created.stderr);
    run = created.stdout.trim();
    const [row] = await statusRows(root, env);
    assert.ok(row);
    leaseDir = row.dir;
    assert.equal(
      run.startsWith(join(operator, "antelopejs-verify")),
      true,
      run,
    );
    assert.equal(run.startsWith(leaseDir), false, run);
  } finally {
    down = await leaseCommand(["down", "--force"], root, env);
  }
  assert.equal(down.code, 0, down.stderr);
  assert.equal(existsSync(leaseDir), false);
  assert.equal(existsSync(join(run, "run.json")), true);
});

test("a formal check's behaviour probe under a lease sees no dev-stack variable and runs in a worktree under the operator's tmp (fails when the probe spawns with the whole process environment or under tmpdir())", (t) => {
  const operator = scratchDir(t, "verify-operator-tmp-");
  const lease = scratchDir(t, "verify-lease-dir-");
  mkdirSync(join(lease, "tmp"));
  const seenBy = join(operator, "probe.json");
  const probe = `formal: [{
    name: "probe",
    covers: [],
    files: ["check.txt"],
    command: [process.execPath, "-e", "0"],
    violation: null,
    behaviour: {
      kind: "probe",
      command: [process.execPath, "-e", ${JSON.stringify(
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ env: process.env, dir: process.argv[2] }))",
      )}, ${JSON.stringify(seenBy)}],
    },
  }],`;
  const { root, tmp } = envRepo(t, probe, { "check.txt": "base\n" });
  put(root, "check.txt", "changed\n");
  commit(root);
  const env0 = leased(lease, operator);
  const run = newRun(root, tmp, env0);
  const formal = verify(root, tmp, ["formal", run], env0);
  assert.equal(formal.status, 0, formal.stdout + formal.stderr);
  const { env, dir } = JSON.parse(read(operator, "probe.json"));
  for (const name of Object.keys(LEASED))
    assert.equal(env[name], undefined, name);
  assert.equal(env.TMPDIR, operator);
  assert.ok(String(dir).startsWith(operator), dir);
});
