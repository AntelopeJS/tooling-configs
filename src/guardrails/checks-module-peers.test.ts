import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stringify } from "yaml";

import {
  type StubModuleRelease,
  stubModuleRegistry,
} from "./helpers/module-registry.ts";
import { binAsync, put, testRepo } from "./helpers/test-repo.ts";

/** Every step but `lockfile:module-peers`, so it alone decides the run. */
const OTHER_STEPS =
  "typecheck,lint,format:check,knip,test,size,suppressions,sync:check,lockfile:frozen,lockfile:singletons,lockfile:antelopejs-peers,pnpm:release-age,dependency:ranges,dependency:one-range,git:identity,readme:version,published:types";

const ASSISTANT = "@antelopejs/dms-assistant";

/** A template whose root lockfile locks each of `locked` as a direct devDependency, beside an `antelope.config.ts` of `config`. */
function template(
  t: TestContext,
  config: string,
  locked: Readonly<Record<string, string>>,
): string {
  const root = testRepo(t);
  put(root, "package.json", JSON.stringify({ packageManager: "pnpm@10.2.0" }));
  put(root, "antelope.config.ts", config);
  put(
    root,
    "pnpm-lock.yaml",
    stringify({
      lockfileVersion: "9.0",
      importers: {
        ".": {
          devDependencies: Object.fromEntries(
            Object.entries(locked).map(([name, version]) => [
              name,
              { specifier: version, version },
            ]),
          ),
        },
      },
    }),
  );
  return root;
}

/** A config whose single module comes from `name` at `version`. */
function literalSource(name: string, version: string): string {
  return `import { defineConfig } from "@antelopejs/interface-core/config";\n\nexport default defineConfig({\n  modules: {\n    module: {\n      source: {\n        type: "package",\n        package: "${name}",\n        version: "${version}",\n      },\n    },\n  },\n});\n`;
}

async function checks(
  t: TestContext,
  root: string,
  modules: Readonly<
    Record<string, Readonly<Record<string, StubModuleRelease>>>
  >,
  tier?: string,
) {
  const url = await stubModuleRegistry(t, modules);
  return binAsync(root, "checks", ["--no-services"], {
    ANTELOPEJS_CHECKS_SKIP: OTHER_STEPS,
    ANTELOPEJS_CI_TIER: tier,
    npm_config_registry: url,
    NPM_CONFIG_REGISTRY: url,
  });
}

const renderer = (range: string): StubModuleRelease => ({
  frontend: { engines: { "@antelopejs/dms-frontend": range } },
});

const codexPeer = (version: string): StubModuleRelease => ({
  peerDependencies: { "@openai/codex": version },
});

