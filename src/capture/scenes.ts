import {
  children,
  isObject,
  list,
  optNum,
  optStr,
  type JsonObject,
  type JsonValue,
} from "../garden/json.ts";

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GUIDE_VIEWPORT: CaptureViewport = { width: 1440, height: 900 };

/** The size of the browser window a scene is captured in, in CSS pixels. */
export interface CaptureViewport {
  width: number;
  height: number;
}

/** One action the browser performs to reach the state a scene shows. */
export type CaptureStep =
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; key: string }
  | { action: "wait"; selector: string };

/**
 * A scene as a `docs/captures.ts` declares it. A screenshot scene writes `output`, a `.webp` path
 * relative to the repository root. A setup scene (`setup: true`, such as the onboarding that
 * creates the administrator) runs its steps once, before any screenshot, and writes nothing.
 */
export interface CaptureSceneInput {
  id: string;
  route: string;
  viewport?: CaptureViewport;
  steps?: CaptureStep[];
  /** A selector: the screenshot is cropped to the element it matches. */
  crop?: string;
  output?: string;
  setup?: boolean;
}

/** A scene with every default filled in. */
export interface CaptureScene {
  id: string;
  route: string;
  viewport: CaptureViewport;
  steps: CaptureStep[];
  crop?: string;
  output?: string;
  setup: boolean;
}

/** Types the `docs/captures.ts` default export: `export default defineScenes([...])`. */
export function defineScenes(scenes: CaptureSceneInput[]): CaptureSceneInput[] {
  return scenes;
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value === "") throw new Error(message);
  return value;
}

function parseStep(step: JsonObject, index: number): CaptureStep {
  const label = `step ${index + 1}`;
  const action = optStr(step, "action");
  if (action === "press")
    return {
      action,
      key: required(optStr(step, "key"), `${label} needs a key`),
    };
  if (action !== "click" && action !== "fill" && action !== "wait")
    throw new Error(`${label} has an unknown action ${JSON.stringify(action)}`);
  const selector = required(
    optStr(step, "selector"),
    `${label} needs a selector`,
  );
  if (action !== "fill") return { action, selector };
  const value = optStr(step, "value");
  if (value === undefined) throw new Error(`${label} needs a value`);
  return { action, selector, value };
}

function parseViewport(source: JsonObject): CaptureViewport {
  if (!Object.hasOwn(source, "viewport")) return GUIDE_VIEWPORT;
  const { viewport } = source;
  const [width, height] = isObject(viewport)
    ? [optNum(viewport, "width"), optNum(viewport, "height")]
    : [undefined, undefined];
  if (
    width === undefined ||
    height === undefined ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("viewport needs a positive width and height");
  return { width, height };
}

function parseOutput(source: JsonObject, setup: boolean): string | undefined {
  const output = optStr(source, "output");
  if (setup) {
    if (Object.hasOwn(source, "output"))
      throw new Error("a setup scene takes no output");
    return undefined;
  }
  if (output === undefined || output === "")
    throw new Error("a screenshot scene needs an output");
  if (!output.endsWith(".webp")) throw new Error("output must be a .webp path");
  if (output.startsWith("/") || output.split("/").includes(".."))
    throw new Error("output must stay inside the repository");
  return output;
}

function parseScene(entry: JsonValue, position: number): CaptureScene {
  if (!isObject(entry)) throw new Error(`scene ${position} is not an object`);
  const id = optStr(entry, "id");
  if (id === undefined || !KEBAB_CASE.test(id))
    throw new Error(`scene id ${JSON.stringify(id)} is not kebab-case`);
  try {
    const route = optStr(entry, "route");
    if (route === undefined || !route.startsWith("/"))
      throw new Error('route must start with "/"');
    const setup = entry.setup === true;
    const scene: CaptureScene = {
      id,
      route,
      viewport: parseViewport(entry),
      steps: Object.hasOwn(entry, "steps")
        ? children(entry, "steps").map(parseStep)
        : [],
      setup,
    };
    const crop = optStr(entry, "crop");
    if (crop !== undefined && crop !== "") scene.crop = crop;
    const output = parseOutput(entry, setup);
    if (output !== undefined) scene.output = output;
    return scene;
  } catch (error) {
    throw new Error(
      `scene ${JSON.stringify(id)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Validates what `docs/captures.ts` exports, so a mistyped scene fails with its id and field. */
export function parseScenes(raw: JsonValue): CaptureScene[] {
  if (!Array.isArray(raw))
    throw new Error("docs/captures.ts must export an array of scenes");
  const scenes = list(raw, "scenes").map((entry, index) =>
    parseScene(entry, index + 1),
  );
  const ids = new Map<string, CaptureScene>();
  const outputs = new Map<string, CaptureScene>();
  for (const scene of scenes) {
    if (ids.has(scene.id))
      throw new Error(`scene id ${JSON.stringify(scene.id)} appears twice`);
    ids.set(scene.id, scene);
    if (scene.output === undefined) continue;
    const other = outputs.get(scene.output);
    if (other)
      throw new Error(
        `scenes ${JSON.stringify(other.id)} and ${JSON.stringify(scene.id)} both write ${scene.output}`,
      );
    outputs.set(scene.output, scene);
  }
  return scenes;
}

/** The scenes a run executes: every setup scene first, then the screenshot scene asked for, or all of them. */
export function selectScenes(
  scenes: CaptureScene[],
  id: string | undefined,
): CaptureScene[] {
  if (id !== undefined && !scenes.some((scene) => scene.id === id))
    throw new Error(
      `no scene ${JSON.stringify(id)}; the scenes are ${scenes
        .map((scene) => scene.id)
        .sort()
        .join(", ")}`,
    );
  return [
    ...scenes.filter((scene) => scene.setup),
    ...scenes.filter(
      (scene) => !scene.setup && (id === undefined || scene.id === id),
    ),
  ];
}
