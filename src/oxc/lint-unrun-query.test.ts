import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
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

function reported(source: string): number[] {
  const project = lintProject(true);
  try {
    project.write(
      "package.json",
      JSON.stringify({ name: "consumer", type: "module" }),
    );
    project.write("src/novels.ts", NOVELS);
    project.write("src/count.ts", source);
    mkdirSync(join(project.root, "node_modules/@antelopejs"), {
      recursive: true,
    });
    symlinkSync(
      interfaceDatabase,
      join(project.root, "node_modules/@antelopejs/interface-database"),
    );
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

test("a then or catch callback that returns an unrun interface-database query is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const counted = Promise.resolve().then(() => novels.count());
export const recovered = Promise.resolve().catch(() => novels.count());
export const total = Promise.resolve().then(function () {
  return novels.count();
});
`),
    [3, 4, 6],
  );
});

test("a run query, a query a sync function returns, and another object with run() are not reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => novels.count().run();
export const counted = Promise.resolve().then(() => novels.count().run());
export const countQuery = () => novels.count();
export const counts = async () => [1].map(() => novels.count());
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
