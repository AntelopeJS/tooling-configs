import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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
import type { VerifyKind } from "./kinds.ts";

const DOCKER = `#!/bin/sh
echo "$@" >> "$DOCKER_LOG"
case "$1" in
  port) echo "6379/tcp -> 127.0.0.1:41234" ;;
  exec) echo pong ;;
  inspect) echo true ;;
esac
exit 0
`;

function serviceRepo(t: TestContext, kind: VerifyKind) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-services-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const skill = `.agents/skills/verify-${kind}`;
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "src/index.ts": "export {};\n",
    [`${skill}/SKILL.md`]: "synced\n",
    [`${skill}/verify.config.ts`]: `export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  services: { cache: { image: "redis:7", port: 6379, ready: ["redis-cli", "ping"] } },
  template: { name: "demo", probe: { log: /ready/ } },
  journeys: {
    seen: {
      title: "the service is reachable",
      entryPoint: "node",
      async run(context) {
        const endpoint = context.service("cache");
        const answer = await context.native("ping", "cache", ["redis-cli", "ping"]);
        context.expect(answer.folder, [
          { name: "the endpoint is published", pass: endpoint.port === 41234, detail: String(endpoint.port) },
          { name: "the native client answers", pass: answer.stdout.includes("pong"), detail: answer.stdout },
        ]);
      },
    },
  },
};
`,
    [`${skill}/features/smoke.md`]: feature([], ["seen"]),
  });
  put(tmp, "bin/docker", DOCKER);
  chmodSync(join(tmp, "bin/docker"), 0o755);
  const env = {
    PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
    DOCKER_LOG: join(tmp, "docker.log"),
  };
  return { root, tmp, env };
}

for (const kind of ["interface", "template"] as const)
  test(`the ${kind} kind starts its services in Docker and exposes them to journeys`, (t) => {
    const { root, tmp, env } = serviceRepo(t, kind);
    const created = verify(root, tmp, ["new", "--kind", kind], env);
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const run = created.stdout.trim().split("\n").at(-1) ?? "";
    assert.match(read(tmp, "docker.log"), /^run -d --name verify-/m);
    const doctor = verify(root, tmp, ["doctor", run, "--kind", kind], env);
    assert.match(
      doctor.stdout,
      /ok {3}service cache: verify-.*on 127\.0\.0\.1:41234/,
    );
    const journey = verify(
      root,
      tmp,
      ["journey", run, "smoke", "--kind", kind],
      env,
    );
    assert.equal(journey.status, 0, journey.stdout + journey.stderr);
    verify(root, tmp, ["clean", run, "--kind", kind], env);
    assert.match(read(tmp, "docker.log"), /^rm -f -v verify-/m);
  });
