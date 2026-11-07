import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
import {
  evidence,
  feature,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";
import {
  REGISTRY_HELPERS,
  REGISTRY_IDS,
  registryJourneys,
} from "./helpers/registry-journeys.ts";

const SKILL = ".agents/skills/verify-module";

const LOCK =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

const DOCKER = `#!/bin/sh
echo "$@" >> "$DOCKER_LOG"
case "$1" in
  port) echo "6379/tcp -> 127.0.0.1:41234" ;;
  exec)
    if [ -e "$DOCKER_DEAD/$2" ]; then echo "container $2 is not running" >&2; exit 1; fi
    if [ -e "$DOCKER_DEAD/miss-once" ]; then rm "$DOCKER_DEAD/miss-once"; echo "one transient miss" >&2; exit 1; fi
    echo pong ;;
  inspect) echo true ;;
esac
exit 0
`;

const AJS = String.raw`const http = require("node:http");
const net = require("node:net");
const port = Number(process.env.PORT);
const mode = process.env.FAKE_MODE;
process.on("SIGINT", () => process.exit(0));
if (mode === "crash-at-start") {
  console.error("Error: the module threw while it constructed");
  process.exit(1);
}
if (mode === "port-taken") net.createServer(() => {}).listen(port, "127.0.0.1");
http
  .createServer((request, response) => {
    if (request.url === "/crash") process.exit(1);
    if (request.url === "/abort") process.kill(process.pid, "SIGABRT");
    if (request.url === "/double-bind") {
      const first = net.createServer(() => {}).listen(0, "127.0.0.1", () => {
        const second = net.createServer(() => {});
        second.on("error", (error) => {
          console.error(String(error));
          response.statusCode = 500;
          response.end("double bind");
        });
        second.listen(first.address().port, "127.0.0.1");
      });
      return;
    }
    if (request.url === "/mention") {
      console.error("the product mentions EADDRINUSE in a log line");
      response.statusCode = 500;
      response.end("mention");
      return;
    }
    response.end("ok");
  })
  .listen(port, "127.0.0.1");
`;

const JOURNEYS = `
    "service-gone": {
      title: "the service stops answering, then a read fails",
      entryPoint: "redis-cli",
      async run(context) {
        writeFileSync(join(DEAD, context.service("cache").container), "");
        const answer = await context.native("ping", "cache", ["redis-cli", "ping"]);
        context.expect(answer.folder, [{ name: "the native client answers", pass: answer.stdout.includes("pong"), detail: answer.stderr }]);
      },
    },
    "service-up": {
      title: "the service answers and the product is wrong",
      entryPoint: "redis-cli",
      async run(context) {
        const answer = await context.native("ping", "cache", ["redis-cli", "ping"]);
        context.expect(answer.folder, [{ name: "the product answers PONG", pass: answer.stdout.includes("PONG"), detail: answer.stdout }]);
      },
    },
    "killed": {
      title: "the project is killed from outside after it is ready",
      entryPoint: "ajs project dev",
      async run(context) {
        const app = await context.dev("ajs project dev", context.work);
        process.kill(app.pid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 300));
        const answer = await context.http("after the kill", "http://127.0.0.1:" + app.port + "/");
        context.expect(answer.folder, [{ name: "the product answers", pass: answer.status === 200, detail: String(answer.error) }]);
      },
    },
    "crashes": {
      title: "the project exits on its own on a request",
      entryPoint: "ajs project dev",
      async run(context) {
        const app = await context.dev("ajs project dev", context.work);
        const answer = await context.http("crash", "http://127.0.0.1:" + app.port + "/crash");
        context.expect(answer.folder, [{ name: "the product answers", pass: answer.status === 200, detail: String(answer.error) }]);
      },
    },
    "aborts": {
      title: "the project aborts itself on a request",
      entryPoint: "ajs project dev",
      async run(context) {
        const app = await context.dev("ajs project dev", context.work);
        const answer = await context.http("abort", "http://127.0.0.1:" + app.port + "/abort");
        context.expect(answer.folder, [{ name: "the product answers", pass: answer.status === 200, detail: String(answer.error) }]);
      },
    },
    "double-bind": {
      title: "the product binds a port it already holds",
      entryPoint: "ajs project dev",
      async run(context) {
        const app = await context.dev("ajs project dev", context.work);
        const answer = await context.http("bind", "http://127.0.0.1:" + app.port + "/double-bind");
        context.expect(answer.folder, [{ name: "the product answers", pass: answer.status === 200, detail: answer.body }]);
      },
    },
    "mention": {
      title: "the product logs the word EADDRINUSE and answers wrong",
      entryPoint: "ajs project dev",
      async run(context) {
        const app = await context.dev("ajs project dev", context.work);
        const answer = await context.http("mention", "http://127.0.0.1:" + app.port + "/mention");
        context.expect(answer.folder, [{ name: "the product answers", pass: answer.status === 200, detail: answer.body }]);
      },
    },
    "transient-miss": {
      title: "one readiness probe misses after a real failing check",
      entryPoint: "redis-cli",
      async run(context) {
        writeFileSync(join(DEAD, "miss-once"), "");
        const read = await context.command("read", process.execPath, ["-e", "0"]);
        context.expect(read.folder, [{ name: "the product is right", pass: false, detail: "wrong" }]);
      },
    },
    "port-taken": {
      title: "another process holds the project's port",
      entryPoint: "ajs project dev",
      async run(context) {
        await context.dev("ajs project dev", context.work, { env: { FAKE_MODE: "port-taken" } });
      },
    },
    "crash-at-start": {
      title: "the project exits on its own before it is ready",
      entryPoint: "ajs project dev",
      async run(context) {
        await context.dev("ajs project dev", context.work, { env: { FAKE_MODE: "crash-at-start" } });
      },
    },`;

function config(dead: string): string {
  return `import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const DEAD = ${JSON.stringify(dead)};
${REGISTRY_HELPERS}
export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  services: { cache: { image: "redis:7", port: 6379, ready: ["redis-cli", "ping"] } },
  journeys: {${JOURNEYS}${registryJourneys()}
  },
};
`;
}

/** A module repository whose fake Docker reports a container gone once its name is a file in `dead`, and whose fake core serves PORT. */
function outageRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-outages-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dead = join(tmp, "dead");
  mkdirSync(dead);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "pnpm-lock.yaml": LOCK,
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(dead),
    [`${SKILL}/features/smoke.md`]: feature([], ["service-up"]),
    [`${SKILL}/features/services.md`]: feature(
      ["src/**"],
      ["service-up", "service-gone"],
    ),
    [`${SKILL}/features/registry.md`]: feature(["src/**"], REGISTRY_IDS),
    [`${SKILL}/features/processes.md`]: feature(
      ["src/**"],
      [
        "killed",
        "crashes",
        "port-taken",
        "crash-at-start",
        "aborts",
        "double-bind",
        "mention",
        "transient-miss",
      ],
    ),
  });
  put(
    root,
    "node_modules/@antelopejs/core/package.json",
    '{"name":"@antelopejs/core","bin":{"ajs":"ajs.cjs"}}\n',
  );
  put(root, "node_modules/@antelopejs/core/ajs.cjs", AJS);
  put(tmp, "bin/docker", DOCKER);
  chmodSync(join(tmp, "bin/docker"), 0o755);
  const env = {
    PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
    DOCKER_LOG: join(tmp, "docker.log"),
    DOCKER_DEAD: dead,
  };
  return { root, tmp, env };
}

