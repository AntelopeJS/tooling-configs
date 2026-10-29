import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import type { JsonValue } from "../garden/json.ts";
import { PACKAGE_ROOT } from "../guardrails/helpers/test-repo.ts";
import {
  declaredSurface,
  diffSurface,
  minorRule,
  releaseType,
  type SurfaceDiff,
} from "./surface.ts";

const folders: string[] = [];

after(() => {
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
});

function surfaceOf(
  manifest: JsonValue,
  files: [string, string][],
  nodeTypes = false,
): Record<string, string> {
  const folder = mkdtempSync(join(tmpdir(), "surface-"));
  folders.push(folder);
  const all: [string, string][] = [
    ["package.json", JSON.stringify(manifest)],
    ...files,
  ];
  for (const [name, content] of all) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), content);
  }
  if (nodeTypes) {
    mkdirSync(join(folder, "node_modules", "@types"), { recursive: true });
    symlinkSync(
      join(PACKAGE_ROOT, "node_modules", "@types", "node"),
      join(folder, "node_modules", "@types", "node"),
      "dir",
    );
  }
  return Object.fromEntries(declaredSurface(folder));
}

const NONE: SurfaceDiff = { added: [], removed: [], changed: [] };
const ADDED: SurfaceDiff = { added: [".:Ping"], removed: [], changed: [] };

test("namespace and object-literal members are entries, plain values and types are not", () => {
  const surface = surfaceOf(
    { name: "a", version: "1.0.0", types: "index.d.ts" },
    [
      [
        "index.d.ts",
        `export declare function GetClient(name: string): string;
export declare namespace internal { function SetClient(client: string): void; }
export declare const Greeter: { greet: (name: string) => string; inner: { deep: () => void } };
export declare const limit: number;
export interface Options { run(): void }
export type Runner = () => void;`,
      ],
    ],
  );
  assert.deepEqual(surface, {
    ".:GetClient": "(name: string) => string",
    ".:internal.SetClient": "(client: string) => void",
    ".:Greeter.greet": "(name: string) => string",
    ".:Greeter.inner.deep": "() => void",
  });
});

test("a variable whose type has call signatures is one entry and is not entered", () => {
  const surface = surfaceOf({ name: "a", types: "index.d.ts" }, [
    [
      "index.d.ts",
      `type Fn = ((a: string) => void) & { extra: () => void };
export declare const Wrapped: Fn;`,
    ],
  ]);
  assert.deepEqual(Object.keys(surface), [".:Wrapped"]);
});

test("a subpath export reads its nested types condition and skips package.json and patterns", () => {
  const surface = surfaceOf(
    {
      name: "a",
      exports: {
        ".": { import: { types: "./index.d.mts", default: "./index.mjs" } },
        "./util": { types: "./util.d.ts", default: "./util.js" },
        "./package.json": "./package.json",
        "./feature/*": { types: "./feature/*.d.ts" },
        "./runtime": "./runtime.js",
      },
    },
    [
      ["index.d.mts", "export declare function root(): void;"],
      [
        "util.d.ts",
        "export declare class Greeter { greet(name: string): string }",
      ],
    ],
  );
  assert.deepEqual(surface, {
    ".:root": "() => void",
    "./util:Greeter": "new () => Greeter",
    "./util:Greeter.prototype.greet": "(name: string) => string",
  });
});

test("overloads are joined in declaration order", () => {
  const surface = surfaceOf({ name: "a", types: "index.d.ts" }, [
    [
      "index.d.ts",
      `export declare function parse(text: string): string;
export declare function parse(value: number, radix: number): number;`,
    ],
  ]);
  assert.deepEqual(surface, {
    ".:parse":
      "(text: string) => string | (value: number, radix: number) => number",
  });
});

