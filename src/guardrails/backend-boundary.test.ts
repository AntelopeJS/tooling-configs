import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import ts from "typescript";
import { build, type Plugin } from "vite";

import { backendBoundarySource } from "./backend-boundary.ts";
import { formatCeilings } from "./ceilings.ts";
import {
  bin,
  commit,
  PACKAGE_ROOT,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";

const BACKEND = "@antelopejs/dms-fixture";
const DMS_AI_COPY = read(
  PACKAGE_ROOT,
  "src/guardrails/fixtures/dms-ai-e4bd2ba0-backend-boundary.txt",
);

function adoptedRepo(t: TestContext): string {
  const root = testRepo(t);
  put(
    root,
    "guardrails.ratchet.json",
    formatCeilings({ rules: { "eslint/max-params": 1 }, oversizeFiles: {} }),
  );
  const sync = bin(root, "sync");
  assert.equal(sync.status, 0, sync.stderr);
  commit(root);
  return root;
}

interface Layout {
  backend: string;
  layer: string;
}

function layout(t: TestContext): Layout {
  const root = mkdtempSync(join(tmpdir(), "antelope-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = join(root, "backend");
  const layer = join(backend, "frontend-vue");
  put(backend, "package.json", JSON.stringify({ name: BACKEND }));
  for (const file of ["src/x.ts", "src/x/y.ts", "srcx/api.ts", "dist/src/x.ts"])
    put(backend, file, `export default ${JSON.stringify(file)};\n`);
  put(
    root,
    "other/package.json",
    JSON.stringify({ name: "@antelopejs/other" }),
  );
  put(root, "other/src/x.ts", 'export default "other";\n');
  put(
    layer,
    "package.json",
    JSON.stringify({ name: `${BACKEND}-frontend-vue`, type: "module" }),
  );
  put(layer, "src/own.ts", 'export default "own";\n');
  put(layer, "worker.ts", 'import x from "../src/x.ts";\npostMessage(x);\n');
  symlinkSync(join(backend, "src"), join(layer, "linked"), "dir");
  return { backend, layer };
}

/** Writes `source` as the layer's plugin and a Vite config registering it, as `dms.frontend.build.ts` does, and returns the config path. */
function boundaryConfig(layer: string, source: string): string {
  put(layer, "build/backend-boundary.ts", source);
  put(
    layer,
    "vite.config.ts",
    'import { backendBoundary } from "./build/backend-boundary.ts";\nexport default { plugins: [backendBoundary()] };\n',
  );
  return join(layer, "vite.config.ts");
}

function answering(
  specifier: string,
  answer: (backend: string) => string | { id: string; external: true },
  backend: string,
): Plugin {
  return {
    name: "fixture-resolver",
    enforce: "pre",
    resolveId: (source) => (source === specifier ? answer(backend) : null),
  };
}

interface Case {
  name: string;
  entry?: string;
  imports?: string;
  extra?: (backend: string) => Plugin[];
  external?: (backend: string) => string[];
  alias?: (backend: string) => Record<string, string>;
  preserveSymlinks?: boolean;
  expected: "boundary" | "built";
}

const CASES: Case[] = [
  {
    name: "a relative import of the backend's src fails",
    imports: "../src/x.ts",
    expected: "boundary",
  },
  {
    name: "a nested file of the backend's src fails (dms-database #66, dms-ai #103)",
    imports: "../src/x/y.ts",
    expected: "boundary",
  },
  {
    name: "a src-prefixed sibling builds (dms-database #66, dms-builder #74)",
    imports: "../srcx/api.ts",
    expected: "built",
  },
  {
    name: "src under dist builds (dms-builder #74, dms-saas #154)",
    imports: "../dist/src/x.ts",
    expected: "built",
  },
  {
    name: "a ?raw import of the backend's src fails",
    imports: "../src/x.ts?raw",
    expected: "boundary",
  },
  {
    name: "a resolution with a #hash fails (dms-builder #74, dms-saas #154)",
    imports: "virtual:hash",
    extra: (backend) => [
      answering("virtual:hash", (root) => `${root}/src/x.ts#part`, backend),
    ],
    expected: "boundary",
  },
  {
    name: "a resolution with a ?query fails",
    imports: "virtual:query",
    extra: (backend) => [
      answering("virtual:query", (root) => `${root}/src/x.ts?part`, backend),
    ],
    expected: "boundary",
  },
  {
    name: "a resolver answering external fails (dms-saas #154 backend-boundary.ts:75)",
    imports: "virtual:external",
    extra: (backend) => [
      answering(
        "virtual:external",
        (root) => ({ id: `${root}/src/x.ts`, external: true }),
        backend,
      ),
    ],
    expected: "boundary",
  },
  {
    name: "an external option matching the resolved id fails (dms-builder #74, dms-automation #88)",
    imports: "../src/x.ts",
    external: (backend) => [join(backend, "src/x.ts")],
    expected: "boundary",
  },
  {
    name: "an alias into the backend's src fails",
    imports: "#backend/x.ts",
    alias: (backend) => ({ "#backend": join(backend, "src") }),
    expected: "boundary",
  },
  {
    name: "a symlink into the backend's src fails",
    imports: "./linked/x.ts",
    preserveSymlinks: true,
    expected: "boundary",
  },
  {
    name: "another package's src builds",
    imports: "../../other/src/x.ts",
    expected: "built",
  },
  {
    name: "the frontend package's own src builds",
    imports: "./src/own.ts",
    expected: "built",
  },
  {
    name: "a worker importing the backend's src fails",
    entry:
      'export default new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });\n',
    expected: "boundary",
  },
];

async function outcome(
  config: string,
  { backend, layer }: Layout,
  check: Case,
): Promise<string> {
  const id = CASES.indexOf(check);
  put(
    layer,
    `entry-${id}.ts`,
    check.entry ??
      `import value from ${JSON.stringify(check.imports)};\nexport default value;\n`,
  );
  try {
    await build({
      root: layer,
      configFile: config,
      logLevel: "silent",
      resolve: {
        alias: check.alias?.(backend) ?? {},
        preserveSymlinks: check.preserveSymlinks ?? false,
      },
      plugins: check.extra?.(backend) ?? [],
      build: {
        write: false,
        lib: { entry: join(layer, `entry-${id}.ts`), formats: ["es"] },
        rolldownOptions: { external: check.external?.(backend) ?? [] },
      },
    });
    return "built";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Backend boundary: ")
      ? "boundary"
      : `failed otherwise: ${message}`;
  }
}

function named(name: string): Case {
  const found = CASES.find((check) => check.name === name);
  assert.ok(found, name);
  return found;
}

for (const check of CASES)
  test(`backend boundary: ${check.name}`, async (t) => {
    const fixture = layout(t);
    const config = boundaryConfig(
      fixture.layer,
      backendBoundarySource(BACKEND),
    );
    assert.equal(await outcome(config, fixture, check), check.expected);
  });

test("backend boundary names the importer, or an entry point, and the backend package", async (t) => {
  const fixture = layout(t);
  const config = boundaryConfig(fixture.layer, backendBoundarySource(BACKEND));
  await assert.rejects(
    build({
      root: fixture.layer,
      configFile: config,
      logLevel: "silent",
      build: {
        write: false,
        lib: { entry: join(fixture.backend, "src/x.ts"), formats: ["es"] },
      },
    }),
    (error: Error) =>
      error.message.includes(
        `Backend boundary: an entry point imports ${join(fixture.backend, "src/x.ts")}, which is under the src of ${BACKEND}.`,
      ),
  );
});

const MUTANTS: { name: string; from: string; to: string; killedBy: string }[] =
  [
    {
      name: "the early return for an external resolution (dms-saas #154)",
      from: "if (resolved === null) {",
      to: "if (resolved === null || resolved.external) {",
      killedBy:
        "a resolver answering external fails (dms-saas #154 backend-boundary.ts:75)",
    },
    {
      name: "a src prefix instead of the src directory (dms-database #66)",
      from: "relative(root, real).split(sep)[0] === BACKEND_SOURCE",
      to: "relative(root, real).startsWith(BACKEND_SOURCE)",
      killedBy:
        "a src-prefixed sibling builds (dms-database #66, dms-builder #74)",
    },
    {
      name: "src as any segment (dms-builder #74)",
      from: "relative(root, real).split(sep)[0] === BACKEND_SOURCE",
      to: "relative(root, real).split(sep).includes(BACKEND_SOURCE)",
      killedBy: "src under dist builds (dms-builder #74, dms-saas #154)",
    },
    {
      name: "src as the parent directory only (dms-database #66)",
      from: "relative(root, real).split(sep)[0] === BACKEND_SOURCE",
      to: "relative(root, real).split(sep).at(-2) === BACKEND_SOURCE",
      killedBy:
        "a nested file of the backend's src fails (dms-database #66, dms-ai #103)",
    },
    {
      name: "a #hash kept on the id (dms-builder #74)",
      from: "/[?#].*$/",
      to: "/[?].*$/",
      killedBy:
        "a resolution with a #hash fails (dms-builder #74, dms-saas #154)",
    },
    {
      name: "the resolved path instead of the real path",
      from: "real = realpathSync(path)",
      to: "real = path",
      killedBy: "a symlink into the backend's src fails",
    },
    {
      name: "any package instead of the backend package",
      from: "packageName(manifest) === BACKEND_PACKAGE",
      to: "packageName(manifest) !== undefined",
      killedBy: "another package's src builds",
    },
    {
      name: "no check in worker builds",
      from: "config: () => ({ worker: { plugins: () => [boundaryCheck()] } }),",
      to: "",
      killedBy: "a worker importing the backend's src fails",
    },
  ];

for (const mutant of MUTANTS)
  test(`backend boundary matrix kills the mutant: ${mutant.name}`, async (t) => {
    const source = backendBoundarySource(BACKEND);
    assert.ok(source.includes(mutant.from), `${mutant.from} is in the plugin`);
    const fixture = layout(t);
    const config = boundaryConfig(
      fixture.layer,
      source.replace(mutant.from, mutant.to),
    );
    const check = named(mutant.killedBy);
    assert.notEqual(await outcome(config, fixture, check), check.expected);
  });

test("backend boundary typechecks as a DMS frontend build plugin entry", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antelope-boundary-types-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(
    root,
    "frontend-build.ts",
    'import type { Plugin } from "vite";\nexport type DmsVitePluginEntry = Plugin | false | null | undefined | readonly DmsVitePluginEntry[];\n',
  );
  put(root, "build/backend-boundary.ts", backendBoundarySource(BACKEND));
  put(
    root,
    "dms.frontend.build.ts",
    'import type { DmsVitePluginEntry } from "#dms/frontend-build";\nimport { backendBoundary } from "./build/backend-boundary.ts";\nexport const plugins: DmsVitePluginEntry = [backendBoundary()];\n',
  );
  const program = ts.createProgram([join(root, "dms.frontend.build.ts")], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(PACKAGE_ROOT, "node_modules/@types")],
    paths: {
      "#dms/frontend-build": [join(root, "frontend-build.ts")],
      vite: [join(PACKAGE_ROOT, "node_modules/vite/dist/node/index.d.ts")],
    },
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
  assert.deepEqual(diagnostics, []);
});

test("sync restores a copied backend boundary for the package that holds the layer, and ignores formatting (dms-ai #103 copy)", (t) => {
  const root = adoptedRepo(t);
  put(
    root,
    "packages/dms-x/package.json",
    JSON.stringify({ name: "@antelopejs/dms-x" }),
  );
  put(
    root,
    "packages/dms-x/frontend-vue/package.json",
    JSON.stringify({ name: "@antelopejs/dms-x-frontend-vue" }),
  );
  const path = "packages/dms-x/frontend-vue/build/backend-boundary.ts";
  put(root, path, DMS_AI_COPY);
  commit(root);
  const drift = bin(root, "sync", ["--check"]);
  assert.equal(drift.status, 1, drift.stderr);
  assert.equal(drift.stdout, `Drift: ${path}; run antelopejs-sync\n`);
  assert.equal(bin(root, "sync").status, 0);
  assert.equal(read(root, path), backendBoundarySource("@antelopejs/dms-x"));
  put(
    root,
    "fmt.json",
    JSON.stringify({ useTabs: false, singleQuote: true, semi: false }),
  );
  const oxfmt = spawnSync(
    process.execPath,
    [
      join(PACKAGE_ROOT, "node_modules/oxfmt/bin/oxfmt"),
      "--config",
      "fmt.json",
      path,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(oxfmt.status, 0, oxfmt.stderr);
  assert.notEqual(read(root, path), backendBoundarySource("@antelopejs/dms-x"));
  assert.equal(bin(root, "sync", ["--check"]).status, 0);
  put(
    root,
    path,
    backendBoundarySource("@antelopejs/dms-x").replace(
      "if (resolved === null) {",
      "if (resolved === null || resolved.external) {",
    ),
  );
  const edited = bin(root, "sync", ["--check"]);
  assert.equal(edited.status, 1);
  assert.equal(edited.stdout, `Drift: ${path}; run antelopejs-sync\n`);
});

test("sync fails naming the fix when the package holding a backend boundary has no name", (t) => {
  const root = adoptedRepo(t);
  put(root, "packages/dms-x/package.json", "{}\n");
  put(
    root,
    "packages/dms-x/frontend-vue/build/backend-boundary.ts",
    DMS_AI_COPY,
  );
  commit(root);
  const result = bin(root, "sync", ["--check"]);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "packages/dms-x/frontend-vue/build/backend-boundary.ts guards the backend package packages/dms-x/package.json, which has no name. Name that package, then rerun antelopejs-sync.\n",
  );
});