const finished = new Map<string, ReturnType<typeof journeys>>();

/** Runs the feature once for the whole file, so each test reads its journeys from one run. */
function outageRun(t: TestContext, name: string) {
  const known = finished.get(name);
  if (known !== undefined) return known;
  const { root, tmp, env } = outageRepo(t);
  const run = journeys(root, tmp, env, name);
  finished.set(name, run);
  return run;
}

function journeys(
  root: string,
  tmp: string,
  env: Record<string, string>,
  name: string,
) {
  const created = verify(root, tmp, ["new"], env);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const run = created.stdout.trim().split("\n").at(-1) ?? "";
  const result = verify(root, tmp, ["journey", run, name], env);
  verify(root, tmp, ["clean", run], env);
  const statuses: Record<string, string> = Object.fromEntries(
    evidence(run, `${name}/feature.json`).map(
      (entry: { journey: string; status: string; notVerified: string }) => [
        entry.journey,
        entry.notVerified === null
          ? entry.status
          : `${entry.status}: ${entry.notVerified}`,
      ],
    ),
  );
  return { result, statuses };
}

function assertFail(t: TestContext, ids: string[]) {
  const { statuses } = outageRun(t, "registry");
  for (const id of ids) assert.equal(statuses[id], "FAIL", id);
}

function assertOutage(t: TestContext, cases: [string, string, RegExp][]) {
  const { statuses } = outageRun(t, "registry");
  for (const [id, step, cause] of cases)
    assert.match(
      statuses[id],
      new RegExp(
        `^NOT VERIFIED: step 01-${step} could not reach a container or package registry, an outage outside the code under test: ${cause.source}`,
      ),
      id,
    );
}

test("a journey whose service stopped answering ends NOT VERIFIED, and a wrong answer from a live service FAILs", (t) => {
  const { result, statuses } = outageRun(t, "services");
  assert.equal(result.status, 1);
  assert.match(
    statuses["service-gone"],
    /^NOT VERIFIED: the service cache no longer passes its readiness command: container verify-demo-cache-\S+ is not running/,
  );
  assert.equal(statuses["service-up"], "FAIL");
});

test("a project killed from outside or holding a taken port is NOT VERIFIED, and a project that exits on its own FAILs", (t) => {
  const { statuses } = outageRun(t, "processes");
  assert.match(
    statuses.killed,
    /^NOT VERIFIED: ajs project dev \(pid \d+\) was killed by SIGKILL, a signal the harness did not send$/,
  );
  assert.match(
    statuses["port-taken"],
    /^NOT VERIFIED: ajs project dev \(pid \d+\) could not bind port \d+, which another process holds: .*EADDRINUSE/,
  );
  assert.equal(statuses.crashes, "FAIL");
  assert.equal(statuses["crash-at-start"], "FAIL");
});

