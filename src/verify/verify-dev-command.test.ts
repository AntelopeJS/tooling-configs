import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put, read } from "../guardrails/helpers/test-repo.ts";
import {
  feature,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-template";

/** A standalone server, not an `ajs` project: it writes its PID, logs `ready` once it listens on PORT, and exits 0 on SIGINT. */
const SERVER = String.raw`const http = require("node:http");
const { writeFileSync } = require("node:fs");
process.on("SIGINT", () => process.exit(0));
writeFileSync(process.env.PID_FILE, String(process.pid));
http.createServer((request, response) => response.end("ok"))
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
`;

function config(command: string[], pidFile: string): string {
  return `import { readFileSync } from "node:fs";

export default {
  doors: ${PUBLISH_DOORS},
  template: { name: "demo", probe: { log: /ready/ } },
  journeys: {
    standalone: {
      title: "a template that is a standalone application",
      entryPoint: "node server.cjs",
      async run(context) {
        const app = await context.dev("serve", context.work, {
          command: ${JSON.stringify(command)},
          env: { PID_FILE: ${JSON.stringify(pidFile)} },
        });
        const own = Number(readFileSync(${JSON.stringify(pidFile)}, "utf8"));
        const stopped = await context.stop("stop", app);
        context.expect(app.folder, [
          { name: "the recorded PID is the server's own", pass: app.pid === own, detail: app.pid + " vs " + own },
          { name: "the server exits 0 on SIGINT", pass: stopped.exitCode === 0, detail: String(stopped.exitCode) },
        ]);
      },
    },
  },
};
`;
}

function runJourney(t: TestContext, program: string) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-dev-command-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  put(tmp, "server.cjs", SERVER);
  const command = [program, join(tmp, "server.cjs")];
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    [`${SKILL}/SKILL.md`]: "synced\n",
    [`${SKILL}/verify.config.ts`]: config(command, join(tmp, "server.pid")),
    [`${SKILL}/features/smoke.md`]: feature([], ["standalone"]),
  });
  const created = verify(root, tmp, ["new", "--kind", "template"]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const run = created.stdout.trim().split("\n").at(-1) ?? "";
  const args = ["journey", run, "smoke", "--kind", "template"];
  return { tmp, journey: verify(root, tmp, args) };
}

test("context.dev starts a given command in place of ajs project dev, records its PID and stops it", (t) => {
  const { tmp, journey } = runJourney(t, process.execPath);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  assert.match(read(tmp, "server.pid"), /^\d+$/);
});

test("a command that cannot start fails its journey; an unhandled spawn error that crashes the harness fails", (t) => {
  const { journey } = runJourney(t, "no-such-program-ant-1584");
  assert.equal(journey.status, 1, journey.stdout + journey.stderr);
  assert.match(journey.stdout, /FAIL smoke\/standalone/);
  assert.doesNotMatch(journey.stderr, /Unhandled 'error' event/);
});
