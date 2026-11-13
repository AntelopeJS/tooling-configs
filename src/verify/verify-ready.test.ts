import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import { freePort } from "./record.ts";
import {
  evidence,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

const LOCK =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

/** A fake `ajs project dev` that answers 503 for its first READY_AFTER ms (1000 by default), writing the time of each 503 since it listened to PROBE_LOG, then 200. */
const AJS = String.raw`const http = require("node:http");
const { appendFileSync } = require("node:fs");
process.on("SIGINT", () => process.exit(0));
const server = http.createServer((request, response) => {
  if (Date.now() < readyAt) {
    appendFileSync(process.env.PROBE_LOG, String(Date.now() - listenedAt) + "\n");
    response.statusCode = 503;
    response.end("starting");
    return;
  }
  response.end("ok");
});
let readyAt = Infinity;
let listenedAt = 0;
server.listen(Number(process.env.PORT), "127.0.0.1", () => {
  listenedAt = Date.now();
  readyAt = listenedAt + Number(process.env.READY_AFTER ?? 1000);
});
`;

function config(log: string, readyAfter: number): string {
  return `export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    "slow-start": {
      title: "an app that answers 503 before it is ready",
      entryPoint: "ajs project dev",
      async run(context) {
        const app = await context.dev("ajs project dev", context.work, { env: { PROBE_LOG: ${JSON.stringify(log)}, READY_AFTER: "${readyAfter}" } });
        context.expect(app.folder, [{ name: "the app started", pass: true, detail: "" }]);
      },
    },
  },
};
`;
}

function slowApp(t: TestContext, readyAfter: number): number[] {
  const tmp = mkdtempSync(join(tmpdir(), "verify-ready-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const log = join(tmp, "probes.log");
  put(tmp, "probes.log", "");
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "pnpm-lock.yaml": LOCK,
    [`${SKILL}/verify.config.ts`]: config(log, readyAfter),
    [`${SKILL}/features/smoke.md`]: feature([], ["slow-start"]),
  });
  put(
    root,
    "node_modules/@antelopejs/core/package.json",
    '{"name":"@antelopejs/core","bin":{"ajs":"ajs.cjs"}}\n',
  );
  put(root, "node_modules/@antelopejs/core/ajs.cjs", AJS);
  const run = newRun(root, tmp);
  const journey = verify(root, tmp, ["journey", run, "smoke"]);
  verify(root, tmp, ["clean", run]);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  assert.equal(evidence(run, "smoke/feature.json")[0].status, "PASS");
  return read(tmp, "probes.log").split("\n").filter(Boolean).map(Number);
}

test("readiness is probed every few tens of milliseconds while an app starts, so a 1 s start is seen soon after; a fixed 250 ms poll probes it at most four times", (t) => {
  const misses = slowApp(t, 1000);
  assert.ok(misses.length >= 8, misses.join(","));
});

test("after its first 3 s readiness falls back to one probe every 250 ms, so a slow app is not probed 40 times a second for two minutes; a fast poll without a window probes the fourth second dozens of times", (t) => {
  const misses = slowApp(t, 4500);
  const late = misses.filter((ms) => ms >= 3500 && ms < 4500);
  assert.ok(late.length >= 2 && late.length <= 8, misses.join(","));
});

test("a free port for an app comes from below the kernel's ephemeral range and binds; a port the kernel picks comes from the range outgoing connections draw from", async () => {
  const port = await freePort();
  assert.ok(port >= 10_000 && port < 20_000, String(port));
});
