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

function config(dead: string, extra = ""): string {
  return `import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const DEAD = ${JSON.stringify(dead)};
export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  services: { cache: { image: "redis:7", port: 6379, ready: ["redis-cli", "ping"] } },
  journeys: {${JOURNEYS}${extra}
  },
};
`;
}

/** A module repository whose fake Docker reports a container gone once its name is a file in `dead`, and whose fake core serves PORT. */
function outageRepo(
  t: TestContext,
  extra = "",
  files: Record<string, string> = {},
) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-outages-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dead = join(tmp, "dead");
  mkdirSync(dead);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "pnpm-lock.yaml": LOCK,
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(dead, extra),
    [`${SKILL}/features/smoke.md`]: feature([], ["service-up"]),
    [`${SKILL}/features/services.md`]: feature(
      ["src/**"],
      ["service-up", "service-gone"],
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
    ...files,
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

const NOOP_PATCH = `--- /dev/null
+++ b/src/outage.txt
@@ -0,0 +1 @@
+the patched run loses its service
`;

const BREAK_PATCH = `--- a/src/store.ts
+++ b/src/store.ts
@@ -1 +1 @@
-export const store = 1;
+export const store = 2;
`;

const SEEDED_JOURNEYS = `
    "reads": {
      title: "reads the store while the service answers",
      entryPoint: "redis-cli",
      async run(context) {
        if (existsSync(join(context.repo, "src/outage.txt"))) writeFileSync(join(DEAD, context.service("cache").container), "");
        const answer = await context.native("ping", "cache", ["redis-cli", "ping"]);
        const store = await context.command("read store", process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync('src/store.ts', 'utf8'))"], { cwd: context.repo });
        context.expect(store.folder, [
          { name: "the native client answers", pass: answer.stdout.includes("pong"), detail: answer.stderr },
          { name: "the store holds 1", pass: store.stdout.includes("store = 1"), detail: store.stdout },
        ]);
      },
    },`;

test("seeded counts a break caught only by a product check, and reports a run whose service went away as NOT VERIFIED", (t) => {
  const { root, tmp, env } = outageRepo(t, SEEDED_JOURNEYS, {
    [`${SKILL}/features/outage.md`]: feature(["src/**"], ["reads"]),
    [`${SKILL}/features/store.md`]: feature(["src/**"], ["reads"]),
    [`${SKILL}/seeded-breaks/outage.patch`]: NOOP_PATCH,
    [`${SKILL}/seeded-breaks/store.patch`]: BREAK_PATCH,
  });
  const result = verify(root, tmp, ["seeded", "outage", "store"], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stdout,
    /^NOT VERIFIED outage by no journey \(evidence /m,
    result.stdout,
  );
  assert.match(
    result.stdout,
    /^ {4}not verified with the patch, not counted: reads \(the service cache no longer passes its readiness command: /m,
  );
  assert.match(result.stdout, /^CAUGHT store by reads \(evidence /m);
});
