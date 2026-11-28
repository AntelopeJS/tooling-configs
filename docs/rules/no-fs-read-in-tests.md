# `antelopejs/no-fs-read-in-tests`

A test that reads source files asserts the text of the code, so it passes while the behaviour is broken and fails when only the wording changes.

## What it flags

In a test file (`*.test.*`, `*.spec.*`, or a file under `test/`, `tests/` or `__tests__/`):

- A `readFileSync` or `readdirSync` imported from `fs` or `node:fs`, such as `import { readFileSync } from "node:fs"`.
- A call through an `fs` namespace or default import, or through `require("fs")`, such as `fs.readFileSync(...)`.
- `readFileSync` or `readdirSync` destructured from `require("node:fs")`.

These pass:

- Files under `fixtures/`, `helpers/` and `locales/`, which may read files.
- `import type` from `fs`, and the `fs` functions a test uses to set up a temporary directory, such as `mkdtempSync` and `writeFileSync`.

## Fix

Import the module under test and assert what it returns or does. When a test needs file content as input, such as a sample payload or a locale file, move the read into a helper under `fixtures/` or `helpers/` and import that helper from the test.

## Example

```ts fragment [src/greeting.ts]
export function greeting(name: string): string {
  return `Hello, ${name}`;
}
```

```ts flagged fragment [test/greeting.test.ts]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("greeting", () => {
  it("says hello to the name it gets", () => {
    const source = readFileSync("src/greeting.ts", "utf8");
    assert.match(source, /Hello/u);
  });
});
```

```ts fixed fragment [test/greeting.test.ts]
import assert from "node:assert/strict";

import { greeting } from "../src/greeting.js";

describe("greeting", () => {
  it("says hello to the name it gets", () => {
    assert.equal(greeting("Ada"), "Hello, Ada");
  });
});
```
