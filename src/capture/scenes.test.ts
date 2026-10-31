import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "../garden/json.ts";
import { parseScenes, selectScenes } from "./scenes.ts";

const GUIDE = {
  id: "dashboard-overview",
  route: "/home",
  output: "docs/images/dashboard-overview.webp",
};

test("a scene gets the guide viewport, no steps and the screenshot role by default", () => {
  const [scene] = parseScenes([GUIDE]);
  assert.deepEqual(scene, {
    ...GUIDE,
    viewport: { width: 1440, height: 900 },
    steps: [],
    setup: false,
  });
});

test("a scene keeps its steps, crop selector and viewport", () => {
  const steps: JsonValue[] = [
    { action: "click", selector: "text=Sales" },
    { action: "fill", selector: "input[name=q]", value: "Enerlux" },
    { action: "press", key: "Enter" },
    { action: "wait", selector: "table" },
  ];
  const [scene] = parseScenes([
    { ...GUIDE, steps, crop: "main", viewport: { width: 390, height: 844 } },
  ]);
  assert.deepEqual(scene?.steps, steps);
  assert.equal(scene?.crop, "main");
  assert.deepEqual(scene?.viewport, { width: 390, height: 844 });
});

test("a setup scene has steps and no output", () => {
  const [scene] = parseScenes([
    {
      id: "onboarding",
      route: "/",
      setup: true,
      steps: [{ action: "click", selector: "button" }],
    },
  ]);
  assert.equal(scene?.setup, true);
  assert.equal(scene?.output, undefined);
});

test("parseScenes names the scene and the field it refuses", () => {
  const refused: Array<[JsonValue, RegExp]> = [
    [
      { ...GUIDE, id: "Dashboard Overview" },
      /id "Dashboard Overview" is not kebab-case/,
    ],
    [
      { ...GUIDE, route: "home" },
      /scene "dashboard-overview": route must start with "\/"/,
    ],
    [
      { ...GUIDE, output: "docs/images/overview.png" },
      /scene "dashboard-overview": output must be a \.webp path/,
    ],
    [
      { ...GUIDE, output: "../outside.webp" },
      /scene "dashboard-overview": output must stay inside the repository/,
    ],
    [
      { ...GUIDE, output: "/etc/overview.webp" },
      /scene "dashboard-overview": output must stay inside the repository/,
    ],
    [
      { id: "no-output", route: "/" },
      /scene "no-output": a screenshot scene needs an output/,
    ],
    [
      { ...GUIDE, setup: true },
      /scene "dashboard-overview": a setup scene takes no output/,
    ],
    [
      { ...GUIDE, steps: [{ action: "hover", selector: "a" }] },
      /scene "dashboard-overview": step 1 has an unknown action "hover"/,
    ],
    [
      { ...GUIDE, steps: [{ action: "click" }] },
      /scene "dashboard-overview": step 1 needs a selector/,
    ],
    [
      { ...GUIDE, viewport: { width: 0, height: 900 } },
      /scene "dashboard-overview": viewport needs a positive width and height/,
    ],
    ["not a scene", /scene 1 is not an object/],
  ];
  for (const [input, message] of refused)
    assert.throws(() => parseScenes([input]), message);
});

test("parseScenes refuses a repeated id and a list that is not an array", () => {
  assert.throws(
    () => parseScenes([GUIDE, { ...GUIDE, output: "docs/images/other.webp" }]),
    /scene id "dashboard-overview" appears twice/,
  );
  assert.throws(
    () => parseScenes({}),
    /docs\/captures\.ts must export an array of scenes/,
  );
});

test("parseScenes refuses two scenes writing the same file", () => {
  assert.throws(
    () => parseScenes([GUIDE, { ...GUIDE, id: "other" }]),
    /scenes "dashboard-overview" and "other" both write docs\/images\/dashboard-overview\.webp/,
  );
});

test("selectScenes runs the setup scenes first, then the one asked for", () => {
  const scenes = parseScenes([
    GUIDE,
    { id: "onboarding", route: "/", setup: true },
    { id: "sales", route: "/sales", output: "docs/images/sales.webp" },
  ]);
  assert.deepEqual(
    selectScenes(scenes, undefined).map((scene) => scene.id),
    ["onboarding", "dashboard-overview", "sales"],
  );
  assert.deepEqual(
    selectScenes(scenes, "sales").map((scene) => scene.id),
    ["onboarding", "sales"],
  );
  assert.throws(
    () => selectScenes(scenes, "billing"),
    /no scene "billing"; the scenes are dashboard-overview, onboarding, sales/,
  );
});
