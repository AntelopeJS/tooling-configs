import type { BrowserContext } from "playwright-core";

import type { CaptureScene, CaptureViewport } from "./scenes.ts";

/** The cookies and storage of a browser context, as Playwright saves and restores them. */
export type SessionState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** The browser the scenes play in: `playwrightScenes` backs it with Playwright. */
export interface SceneBrowser<Context> {
  /** Opens a context at `viewport`, seeded with `session`, or empty without one. */
  open(
    viewport: CaptureViewport,
    session: SessionState | undefined,
  ): Promise<Context>;
  /** Answers the session the context holds now. */
  save(context: Context): Promise<SessionState>;
  /** Plays the scene on a new page of the context and answers its PNG; a setup scene answers nothing. */
  render(context: Context, scene: CaptureScene): Promise<Buffer | undefined>;
  close(context: Context): Promise<void>;
}

/** Answers the failure of a shot, if it has one: `settle` writes or compares it. */
export type KeepShot = (
  scene: CaptureScene,
  png: Buffer,
) => Promise<string | undefined>;

/** Runs one scene's work and answers its failure line, if it has one. */
async function failureIn(
  scene: CaptureScene,
  work: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    return await work();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `scene ${scene.id}: ${reason.split("\n")[0]}`;
  }
}

/** Plays the setup scenes in one context and answers the session they leave, or none without setup scenes. */
async function setUp<Context>(
  browser: SceneBrowser<Context>,
  scenes: CaptureScene[],
  failures: string[],
): Promise<SessionState | undefined> {
  const [first] = scenes;
  if (first === undefined) return undefined;
  const context = await browser.open(first.viewport, undefined);
  try {
    for (const scene of scenes) {
      const failure = await failureIn(scene, async () => {
        await browser.render(context, scene);
        return undefined;
      });
      if (failure !== undefined) failures.push(failure);
    }
    return await browser.save(context);
  } finally {
    await browser.close(context);
  }
}

/**
 * Plays the setup scenes in one context, then each screenshot scene in a fresh context seeded with the
 * session the setup left, or empty when the scene is `signedOut`, so no scene sees what another changed.
 * Answers the failures, one line per scene.
 */
export async function playScenes<Context>(
  browser: SceneBrowser<Context>,
  scenes: CaptureScene[],
  keep: KeepShot,
): Promise<string[]> {
  const failures: string[] = [];
  const session = await setUp(
    browser,
    scenes.filter((scene) => scene.setup),
    failures,
  );
  for (const scene of scenes.filter((each) => !each.setup)) {
    const failure = await failureIn(scene, async () => {
      const context = await browser.open(
        scene.viewport,
        scene.signedOut ? undefined : session,
      );
      try {
        const png = await browser.render(context, scene);
        return png === undefined ? undefined : await keep(scene, png);
      } finally {
        await browser.close(context);
      }
    });
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}
