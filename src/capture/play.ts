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

/** Plays the scenes in order and answers the failures, one line per scene. */
export async function playScenes<Context>(
  browser: SceneBrowser<Context>,
  scenes: CaptureScene[],
  keep: KeepShot,
): Promise<string[]> {
  const failures: string[] = [];
  const context = await browser.open(
    scenes[0]?.viewport ?? { width: 1440, height: 900 },
    undefined,
  );
  for (const scene of scenes) {
    try {
      const png = await browser.render(context, scene);
      if (png === undefined) continue;
      const failure = await keep(scene, png);
      if (failure !== undefined) failures.push(failure);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`scene ${scene.id}: ${reason.split("\n")[0]}`);
    }
  }
  await browser.close(context);
  return failures;
}
