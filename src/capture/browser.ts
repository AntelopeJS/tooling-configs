import type { Browser, BrowserContext, Page } from "playwright-core";
import type sharp from "sharp";

import { DEMO_NOW } from "./demo.ts";
import type { RawImage } from "./compare.ts";
import type { CaptureScene } from "./scenes.ts";

const DEVICE_SCALE_FACTOR = 2;
const STEP_TIMEOUT_MS = 30_000;

export type Sharp = typeof sharp;

/** A browser that opens every scene dark, with the clock frozen on the demo's instant, at 2x. */
export async function openContext(
  browser: Browser,
  viewport: CaptureScene["viewport"],
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "dark",
    reducedMotion: "reduce",
    locale: "en-GB",
    timezoneId: "UTC",
  });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  await context.clock.setFixedTime(new Date(DEMO_NOW));
  return context;
}

async function perform(page: Page, step: CaptureScene["steps"][number]) {
  switch (step.action) {
    case "click":
      return page.click(step.selector);
    case "fill":
      return page.fill(step.selector, step.value);
    case "press":
      return page.keyboard.press(step.key);
    case "wait":
      return page.waitForSelector(step.selector);
  }
}

/** Opens the scene's route, runs its steps, and answers the PNG of the page, or of the `crop` element. */
export async function renderScene(
  context: BrowserContext,
  baseUrl: string,
  scene: CaptureScene,
): Promise<Buffer | undefined> {
  const page = await context.newPage();
  try {
    await page.setViewportSize(scene.viewport);
    await page.goto(new URL(scene.route, baseUrl).href, {
      waitUntil: "load",
    });
    for (const step of scene.steps) await perform(page, step);
    if (scene.setup) return undefined;
    await page.evaluate(() => document.fonts.ready);
    return scene.crop
      ? await page.locator(scene.crop).first().screenshot({ type: "png" })
      : await page.screenshot({ type: "png" });
  } finally {
    await page.close();
  }
}

/** Lossless WebP, so decoding what was written gives back the pixels that were captured. */
export function encodeWebp(sharp: Sharp, png: Buffer): Promise<Buffer> {
  return sharp(png).webp({ lossless: true }).toBuffer();
}

export async function decode(sharp: Sharp, image: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}