test("a lockfile holding a renderer below the frontend range of the newest release a config range installs fails and names the module, the range, the locked version and the fix, caught by an implementation that reads the lowest release of the range or skips frontend-vue engines", async (t) => {
  const root = template(t, literalSource(ASSISTANT, ">=0.2.1 <0.3.0"), {
    "@antelopejs/dms-frontend": "0.11.4",
  });
  const result = await checks(t, root, {
    [ASSISTANT]: {
      "0.2.5": renderer(">=0.11.4 <0.12.0"),
      "0.2.6": renderer(">=0.11.6 <0.12.0"),
    },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(
    result.stdout,
    '[lockfile:module-peers]\npnpm-lock.yaml locks "@antelopejs/dms-frontend" at 0.11.4, outside ">=0.11.6 <0.12.0", the range @antelopejs/dms-assistant@0.2.6 (antelope.config.ts: ">=0.2.1 <0.3.0") declares in frontend-vue/package.json engines.\n  Set "@antelopejs/dms-frontend" in package.json to a version in ">=0.11.6 <0.12.0", then run `pnpm install`.\nChecks: 0 passed, 1 failed, 13 skipped.\n',
  );
});

test("a module antelope-lock/ holds is checked at its locked release, not the newest its config range admits, caught by an implementation that ignores antelope-lock/", async (t) => {
  const root = template(t, literalSource(ASSISTANT, ">=0.3.2 <0.4.0"), {
    "@openai/codex": "0.170.0",
  });
  put(root, `antelope-lock/${ASSISTANT}@0.3.2/package-lock.json`, "{}");
  const result = await checks(t, root, {
    [ASSISTANT]: {
      "0.3.2": codexPeer("0.166.0"),
      "0.3.3": codexPeer("0.170.0"),
    },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /locks "@openai\/codex" at 0\.170\.0, outside "0\.166\.0", the range @antelopejs\/dms-assistant@0\.3\.2 \(antelope-lock\/, for antelope\.config\.ts: ">=0\.3\.2 <0\.4\.0"\) declares in package\.json peerDependencies\./,
  );
});

test("an antelope-lock/ record the config range no longer admits is not the installed release, the newest release in the range is, caught by an implementation that trusts every antelope-lock/ folder", async (t) => {
  const root = template(t, literalSource(ASSISTANT, ">=0.4.0 <0.5.0"), {
    "@openai/codex": "0.166.0",
  });
  put(root, `antelope-lock/${ASSISTANT}@0.3.2/package-lock.json`, "{}");
  const result = await checks(t, root, {
    [ASSISTANT]: {
      "0.3.2": codexPeer("0.166.0"),
      "0.4.0": codexPeer("0.170.0"),
    },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /locks "@openai\/codex" at 0\.166\.0, outside "0\.170\.0", the range @antelopejs\/dms-assistant@0\.4\.0 \(antelope\.config\.ts: ">=0\.4\.0 <0\.5\.0"\)/,
  );
  assert.doesNotMatch(result.stdout, /0\.3\.2/);
});

test("a prerelease locked below a peerDependencies floor fails, caught by an implementation that reads every prerelease as the release it leads to, as only the renderer range does", async (t) => {
  const root = template(t, literalSource(ASSISTANT, "0.2.6"), {
    "@openai/codex": "1.0.0-rc.1",
  });
  const result = await checks(t, root, {
    [ASSISTANT]: { "0.2.6": codexPeer(">=1.0.0") },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /locks "@openai\/codex" at 1\.0\.0-rc\.1, outside ">=1\.0\.0"/,
  );
});

const corePeer = (range: string): StubModuleRelease => ({
  peerDependencies: { "@antelopejs/core": range },
});

test("a -next core inside a stable module's peer range passes, and one past it fails, caught by an implementation where no prerelease satisfies a range", async (t) => {
  const inside = template(t, literalSource(ASSISTANT, "0.2.6"), {
    "@antelopejs/core": "1.24.10-next.572.gf974e0f",
  });
  const passed = await checks(t, inside, {
    [ASSISTANT]: { "0.2.6": corePeer("~1.24.x") },
  });
  assert.equal(passed.status, 0, passed.stdout);

  const past = template(t, literalSource(ASSISTANT, "0.2.6"), {
    "@antelopejs/core": "1.25.0-next.1",
  });
  const failed = await checks(t, past, {
    [ASSISTANT]: { "0.2.6": corePeer("~1.24.x") },
  });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(
    failed.stdout,
    /locks "@antelopejs\/core" at 1\.25\.0-next\.1, outside "~1\.24\.x"/,
  );
});

test("a prerelease of the release a hand-written '<' bound excludes fails, and one below it passes, caught by an implementation that orders 1.25.0-next.1 below '<1.25.0' as semver does", async (t) => {
  const range = ">=1.24.0 <1.25.0";
  const inside = template(t, literalSource(ASSISTANT, "0.2.6"), {
    "@antelopejs/core": "1.24.10-next.572.gf974e0f",
  });
  const passed = await checks(t, inside, {
    [ASSISTANT]: { "0.2.6": corePeer(range) },
  });
  assert.equal(passed.status, 0, passed.stdout);

  const past = template(t, literalSource(ASSISTANT, "0.2.6"), {
    "@antelopejs/core": "1.25.0-next.1",
  });
  const failed = await checks(t, past, {
    [ASSISTANT]: { "0.2.6": corePeer(range) },
  });
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(
    failed.stdout,
    /locks "@antelopejs\/core" at 1\.25\.0-next\.1, outside ">=1\.24\.0 <1\.25\.0"/,
  );
});

test("a prerelease past a bare '<X.Y.Z' passes exactly when its comparator set admits it under semver's default prerelease rule, as pnpm judges it, caught by an implementation that vetoes an exact pin of that prerelease or lists the comparators that may name it", async (t) => {
  const next = "1.25.0-next.1";
  const cases: readonly (readonly [string, string, 0 | 1])[] = [
    ["<1.25.0 1.25.0-next.1", next, 0],
    ["<1.25.0 =1.25.0-next.1", next, 0],
    [">=1.24.0 <1.25.0", next, 1],
    ["<2.0.0", "2.0.0-rc.1", 1],
    ["<1.25.0 >=1.25.0-next.1", next, 0],
    [">=1.20.0 <1.25.0 || >=1.25.0-next.0 <1.25.0", next, 0],
    ["<1.25.0 >=1.25.0-next.5", next, 1],
    ["<1.25.0 >1.25.0-next.1", next, 1],
    ["<1.25.0 >=1.24.0-next.1", next, 1],
    ["<1.25.0 || >=1.25.0-next.5", next, 1],
    ["<1.25.0 <1.25.0-next.9", next, 0],
    ["<1.25.0 >=1.25.0-alpha", next, 0],
    ["<1.25.0 >=1.25.0-next.1", "1.25.0-alpha.1", 1],
    ["^1.24.0", next, 0],
    ["<=1.25.0", next, 0],
    ["~1.24.x", next, 1],
    ["<1.25", next, 1],
    ["<1.25.0-0", next, 1],
  ];
  const wrong: string[] = [];
  for (const [range, core, status] of cases) {
    const root = template(t, literalSource(ASSISTANT, "0.2.6"), {
      "@antelopejs/core": core,
    });
    const result = await checks(t, root, {
      [ASSISTANT]: { "0.2.6": corePeer(range) },
    });
    if (result.status !== status)
      wrong.push(`"${range}" with ${core} exited ${result.status}`);
  }
  assert.deepEqual(wrong, []);
});

test("a source a local function builds with `as const` is read at each call, caught by an implementation that reads only object literals whose fields are strings", async (t) => {
  const config = `function moduleSource(name: string, version: string) {\n  return { type: "package" as const, package: name, version };\n}\n\nexport default {\n  modules: {\n    api: { source: { type: "local", path: "." } },\n    assistant: { source: moduleSource("${ASSISTANT}", "^0.2.1") },\n  },\n};\n`;
  const root = template(t, config, { "@openai/codex": "0.170.0" });
  const result = await checks(t, root, {
    [ASSISTANT]: { "0.2.6": codexPeer("0.166.0") },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /the range @antelopejs\/dms-assistant@0\.2\.6 \(antelope\.config\.ts: "\^0\.2\.1"\) declares in package\.json peerDependencies\./,
  );
});

test("locked versions inside every range pass, and a frontend-vue peerDependency the dashboard workspace installs apart does not count, caught by an implementation that holds the root lockfile to frontend-vue peerDependencies", async (t) => {
  const root = template(t, literalSource("@antelopejs/dms", "0.23.0"), {
    "@antelopejs/dms-frontend": "0.11.8",
    typescript: "6.0.3",
  });
  const result = await checks(t, root, {
    "@antelopejs/dms": {
      "0.23.0": {
        frontend: {
          peerDependencies: { typescript: "^5.8.0" },
          engines: { "@antelopejs/dms-frontend": ">=0.11.8 <0.12.0" },
        },
      },
    },
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, "Checks: 1 passed, 0 failed, 13 skipped.\n");
});

test("a package source whose package is not a string fails and names its line, caught by an implementation that skips a source it cannot read", async (t) => {
  const config = `const name = "${ASSISTANT}";\n\nexport default {\n  modules: {\n    assistant: {\n      source: { type: "package", package: name, version: "^0.2.1" },\n    },\n  },\n};\n`;
  const root = template(t, config, { "@openai/codex": "0.166.0" });
  const result = await checks(t, root, {});
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\nantelope\.config\.ts:6 holds a package source whose package or version is not a string/,
  );
});

test("a package source with a non-literal version inside a default-exported function fails and names its line, caught by an implementation that stores it as a helper only a call resolves", async (t) => {
  const config = `export default function build() {\n  const v = process.env.V ?? "0.2.1";\n  return {\n    modules: {\n      assistant: {\n        source: { type: "package", package: "${ASSISTANT}", version: v },\n      },\n    },\n  };\n}\n`;
  const root = template(t, config, { "@openai/codex": "0.166.0" });
  const result = await checks(t, root, {});
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /\nantelope\.config\.ts:6 holds a package source whose package or version is not a string/,
  );
});

test("the draft, fast and full tiers skip lockfile:module-peers because it reads the registry, and the queue tier runs it, caught by an implementation that leaves it out of the registry steps", async (t) => {
  const root = template(t, literalSource(ASSISTANT, "^0.2.1"), {
    "@openai/codex": "0.170.0",
  });
  const modules = { [ASSISTANT]: { "0.2.6": codexPeer("0.166.0") } };
  for (const tier of ["draft", "fast", "full"]) {
    const result = await checks(t, root, modules, tier);
    assert.equal(result.status, 0, `${tier}: ${result.stdout}`);
  }
  const queued = await checks(t, root, modules, "queue");
  assert.equal(queued.status, 1, queued.stdout);
  assert.match(queued.stdout, /^\[lockfile:module-peers\]\n/);
});

test("a root package.json interface range no range a configured module release depends on meets fails and names both, and a release whose range meets it passes, caught by an implementation that reads only peerDependencies or compares range strings", async (t) => {
  const dms = (interfaceRange: string): StubModuleRelease => ({
    dependencies: { "@antelopejs/interface-dms": interfaceRange },
  });
  const project = (): string => {
    const root = template(
      t,
      literalSource("@antelopejs/dms", ">=0.23.0 <0.24.0"),
      {},
    );
    put(
      root,
      "package.json",
      JSON.stringify({
        packageManager: "pnpm@10.2.0",
        dependencies: { "@antelopejs/interface-dms": ">=0.17.0 <0.18.0" },
      }),
    );
    return root;
  };
  const clash = await checks(t, project(), {
    "@antelopejs/dms": { "0.23.0": dms("^0.16.0") },
  });
  assert.equal(clash.status, 1, clash.stdout);
  assert.equal(
    clash.stdout,
    '[lockfile:module-peers]\n@antelopejs/interface-dms: package.json requires ">=0.17.0 <0.18.0" and @antelopejs/dms@0.23.0 (antelope.config.ts: ">=0.23.0 <0.24.0") requires "^0.16.0"; no copy satisfies both, so the project stops at boot with "Incompatible interface package resolution". Move one of them to a release whose range meets the other.\nChecks: 0 passed, 1 failed, 15 skipped.\n',
  );
  const met = await checks(t, project(), {
    "@antelopejs/dms": { "0.23.0": dms("^0.17.2") },
  });
  assert.equal(met.status, 0, met.stdout);
});

test("two configured module releases whose interface ranges do not meet fail with no root range, and a prerelease pin inside a prerelease range passes, caught by an implementation that compares only against package.json or intersects without prereleases", async (t) => {
  const depending = (range: string): StubModuleRelease => ({
    dependencies: { "@antelopejs/interface-dms": range },
  });
  const config = `export default {\n  modules: {\n    dms: { source: { type: "package", package: "@antelopejs/dms", version: "0.23.0" } },\n    assistant: { source: { type: "package", package: "${ASSISTANT}", version: "0.3.4" } },\n  },\n};\n`;
  const clash = await checks(t, template(t, config, {}), {
    "@antelopejs/dms": { "0.23.0": depending("^0.16.0") },
    [ASSISTANT]: { "0.3.4": depending(">=0.17.0 <0.18.0") },
  });
  assert.equal(clash.status, 1, clash.stdout);
  assert.match(
    clash.stdout,
    /@antelopejs\/interface-dms: @antelopejs\/dms@0\.23\.0 \(antelope\.config\.ts: "0\.23\.0"\) requires "\^0\.16\.0" and @antelopejs\/dms-assistant@0\.3\.4 \(antelope\.config\.ts: "0\.3\.4"\) requires ">=0\.17\.0 <0\.18\.0"/,
  );
  const prerelease = await checks(t, template(t, config, {}), {
    "@antelopejs/dms": { "0.23.0": depending("^0.17.0-0") },
    [ASSISTANT]: { "0.3.4": depending("0.17.0-next.1") },
  });
  assert.equal(prerelease.status, 0, prerelease.stdout);
});