test("a class lists its constructors, public methods and static methods but not private, protected or properties", () => {
  const surface = surfaceOf({ name: "a", types: "index.d.ts" }, [
    [
      "index.d.ts",
      `export declare class Store {
  constructor(name: string);
  get(key: string): string;
  private hidden(): void;
  protected guarded(): void;
  value: number;
  static open(): Store;
}`,
    ],
  ]);
  assert.deepEqual(surface, {
    ".:Store": "new (name: string) => Store",
    ".:Store.prototype.get": "(key: string) => string",
    ".:Store.open": "() => Store",
  });
});

test("export star and renamed re-exports are followed to the declaring file", () => {
  const surface = surfaceOf({ name: "a", types: "index.d.ts" }, [
    [
      "index.d.ts",
      `export * from "./other.js";
export { hidden as Renamed } from "./other.js";
export * as ns from "./ns.js";`,
    ],
    [
      "other.d.ts",
      `export declare function fromOther(): void;
export declare function hidden(x: number): void;`,
    ],
    ["ns.d.ts", "export declare function inside(): void;"],
  ]);
  assert.deepEqual(surface, {
    ".:fromOther": "() => void",
    ".:hidden": "(x: number) => void",
    ".:Renamed": "(x: number) => void",
    ".:ns.inside": "() => void",
  });
});

test("types from a dependency are neither entered through a return, a variable nor a class property", () => {
  const surface = surfaceOf({ name: "a", types: "index.d.ts" }, [
    [
      "node_modules/big-lib/package.json",
      JSON.stringify({ name: "big-lib", types: "index.d.ts" }),
    ],
    [
      "node_modules/big-lib/index.d.ts",
      "export type Client = { get(): string; set(value: string): void; nested: { del(): void } };",
    ],
    [
      "index.d.ts",
      `import type { Client } from "big-lib";
export declare function connect(): Client;
export declare const shared: Client;
export declare class Holder { client: Client; }`,
    ],
  ]);
  assert.deepEqual(surface, {
    ".:connect": "() => Client",
    ".:Holder": "new () => Holder",
  });
});

test("an import the package cannot resolve fails loudly instead of yielding a partial surface", () => {
  assert.throws(
    () =>
      surfaceOf({ name: "a", types: "index.d.ts" }, [
        [
          "index.d.ts",
          `import type { X } from "missing-dep";\nexport declare function f(): X;`,
        ],
      ]),
    /missing-dep/,
  );
});

const STREAM_DECLARATION: [string, string] = [
  "index.d.ts",
  `import type { Readable } from "node:stream";\nexport declare function Open(path: string): Readable;`,
];

test("a declaration importing a Node built-in reads through the @types/node the package resolves", () => {
  const surface = surfaceOf(
    { name: "a", types: "index.d.ts" },
    [STREAM_DECLARATION],
    true,
  );
  assert.deepEqual(surface, { ".:Open": "(path: string) => Readable" });
});

test("without @types/node a node: import still fails loudly and says what to install", () => {
  assert.throws(
    () => surfaceOf({ name: "a", types: "index.d.ts" }, [STREAM_DECLARATION]),
    /index\.d\.ts -> node:stream; install @types\/node so node: built-ins resolve/,
  );
});

test("diffSurface lists added, removed and changed paths sorted", () => {
  const published = new Map([
    ["b", "() => void"],
    ["z", "() => void"],
    ["a", "(x: string) => void"],
    ["keep", "() => void"],
  ]);
  const head = new Map([
    ["d", "() => void"],
    ["c", "() => void"],
    ["a", "(x: number) => void"],
    ["keep", "() => void"],
    ["z", "() => string"],
  ]);
  assert.deepEqual(diffSurface(published, head), {
    added: ["c", "d"],
    removed: ["b"],
    changed: [
      {
        path: "a",
        before: "(x: string) => void",
        after: "(x: number) => void",
      },
      { path: "z", before: "() => void", after: "() => string" },
    ],
  });
});

