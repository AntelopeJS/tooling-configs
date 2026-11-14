import { lintProject } from "./lint-project.ts";

const UNSAFE = /\(no-unsafe-(?:assignment|argument|return|any-in-vue)\)$/;

/** A strict tsconfig that lists the components under `app/` and the TypeScript files under `src/`. */
export const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    types: [],
  },
  include: ["app/**/*.vue", "src/**/*.ts"],
});

interface Diagnostic {
  code: string;
  filename: string;
  labels: { span: { line: number } }[];
}

/** Each `typescript/no-unsafe-*` and `antelopejs/no-unsafe-any-in-vue` diagnostic oxlint reports on `files`, as `<file>:<line> <code>`, sorted. */
export function unsafeFindings(files: Record<string, string>): string[] {
  const project = lintProject(true);
  try {
    for (const [path, source] of Object.entries(files))
      project.write(path, source);
    const { diagnostics }: { diagnostics: Diagnostic[] } = project.run();
    return diagnostics
      .filter(
        (diagnostic) =>
          UNSAFE.test(diagnostic.code) &&
          Object.hasOwn(files, diagnostic.filename),
      )
      .map(
        (diagnostic) =>
          `${diagnostic.filename}:${diagnostic.labels[0]?.span.line} ${diagnostic.code}`,
      )
      .toSorted();
  } finally {
    project.remove();
  }
}

/** The lines, one per diagnostic and sorted, that tsgolint reports on `source` as `src/<name>.ts` and that the rule reports on it as the script setup of `app/<name>.vue`. */
export function parityLines(name: string, source: string) {
  const ts = `src/${name}.ts`;
  const vue = `app/${name}.vue`;
  const found = unsafeFindings({
    "tsconfig.json": tsconfig,
    [ts]: `${source}export {};\n`,
    [vue]: `<script setup lang="ts">${source}</script>\n`,
  });
  const lines = (file: string) =>
    found
      .flatMap((entry) =>
        entry.startsWith(`${file}:`) ? [Number(entry.split(/[: ]/)[1])] : [],
      )
      .toSorted((a, b) => a - b);
  return { ts: lines(ts), vue: lines(vue) };
}
