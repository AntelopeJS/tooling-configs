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

test("a run query, a query a sync function returns, and another object with run() are not reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => novels.count().run();
export const counted = Promise.resolve().then(() => novels.count().run());
export const countQuery = () => novels.count();
export const counts = async () => [1].map(() => novels.count());
export const listed = async () =>
  [1].map(() => {
    return novels.count();
  });
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
