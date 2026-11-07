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

const REGISTRY_HELPERS = String.raw`
async function failing(context, name, output) {
  const run = await context.command(name, process.execPath, ["-e", "console.error(process.argv[1]); process.exit(1)", output]);
  context.expect(run.folder, [{ name: "the command succeeds", pass: run.exitCode === 0, detail: run.stderr }]);
}
`;

const REGISTRY_OUTPUT = {
  dns: 'ERROR: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22-alpine": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving',
  rate: "ERROR: failed to solve: node:22-alpine: toomanyrequests: You have reached your unauthenticated pull rate limit.",
  missing:
    "ERROR: failed to solve: docker.io/acme/missing:1.0: failed to resolve source metadata for docker.io/acme/missing:1.0: docker.io/acme/missing:1.0: not found\nError response from daemon: manifest for acme/missing:1.0 not found: manifest unknown: manifest unknown",
  timeout:
    "Error: i/o timeout while reading the cache at 127.0.0.1:6379; the request timeout of 30000 ms elapsed",
  npm: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
  after:
    "npm error network request to https://registry.npmjs.org/left-pad failed, reason: read ECONNRESET",
};

const REGISTRY_JOURNEYS = `
    "pull-dns": {
      title: "the base image pull cannot resolve Docker Hub",
      entryPoint: "docker build",
      async run(context) { await failing(context, "docker build", ${JSON.stringify(REGISTRY_OUTPUT.dns)}); },
    },
    "pull-rate-limited": {
      title: "Docker Hub rate limits the pull",
      entryPoint: "docker build",
      async run(context) { await failing(context, "docker build", ${JSON.stringify(REGISTRY_OUTPUT.rate)}); },
    },
    "pull-missing-tag": {
      title: "the base image tag does not exist",
      entryPoint: "docker build",
      async run(context) { await failing(context, "docker build", ${JSON.stringify(REGISTRY_OUTPUT.missing)}); },
    },
    "product-timeout": {
      title: "the product reports a timeout of its own",
      entryPoint: "node",
      async run(context) { await failing(context, "start", ${JSON.stringify(REGISTRY_OUTPUT.timeout)}); },
    },
    "npm-unreachable": {
      title: "the install cannot reach the npm registry",
      entryPoint: "pnpm install",
      async run(context) { await failing(context, "pnpm install", ${JSON.stringify(REGISTRY_OUTPUT.npm)}); },
    },
    "expected-failure": {
      title: "a command that must fail does, then the product is wrong",
      entryPoint: "pnpm install",
      async run(context) {
        const run = await context.command("expected failure", process.execPath, ["-e", "console.error(process.argv[1]); process.exit(1)", ${JSON.stringify(REGISTRY_OUTPUT.after)}]);
        context.expect(run.folder, [{ name: "the command fails", pass: run.exitCode === 1, detail: run.stderr }]);
        const wrong = await context.command("wrong answer", process.execPath, ["-e", "0"]);
        context.expect(wrong.folder, [{ name: "the product is right", pass: false, detail: "wrong" }]);
      },
    },
    "product-fails-first": {
      title: "the product is wrong, then a later install hits an outage",
      entryPoint: "pnpm install",
      async run(context) {
        const wrong = await context.command("wrong answer", process.execPath, ["-e", "0"]);
        context.expect(wrong.folder, [{ name: "the product is right", pass: false, detail: "wrong" }]);
        await failing(context, "pnpm install", ${JSON.stringify(REGISTRY_OUTPUT.after)});
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
  journeys: {${JOURNEYS}${REGISTRY_JOURNEYS}
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
    [`${SKILL}/features/registry.md`]: feature(
      ["src/**"],
      [
        "pull-dns",
        "pull-rate-limited",
        "pull-missing-tag",
        "product-timeout",
        "npm-unreachable",
        "expected-failure",
        "product-fails-first",
      ],
    ),
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
  const statuses = Object.fromEntries(
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

test("a journey whose service stopped answering ends NOT VERIFIED, and a wrong answer from a live service FAILs", (t) => {
  const { root, tmp, env } = outageRepo(t);
  const { result, statuses } = journeys(root, tmp, env, "services");
  assert.equal(result.status, 1);
  assert.match(
    statuses["service-gone"],
    /^NOT VERIFIED: the service cache no longer passes its readiness command: container verify-demo-cache-\S+ is not running/,
  );
  assert.equal(statuses["service-up"], "FAIL");
});

test("a project killed from outside or holding a taken port is NOT VERIFIED, and a project that exits on its own FAILs", (t) => {
  const { root, tmp, env } = outageRepo(t);
  const { statuses } = journeys(root, tmp, env, "processes");
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
  const { root, tmp, env } = outageRepo(t);
  const { statuses } = journeys(root, tmp, env, "processes");
  assert.equal(statuses.aborts, "FAIL");
  assert.equal(statuses["double-bind"], "FAIL");
  assert.equal(statuses.mention, "FAIL");
  assert.equal(statuses["transient-miss"], "FAIL");
});

test("a base image pull that cannot resolve Docker Hub is NOT VERIFIED and names the step and the cause", (t) => {
  const { root, tmp, env } = outageRepo(t);
  const { statuses } = journeys(root, tmp, env, "registry");
  assert.match(
    statuses["pull-dns"],
    /^NOT VERIFIED: step 01-docker-build could not reach a container or package registry, an outage outside the code under test: .*lookup registry-1\.docker\.io.*server misbehaving/,
  );
});

test("the Docker Hub rate limit is NOT VERIFIED", (t) => {
  const { root, tmp, env } = outageRepo(t);
  const { statuses } = journeys(root, tmp, env, "registry");
  assert.match(
    statuses["pull-rate-limited"],
    /^NOT VERIFIED: step 01-docker-build .*toomanyrequests/,
  );
});

test("an install that cannot resolve registry.npmjs.org is NOT VERIFIED", (t) => {
  const { root, tmp, env } = outageRepo(t);
  const { statuses } = journeys(root, tmp, env, "registry");
  assert.match(
    statuses["npm-unreachable"],
    /^NOT VERIFIED: step 01-pnpm-install .*ENOTFOUND registry\.npmjs\.org/,
  );
});

test("a missing image tag and a product timeout stay FAIL", (t) => {
  const { root, tmp, env } = outageRepo(t);
  const { statuses } = journeys(root, tmp, env, "registry");
  assert.equal(statuses["pull-missing-tag"], "FAIL");
  assert.equal(statuses["product-timeout"], "FAIL");
});

test("a registry error in a step whose checks passed, or after a product failure, does not hide the failure", (t) => {
  const { root, tmp, env } = outageRepo(t);
  const { statuses } = journeys(root, tmp, env, "registry");
  assert.equal(statuses["expected-failure"], "FAIL");
  assert.equal(statuses["product-fails-first"], "FAIL");
});