test("releaseType follows changelogen: feat is minor, breaking is major, and 0.x demotes each one step", () => {
  assert.equal(releaseType("1.4.2", ["fix: a"]), "patch");
  assert.equal(releaseType("1.4.2", ["fix: a", "feat(core): b"]), "minor");
  assert.equal(releaseType("1.4.2", ["feat!: a", "feat: b"]), "major");
  assert.equal(
    releaseType("1.4.2", ["fix: a\n\nBREAKING CHANGE: gone"]),
    "major",
  );
  assert.equal(releaseType("1.4.2", ["chore: a"]), "patch");
  assert.equal(releaseType("0.0.9", ["fix: a"]), "patch");
  assert.equal(releaseType("0.0.9", ["feat: a"]), "patch");
  assert.equal(releaseType("0.0.9", ["feat!: a"]), "minor");
  assert.equal(
    releaseType("0.0.9", ["fix: a\n\nBREAKING CHANGE: gone"]),
    "minor",
  );
  assert.equal(releaseType("0.0.9", []), "patch");
});

test("a feat! title on 0.0.9 with an added function releases 0.1.0 and passes", () => {
  const verdict = minorRule({
    published: "0.0.9",
    headVersion: "0.0.9",
    titles: ["feat!: add ping"],
    diff: ADDED,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.required, "minor");
  assert.equal(verdict.releases, "0.1.0");
  assert.match(verdict.reason, /added \.:Ping/);
});

test("a feat title on 0.0.9 with an added function releases 0.0.10 and fails with the fix", () => {
  const verdict = minorRule({
    published: "0.0.9",
    headVersion: "0.0.9",
    titles: ["feat: add ping"],
    diff: ADDED,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.releases, "0.0.10");
  assert.match(verdict.reason, /needs at least 0\.1\.0/);
  assert.match(verdict.reason, /feat!:/);
  assert.match(verdict.reason, /release-version 0\.1\.0/);
});

test("a feat title on 1.4.2 passes and a fix title on 1.4.2 fails", () => {
  const feat = minorRule({
    published: "1.4.2",
    headVersion: "1.4.2",
    titles: ["feat: x"],
    diff: ADDED,
  });
  assert.equal(feat.ok, true);
  assert.equal(feat.releases, "1.5.0");
  const fix = minorRule({
    published: "1.4.2",
    headVersion: "1.4.2",
    titles: ["fix: x"],
    diff: {
      added: [],
      removed: [],
      changed: [{ path: ".:A", before: "a", after: "b" }],
    },
  });
  assert.equal(fix.ok, false);
  assert.match(fix.reason, /changed \.:A/);
  assert.match(fix.reason, /`feat:`/);
  assert.match(fix.reason, /release-version 1\.5\.0/);
});

test("a head version already bumped past the published minor passes whatever the titles", () => {
  const verdict = minorRule({
    published: "0.0.9",
    headVersion: "0.1.0",
    titles: ["fix: x"],
    diff: ADDED,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.releases, "0.1.0");
});

test("a head version bumped by a patch only still fails, and a prerelease sorts below its release", () => {
  const patch = minorRule({
    published: "0.0.9",
    headVersion: "0.0.10",
    titles: [],
    diff: ADDED,
  });
  assert.equal(patch.ok, false);
  const pre = minorRule({
    published: "0.0.9",
    headVersion: "0.1.0-rc.1",
    titles: [],
    diff: ADDED,
  });
  assert.equal(pre.ok, false);
});

test("no surface change requires nothing, and a removal requires a minor", () => {
  const same = minorRule({
    published: "1.4.2",
    headVersion: "1.4.2",
    titles: ["fix: x"],
    diff: NONE,
  });
  assert.equal(same.required, "none");
  assert.equal(same.ok, true);
  const removed = minorRule({
    published: "1.4.2",
    headVersion: "1.4.2",
    titles: ["fix: x"],
    diff: { added: [], removed: [".:Old"], changed: [] },
  });
  assert.equal(removed.required, "minor");
  assert.equal(removed.ok, false);
});

test("a never-published interface requires nothing", () => {
  const verdict = minorRule({
    published: null,
    headVersion: "0.0.1",
    titles: [],
    diff: ADDED,
  });
  assert.equal(verdict.required, "none");
  assert.equal(verdict.ok, true);
  assert.match(verdict.reason, /never published/);
});
