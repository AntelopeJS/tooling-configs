import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

function config(server: string, pidFile: string): string {
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
          command: [process.execPath, ${JSON.stringify(server)}],
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

test("context.dev starts a given command in place of ajs project dev, records its PID and stops it", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-dev-command-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  put(tmp, "server.cjs", SERVER);
  const pidFile = join(tmp, "server.pid");
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    [`${SKILL}/SKILL.md`]: "synced\n",
    [`${SKILL}/verify.config.ts`]: config(join(tmp, "server.cjs"), pidFile),
    [`${SKILL}/features/smoke.md`]: feature([], ["standalone"]),
  });
  const created = verify(root, tmp, ["new", "--kind", "template"]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const run = created.stdout.trim().split("\n").at(-1) ?? "";
  const journey = verify(root, tmp, [
    "journey",
    run,
    "smoke",
    "--kind",
    "template",
  ]);
  assert.equal(journey.status, 0, journey.stdout + journey.stderr);
  assert.match(read(tmp, "server.pid"), /^\d+$/);
});