test("a product crash by SIGABRT, a product double bind and a logged EADDRINUSE stay FAIL, and one transient readiness miss still counts the catch", (t) => {
  const { statuses } = outageRun(t, "processes");
  assert.equal(statuses.aborts, "FAIL");
  assert.equal(statuses["double-bind"], "FAIL");
  assert.equal(statuses.mention, "FAIL");
  assert.equal(statuses["transient-miss"], "FAIL");
});

test("a failed pull or install that ends on a network cause at a known registry host is NOT VERIFIED and names the step and the cause (catches a classifier that needs more than the final error line)", (t) => {
  assertOutage(t, [
    [
      "docker-dns",
      "docker-build",
      /.*lookup registry-1\.docker\.io.*server misbehaving/,
    ],
    [
      "docker-deadline",
      "docker-build",
      /.*registry-1\.docker\.io.*context deadline exceeded/,
    ],
    [
      "ecr-no-such-host",
      "docker-build",
      /.*dkr\.ecr\.eu-west-1\.amazonaws\.com.*no such host/,
    ],
    [
      "npm-enotfound",
      "pnpm-install",
      /npm error network request .*ENOTFOUND registry\.npmjs\.org/,
    ],
    [
      "pnpm-socket-hang-up",
      "pnpm-install",
      /ERR_PNPM_META_FETCH_FAIL .*socket hang up/,
    ],
  ]);
});

test("a 5xx answer from a registry is NOT VERIFIED (catches dropping the E5xx and ERR_PNPM_FETCH_5xx forms)", (t) => {
  assertOutage(t, [
    ["npm-503", "pnpm-install", /npm error code E503/],
    ["pnpm-502", "pnpm-install", /ERR_PNPM_FETCH_502 /],
  ]);
});

test("a 5xx line without a host, from pnpm or the Docker client, is NOT VERIFIED (catches requiring a host on status lines)", (t) => {
  assertOutage(t, [
    ["pnpm-503-no-host", "pnpm-install", /ERR_PNPM_FETCH_503 /],
    [
      "docker-5xx-no-host",
      "docker-pull",
      /docker: error pulling .*received unexpected HTTP status: 503/,
    ],
  ]);
});

test("the Docker Hub pull rate limit is NOT VERIFIED (catches dropping toomanyrequests and pull rate limit inside a Docker error)", (t) => {
  assertOutage(t, [
    ["docker-toomanyrequests", "docker-build", /.*toomanyrequests/],
    ["docker-pull-rate-limit", "docker-pull", /docker: .*pull rate limit/],
  ]);
});

test("a coloured error line is NOT VERIFIED, and so is a final outage after an earlier product error (catches matching without stripping ANSI, and letting the first error line decide)", (t) => {
  assertOutage(t, [
    ["ansi-colored", "pnpm-install", /npm error network request .*ENOTFOUND/],
    [
      "product-error-before-outage",
      "pnpm-install",
      /npm error network request .*ENOTFOUND/,
    ],
  ]);
});

test("a recovered retry warning, a test named after a registry outage, a product rate limiter and a product log line stay FAIL (catches deciding on any line that mentions a registry)", (t) => {
  assertFail(t, [
    "recovered-retry-then-ts-error",
    "mirror-test-name",
    "product-rate-limiter",
    "pino-url-field",
    "scaffold-checks-output",
  ]);
});

test("a typo host, a private registry, a source file named registry.service.ts and a pnpm GET host outside the list stay FAIL (catches a generic registry.<domain> host pattern)", (t) => {
  assertFail(t, [
    "typo-host",
    "private-registry",
    "source-file-name",
    "pnpm-get-host-unknown",
  ]);
});

test("a Docker Hub host on an npm line, a missing image tag and a product timeout stay FAIL (catches one host list for all tools, and matching a 404 or a bare timeout)", (t) => {
  assertFail(t, ["docker-host-on-npm-line", "missing-tag", "product-timeout"]);
});

test("a product error printed after the outage, or on the other stream, stays FAIL (catches any matching line deciding instead of the last error line)", (t) => {
  assertFail(t, ["product-error-after-outage", "streams-disagree"]);
});

test("a registry error in a step whose command exits 0 but whose check fails stays FAIL (catches deciding without the exit code)", (t) => {
  assertFail(t, ["exit-zero"]);
});

test("a registry error in a step whose checks passed, or after a product failure, does not hide the failure (catches reading any step instead of the first failing one)", (t) => {
  assertFail(t, ["expected-failure", "product-fails-first"]);
});

test("a line of millions of labels is skipped and the journey stays FAIL (catches matching lines of any length, which overflows the regex stack)", (t) => {
  assertFail(t, ["oversized-line"]);
});
