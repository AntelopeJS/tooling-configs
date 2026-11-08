import assert from "node:assert/strict";
import test from "node:test";

import { apiRepo, bin, commit, put } from "./helpers/test-repo.ts";

const cli = (exitCode: number) =>
  `declare const process: { exitCode: number };\nconsole.log("cli 0.1.0 usage");\nprocess.exitCode = ${exitCode};\nexport const version = "0.1.0";\n`;
const runner = (code: number) =>
  `declare const process: { exit(code: number): never };\nconsole.log("runner needs a file");\nprocess.exit(${code});\n`;

test("api-diff describes wildcard entries that print on import, set an exit code or exit while loading, compares each exit code, and skips the non-JavaScript files a wildcard publishes", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "package.json",
    JSON.stringify({
      name: "cli-api",
      type: "module",
      scripts: {
        build: "tsc --noEmit false --composite false --declarationMap false",
      },
      exports: {
        "./dist/*.js": "./dist/*.js",
        "./dist/*": "./dist/*",
        "./templates/*": "./templates/*",
      },
    }),
  );
  put(root, "src/index.ts", cli(2));
  put(root, "src/runner.ts", runner(2));
  put(root, "src/lib.ts", "export function run(file: string) {}\n");
  put(root, "templates/page.vue", "<template><main /></template>\n");
  commit(root);
  const unchanged = bin(root, "api-diff", ["HEAD"]);
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
  assert.doesNotMatch(unchanged.stdout, /Execution error/);
  assert.match(
    unchanged.stdout,
    /Runtime API: 1 packages, 6 entries unchanged/,
  );
  put(root, "src/index.ts", cli(3));
  put(root, "src/runner.ts", runner(3));
  commit(root);
  const changed = bin(root, "api-diff", ["HEAD~1"]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stdout, /Runtime API: differences/);
  assert.match(
    changed.stdout,
    /index\.js\.json\n[^]*?\],\n-  "exit": 2\n\+  "exit": 3\n/,
  );
  assert.match(
    changed.stdout,
    /runner\.js\.json[^]*"kind": "esm",\n-  "exit": 2\n\+  "exit": 3\n/,
  );
});

test("api-diff reports an entry that loads and then fails asynchronously as an execution error, whatever NODE_OPTIONS says about unhandled rejections", (t) => {
  const root = apiRepo(t);
  put(
    root,
    "src/index.ts",
    'export const value = 1;\nvoid Promise.reject(new Error("late failure"));\n',
  );
  commit(root);
  const result = bin(root, "api-diff", ["HEAD"], {
    NODE_OPTIONS: "--unhandled-rejections=warn",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Execution error:[^]*Error: late failure/);
  assert.doesNotMatch(result.stdout, /"exit"/);
});
