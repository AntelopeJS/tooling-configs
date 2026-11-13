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

test("an async arrow that returns an unrun interface-database query is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => novels.count();
export async function total() {
  return novels.count();
}
`),
    [3, 5],
  );
});

test("a .then callback that returns an unrun interface-database query is reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const counted = Promise.resolve().then(() => novels.count());
`),
    [3],
  );
});

test("a query run before it is returned, or returned by a plain builder, is not reported", () => {
  assert.deepEqual(
    reported(`import { novels } from "./novels.ts";

export const count = async () => novels.count().run();
export const counted = Promise.resolve().then(() => novels.count().run());
export const countQuery = () => novels.count();
`),
    [],
  );
});
