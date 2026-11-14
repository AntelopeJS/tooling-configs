import assert from "node:assert/strict";
import { test } from "node:test";

import { declaresTypeParameters, scriptView } from "./vue-script.ts";

const COMPONENT = `<template>
  <p>é😀</p>
</template>
<script lang="ts">
export const a = 1;
</script>
<script setup lang="ts" data-note="a > b">
const b = 2;
</script>
<style>
p { color: red }
</style>
`;

test("the view keeps the contents of every script block at their offsets, blanks the rest, and ends as a module (fails if a `>` in an attribute ends the tag, a block is dropped, a wide character shifts the offsets, or the view can be a global script)", () => {
  const view = scriptView(COMPONENT);
  assert(view !== undefined);
  assert.deepEqual(
    view.split("\n").map((line) => line.trim()),
    [
      "",
      "",
      "",
      "",
      "export const a = 1;",
      "",
      "",
      "const b = 2;",
      "",
      "",
      "",
      "",
      "",
      "export {};",
      "",
    ],
  );
  assert.equal(
    view.indexOf("const b"),
    COMPONENT.indexOf("const b"),
    "an offset in the view is the same offset in the component",
  );
});

test("a script tag inside a comment is no block (fails if every `<script` opens a block)", () => {
  const commented = "<!-- <script>const hidden = 1;</script> -->\n";
  const view = scriptView(
    `${commented}<script setup>\nconst shown = 1;\n</script>\n`,
  );
  assert.equal(view?.includes("hidden"), false);
  assert.equal(view?.includes("const shown = 1;"), true);
});

test("a text with no script block, as oxlint passes a component's script alone, has no view (fails if oxlint's text is read as a component)", () => {
  assert.equal(scriptView("const shown = 1;\n"), undefined);
  assert.equal(
    scriptView("<!-- <script>const hidden = 1;</script> -->\n"),
    undefined,
  );
});

test("a component with `generic` type parameters keeps its view and is known to declare them (fails if the view drops it, or the attribute goes unseen)", () => {
  const generic =
    '<script setup lang="ts" generic="T extends { name: string }">\nconst b = 2;\n</script>\n';
  assert.equal(scriptView(generic)?.includes("const b = 2;"), true);
  assert.equal(declaresTypeParameters(generic), true);
  assert.equal(declaresTypeParameters(COMPONENT), false);
});
