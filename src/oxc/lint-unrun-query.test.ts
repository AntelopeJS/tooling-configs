import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { lintProject } from "./helpers/lint-project.ts";

const RULE = "antelopejs(no-unrun-query)";

const interfaceDatabase = fileURLToPath(
  new URL(
    ".",
    import.meta.resolve("@antelopejs/interface-database/package.json"),
  ),
);

const NOVELS = `import type { Table } from "@antelopejs/interface-database";

export declare const novels: Table<{ title: string }>;
`;

type Project = ReturnType<typeof lintProject>;

function link(project: Project, target: string, path: string): void {
  mkdirSync(dirname(join(project.root, path)), { recursive: true });
  symlinkSync(target, join(project.root, path));
}

/** A direct dependency, linked at `node_modules/@antelopejs/interface-database`. */
function direct(project: Project): void {
  project.write("src/novels.ts", NOVELS);
  link(
    project,
    interfaceDatabase,
    "node_modules/@antelopejs/interface-database",
  );
}

/** pnpm's layout when only `@acme/tables` depends on interface-database: the package sits in the store, never at `node_modules/@antelopejs`. */
function transitive(project: Project): void {
  const tables = "node_modules/.pnpm/@acme+tables@1.0.0/node_modules";
  project.write(
    `${tables}/@acme/tables/package.json`,
    JSON.stringify({ name: "@acme/tables", types: "index.d.ts" }),
  );
  project.write(`${tables}/@acme/tables/index.d.ts`, NOVELS);
  link(project, interfaceDatabase, `${tables}/@antelopejs/interface-database`);
  link(
    project,
    interfaceDatabase,
    "node_modules/.pnpm/@antelopejs+interface-database@0.4.0/node_modules/@antelopejs/interface-database",
  );
  link(
    project,
    join(project.root, tables, "@acme/tables"),
    "node_modules/@acme/tables",
  );
  project.write("src/novels.ts", `export { novels } from "@acme/tables";\n`);
}

function reported(source: string, install = direct): number[] {
  const project = lintProject(true);
  try {
    project.write(
      "package.json",
      JSON.stringify({ name: "consumer", type: "module" }),
    );
    project.write("src/count.ts", source);
    install(project);
    const { diagnostics } = project.run();
    return diagnostics
      .filter((diagnostic: { code: string }) => diagnostic.code === RULE)
      .map(
        (diagnostic: { labels: { span: { line: number } }[] }) =>
          diagnostic.labels[0].span.line,
      );
  } finally {
    project.remove();
  }
}

test("an async function or arrow that returns an unrun interface-database query, alone or in a union, is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => novels.count();
export async function total() {
  return novels.count();
}
export const maybe = async (fresh: boolean) => (fresh ? novels.count() : null);
`),
    [3, 5, 7],
  );
});

test("a then, catch or finally callback that returns an unrun interface-database query is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const counted = Promise.resolve().then(() => novels.count());
export const recovered = Promise.resolve().catch(() => novels.count());
export const settled = Promise.resolve().finally(() => novels.count());
export const total = Promise.resolve().then(function () {
  return novels.count();
});
`),
    [3, 4, 5, 7],
  );
});

test("an async function that returns an unrun query behind Promise.resolve is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => Promise.resolve(novels.count());
`),
    [3],
  );
});

test("an async function that returns unrun queries in an array or a tuple is reported, not the sync callback that builds them", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const counts = async () => [novels.count()];
export async function pair() {
  return [novels.count(), 1] as const;
}
export const mapped = async () =>
  [1].map(() => {
    return novels.count();
  });
`),
    [3, 5, 8],
  );
});

test("an async function that returns an unrun query in an object literal, or nested in object literals and arrays, is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const totals = async () => ({ total: novels.count() });
export const page = async () => ({ page: { items: [novels.count()] } });
`),
    [3, 4],
  );
});

test("a named function handed to then that returns an unrun query is reported once", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

function countNovels() {
  return novels.count();
}
async function countLater() {
  return novels.count();
}
export const counted = Promise.resolve().then(countNovels);
export const later = Promise.resolve().then(countLater);
`),
    [7, 9],
  );
});

test("resolve called with an unrun query in a new Promise executor is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const counted = new Promise((resolve) => {
  resolve(novels.count());
});
`),
    [4],
  );
});

test("an async function that returns an unrun query held by an interface or an object type alias is reported", () => {
  assert.deepEqual(
    reported(`import type { Datum } from "@antelopejs/interface-database";
import { novels } from "./novels.ts";

interface Totals {
  total: Datum<number>;
}
type Page = { totals: Totals };
function build(): Totals {
  return { total: novels.count() };
}
export const totals = async () => build();
export async function page(): Promise<Page> {
  const result: Page = { totals: build() };
  return result;
}
`),
    [11, 14],
  );
});

test("resolve called with an unrun query in a named executor handed to new Promise is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

function countNovels(resolve: (value: unknown) => void) {
  resolve(novels.count());
}
const countLater = (resolve: (value: unknown) => void) => {
  resolve(novels.count());
};
export const counted = new Promise(countNovels);
export const later = new Promise(countLater);
`),
    [4, 7],
  );
});

test("an interface-typed handle or a class instance holding a table, and a function never handed to new Promise, are not reported", () => {
  assert.deepEqual(
    reported(`import type { Table } from "@antelopejs/interface-database";
import { novels } from "./novels.ts";

interface Database {
  novels: Table<{ title: string }>;
}
interface Shelf extends Table<{ title: string }> {
  shelf: number;
}
declare const shelf: Shelf;
declare const tagged: Table<{ title: string }> & { tag: string };
class Repository {
  novels = novels;
  pending = novels.count();
}
function open(): Database {
  return { novels };
}
export const database = async () => open();
export const repository = async () => new Repository();
export const literal = async () => ({ novels, shelf, tagged });
function report(send: (value: unknown) => void) {
  send(novels.count());
}
export const reported = report;
`),
    [],
  );
});

test("run queries in each wrapper, reject or another callee in an executor and a sync function's wrapped query are not reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => Promise.resolve(novels.count().run());
export const counts = async () => [novels.count().run()];
export const totals = async () => ({ total: await novels.count().run() });
export const wrapped = () => ({ total: novels.count() });
function countNovels() {
  return novels.count().run();
}
export const counted = Promise.resolve().then(countNovels);
function keep(query: unknown) {
  return query;
}
export const kept = new Promise((resolve, reject) => {
  keep(novels.count());
  reject(novels.count());
  resolve(novels.count().run());
});
`),
    [],
  );
});

test("a run query, a query a sync function returns, and another object with run() are not reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => novels.count().run();
export const counted = Promise.resolve().then(() => novels.count().run());
export const countQuery = () => novels.count();
class Job {
  run(): Promise<void> {
    return Promise.resolve();
  }
}
export const job = async () => new Job();
`),
    [],
  );
});

test("an unrun query is reported where interface-database is only a transitive dependency in pnpm's store", () => {
  assert.deepEqual(
    reported(
      `import { novels } from "./novels.ts";

export const count = async () => novels.count();
`,
      transitive,
    ),
    [3],
  );
});
