import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Writes `files` into a fresh checkout directory removed after the test. */
export function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "docs-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  return { root, write };
}

/** Renders a fenced code block with surrounding blank lines. */
export const fence = (language, code) =>
  `\n\n\`\`\`${language}\n${code}\n\`\`\`\n`;
/** A checkout with a NodeNext package, a strict tsconfig, and a linked TypeScript. */
export function typescriptFixture(t, text, files = {}) {
  const setup = fixture(t, {
    "README.md": text,
    "package.json": '{"type":"module"}',
    "src/value.ts":
      "export const answer: number = 42; export type Answer = number;",
    "src/index.ts": 'export { answer, type Answer } from "./value.js";',
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "NodeNext",
        target: "ES2022",
        types: [],
        skipLibCheck: true,
        noCheck: true,
      },
      include: ["src/**/*.ts"],
    }),
    ...files,
  });
  mkdirSync(join(setup.root, "node_modules"));
  const require = createRequire(import.meta.url);
  symlinkSync(
    dirname(require.resolve("typescript/package.json")),
    join(setup.root, "node_modules/typescript"),
    "dir",
  );
  return setup;
}
