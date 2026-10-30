import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  PACKAGE_ROOT,
  bin,
  commit,
  put,
  testRepo,
} from "./helpers/test-repo.ts";

const FRONTEND = "packages/dms/frontend-vue";
const LAYER = `${FRONTEND}/layers/dms-core/app`;
const COOLDOWN = `${LAYER}/composables/useCooldown.ts`;
const CURRENT_USER = `${LAYER}/composables/useCurrentUser.ts`;
const DATA_TYPE = `${LAYER}/types/data-type.ts`;

const COOLDOWN_SOURCE = `export function useCooldown(duration: number) {
  const cooldown = ref<number>(duration);
  return { cooldown };
}
`;

const CURRENT_USER_SOURCE = `export function useCurrentUser() {
  const user = useDmsUserSession<User>();
  const label = useCooldownLabel();
  return { user, label };
}
`;

/** A frontend module reduced from AntelopeJS/dms at #526 as merged: composables call vue, dms-frontend and sibling auto-imports without importing them, as the generated Vite config lets them. */
function globalsRepo(t: Parameters<typeof testRepo>[0]): string {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(
    root,
    `${FRONTEND}/package.json`,
    JSON.stringify({ name: "frontend-vue", private: true, type: "module" }),
  );
  put(
    root,
    `${FRONTEND}/dms.frontend.build.ts`,
    'export default (build: { registerAutoImports(entries: string[]): void }) => {\n  build.registerAutoImports(["layers/*/app/composables", "layers/*/app/types"]);\n};\n',
  );
  put(
    root,
    `${FRONTEND}/node_modules/vue/package.json`,
    JSON.stringify({ name: "vue", types: "index.d.ts" }),
  );
  put(
    root,
    `${FRONTEND}/node_modules/vue/index.d.ts`,
    "export interface Ref<T> {\n  value: T;\n}\nexport interface ComputedRef<T> {\n  readonly value: T;\n}\nexport declare function ref<T>(value: T): Ref<T>;\nexport declare function computed<T>(getter: () => T): ComputedRef<T>;\n",
  );
  put(
    root,
    `${FRONTEND}/node_modules/@antelopejs/dms-frontend/package.json`,
    JSON.stringify({ name: "@antelopejs/dms-frontend" }),
  );
  put(
    root,
    `${FRONTEND}/node_modules/@antelopejs/dms-frontend/templates/vue/frontend-module.ts`,
    'import type { Ref } from "vue";\n\nexport declare function useDmsUserSession<T>(): Ref<T | null>;\n',
  );
  put(root, COOLDOWN, COOLDOWN_SOURCE);
  put(
    root,
    `${LAYER}/composables/useCooldownLabel.ts`,
    "export function useCooldownLabel() {\n  const { cooldown } = useCooldown(1);\n  return computed<string>(() => String(cooldown.value));\n}\n",
  );
  put(root, CURRENT_USER, CURRENT_USER_SOURCE);
  put(
    root,
    `${LAYER}/types/user.ts`,
    "export interface User {\n  id: string;\n  name: string;\n}\n",
  );
  put(
    root,
    `${LAYER}/types/component.ts`,
    "export interface ComponentInfo<T> {\n  name: string;\n  options: T;\n}\n",
  );
  put(
    root,
    DATA_TYPE,
    "export type ComponentOrNoInput = ComponentInfo<number> | false;\n",
  );
  commit(root);
  execFileSync("git", ["tag", "base"], { cwd: root });
  return root;
}

function apiDiff(root: string) {
  const result = bin(root, "api-diff", ["base"]);
  return { ...result, text: result.stdout + result.stderr };
}

test("api-diff types an auto-import's signature with the vue, dms-frontend and sibling auto-imports it uses unimported", (t) => {
  const root = globalsRepo(t);
  const result = apiDiff(root);
  assert.equal(result.status, 0, result.text);
  assert.match(
    result.text,
    /^Auto-imports: 1 packages, 6 entries unchanged against base/mu,
  );
});

test("api-diff fails when a composable narrows the type argument of an unimported vue ref (dms#526 useCooldown)", (t) => {
  const root = globalsRepo(t);
  put(
    root,
    COOLDOWN,
    COOLDOWN_SOURCE.replace(
      "ref<number>(duration)",
      "ref<string>(String(duration))",
    ),
  );
  commit(root);
  const result = apiDiff(root);
  assert.equal(result.status, 1, result.text);
  assert.match(
    result.text,
    /^-useCooldown \(value\): \(duration: number\) => \{ cooldown: Ref<number>; \}$/mu,
  );
  assert.match(
    result.text,
    /^\+useCooldown \(value\): \(duration: number\) => \{ cooldown: Ref<string>; \}$/mu,
  );
});

test("api-diff fails when a composable changes the type argument of an unimported dms-frontend composable (dms#526 useCurrentUser)", (t) => {
  const root = globalsRepo(t);
  put(
    root,
    CURRENT_USER,
    CURRENT_USER_SOURCE.replace(
      "useDmsUserSession<User>()",
      "useDmsUserSession<{ id: string }>()",
    ),
  );
  commit(root);
  const result = apiDiff(root);
  assert.equal(result.status, 1, result.text);
  assert.match(
    result.text,
    /^-useCurrentUser \(value\): \(\) => \{ label: ComputedRef<string>; user: Ref<User \| null>; \}$/mu,
  );
});

test("api-diff fails when an auto-imported type changes the argument of a sibling auto-imported type it names unimported (dms#526 ComponentOrNoInput)", (t) => {
  const root = globalsRepo(t);
  put(
    root,
    DATA_TYPE,
    "export type ComponentOrNoInput = ComponentInfo<string> | false;\n",
  );
  commit(root);
  const result = apiDiff(root);
  assert.equal(result.status, 1, result.text);
  assert.match(
    result.text,
    /^-ComponentOrNoInput \(type\): ComponentInfo<number> \| false$/mu,
  );
});
