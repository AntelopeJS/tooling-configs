import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHECKS,
  feature,
  newRun,
  PUBLISH_DOORS,
  verify,
  verifyRepo,
} from "./helpers/verify-repo.ts";
import {
  FIRST,
  LATER,
  PACKAGE,
  startRegistry,
} from "./helpers/fake-registry.ts";

const SKILL = ".agents/skills/verify-module";

function config(registry: string): string {
  const pack = (name: string, version: string) =>
    `context.command(${JSON.stringify(name)}, "npm", ["pack", "${PACKAGE}@${version}", "--pack-destination", context.work], { env: { npm_config_registry: ${JSON.stringify(registry)} } })`;
  return `import { exitIs } from ${JSON.stringify(CHECKS)};
export default {
  doors: ${PUBLISH_DOORS},
  journeys: {
    "stale": {
      title: "a version published after the shared cache saw the packument packs",
      entryPoint: "npm pack of an exact version, as ajs module install runs it",
      async run(context) {
        const first = await ${pack("npm pack first", FIRST)};
        context.expect(first.folder, [exitIs(first, 0)], { critical: true });
        await fetch(${JSON.stringify(`${registry}/publish`)}, { method: "POST" });
        const later = await ${pack("npm pack later", LATER)};
        context.expect(later.folder, [exitIs(later, 0)]);
      },
    },
  },
};
`;
}

test("an exact version published after an earlier run cached the packument still packs, even with the operator exporting NPM_CONFIG_PREFER_OFFLINE", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "verify-npm-cache-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const registry = await startRegistry(t);
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    [`${SKILL}/verify.config.ts`]: config(registry),
    [`${SKILL}/features/smoke.md`]: feature([], ["stale"]),
  });
  const cache = {
    XDG_CACHE_HOME: join(tmp, "cache"),
    NPM_CONFIG_PREFER_OFFLINE: "true",
  };
  const run = newRun(root, tmp, cache);
  const result = verify(root, tmp, ["journey", run, "smoke"], cache);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^PASS smoke\/stale \(\d+\.\d s\)$/m);
});
