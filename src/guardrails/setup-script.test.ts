import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { put } from "./helpers/test-repo.ts";
import { SETUP_SCRIPT } from "./templates.ts";

const COREPACK_WITHOUT_GLOBAL_WRITE = `#!/usr/bin/env bash
if [[ "$1" == enable ]]; then
  if [[ "$2" != --install-directory ]]; then
    echo "Internal Error: EACCES: permission denied, symlink -> /usr/bin/pnpm"
    exit 1
  fi
  printf '#!/usr/bin/env bash\\necho "shim pnpm $*"\\n' > "$3/pnpm"
  chmod +x "$3/pnpm"
fi
`;

const GLOBAL_PNPM = `#!/usr/bin/env bash
echo "global pnpm $*"
`;

test("setup installs through corepack shims in the home bin directory when the Node bin directory is read-only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antelope-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const stubs = join(root, "stubs");
  put(repo, ".agents/setup", SETUP_SCRIPT);
  chmodSync(join(repo, ".agents/setup"), 0o755);
  put(repo, ".nvmrc", `${process.versions.node.split(".")[0]}\n`);
  put(repo, "package.json", '{ "packageManager": "pnpm@10.0.0" }\n');
  put(stubs, "corepack", COREPACK_WITHOUT_GLOBAL_WRITE);
  put(stubs, "pnpm", GLOBAL_PNPM);
  chmodSync(join(stubs, "corepack"), 0o755);
  chmodSync(join(stubs, "pnpm"), 0o755);
  put(home, ".keep", "");

  const result = spawnSync(join(repo, ".agents/setup"), {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: [stubs, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "shim pnpm install --frozen-lockfile\n");
});
