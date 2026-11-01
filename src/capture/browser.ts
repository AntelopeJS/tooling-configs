import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import type sharp from "sharp";

import { DEMO_NOW } from "./demo.ts";
import type { RawImage } from "./compare.ts";
import type { CaptureScene } from "./scenes.ts";
import { type ReadyOptions, type ReadyPage, waitForReady } from "./ready.ts";

const DEVICE_SCALE_FACTOR = 2;
const STEP_TIMEOUT_MS = 30_000;
/** Requests that stay open for as long as the page does, so the network is quiet without them. */
const STREAMS = new Set(["eventsource", "websocket"]);
const READY: ReadyOptions = { timeoutMs: 60_000, quietMs: 500, pollMs: 50 };

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

/** Loads every face the text of the page uses, its form fields included, for the characters it shows. */
async function loadUsedFonts(): Promise<void> {
  const used = new Map<string, Set<string>>();
  const add = (element: Element, text: string): void => {
    if (!text.trim()) return;
    const style = getComputedStyle(element);
    const font = `${style.fontStyle} ${style.fontWeight} 16px ${style.fontFamily}`;
    const characters = used.get(font) ?? new Set<string>();
    for (const character of text) characters.add(character);
    used.set(font, characters);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.parentElement) add(node.parentElement, node.textContent ?? "");
  for (const field of document.querySelectorAll("input, textarea"))
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement
    )
      add(field, `${field.value}${field.placeholder}`);
  await Promise.all(
    [...used].map(([font, characters]) =>
      document.fonts.load(font, [...characters].join("")),
    ),
  );
  await document.fonts.ready;
}

/** Follows the page's requests, event streams aside, from now on, so call it before the page navigates. */
function watchPage(page: Page): ReadyPage {
  const pending = new Set<Request>();
  let last = Date.now();
  const started = (request: Request): void => {
    if (STREAMS.has(request.resourceType())) return;
    pending.add(request);
    last = Date.now();
  };
  const ended = (request: Request): void => {
    if (!pending.delete(request)) return;
    last = Date.now();
  };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return {
    pendingRequests: () => [...pending].map((request) => request.url()),
    lastRequestAt: () => last,
    appReady: () =>
      page.evaluate(() =>
        document.documentElement.hasAttribute("data-dms-ready"),
      ),
    loadFonts: () => page.evaluate(loadUsedFonts),
  };
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

/** Opens the scene's route, runs its steps, waits for the page to be ready, and answers the PNG of the page, or of the `crop` element. */
export async function renderScene(
  context: BrowserContext,
  baseUrl: string,
  scene: CaptureScene,
): Promise<Buffer | undefined> {
  const page = await context.newPage();
  const ready = watchPage(page);
  try {
    await page.setViewportSize(scene.viewport);
    await page.goto(new URL(scene.route, baseUrl).href, {
      waitUntil: "load",
    });
    for (const step of scene.steps) await perform(page, step);
    if (scene.setup) return undefined;
    await waitForReady(ready, READY);
    const target = scene.crop ? page.locator(scene.crop).first() : page;
    return await target.screenshot({ type: "png", animations: "disabled" });
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
