import type { Browser, BrowserContext, Page, Request } from "playwright-core";
import type sharp from "sharp";

import { DEMO_NOW } from "./demo.ts";
import type { RawImage } from "./compare.ts";
import { NetworkLog } from "./network.ts";
import type { CaptureScene, CaptureStep } from "./scenes.ts";
import { type ReadyOptions, type ReadyPage, waitForReady } from "./ready.ts";

const DEVICE_SCALE_FACTOR = 2;
const STEP_TIMEOUT_MS = 30_000;
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
  const network = new NetworkLog<Request>();
  const ended = (request: Request): void => {
    network.end(request);
  };
  page.on("request", (request) => {
    network.start(request, request.url(), request.resourceType());
  });
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return {
    pendingRequests: () => network.pendingRequests(),
    lastRequestAt: () => network.lastRequestAt(),
    appReady: () =>
      page.evaluate(() =>
        document.documentElement.hasAttribute("data-dms-ready"),
      ),
    loadFonts: () => page.evaluate(loadUsedFonts),
  };
}

async function perform(page: Page, step: CaptureStep) {
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

/** What a scene does to its page: `renderScene` backs it with a Playwright page. */
export interface ScenePage {
  /** Opens a route of the demo and answers at its `load` event. */
  open(route: string): Promise<void>;
  /** Performs one step of the scene. */
  perform(step: CaptureStep): Promise<void>;
  /** Answers once the page is ready to be shot, or fails naming what was still pending. */
  ready(): Promise<void>;
  /** Answers the PNG of the page, or of the element `crop` matches. */
  shoot(crop: string | undefined): Promise<Buffer>;
}

/**
 * Opens the scene's route, waits for the page to be ready, runs its steps, waits again, and answers its
 * PNG; a setup scene answers nothing. The `load` event comes before the app mounts, so a step taken then
 * acts on the server-rendered page: the mount drops what it filled, and a click submits its form natively.
 */
export async function playScene(
  page: ScenePage,
  scene: CaptureScene,
): Promise<Buffer | undefined> {
  await page.open(scene.route);
  await page.ready();
  for (const step of scene.steps) await page.perform(step);
  if (scene.setup) return undefined;
  await page.ready();
  return page.shoot(scene.crop);
}

/** Plays the scene on a new page of `context`, at the scene's viewport, and closes the page. */
export async function renderScene(
  context: BrowserContext,
  baseUrl: string,
  scene: CaptureScene,
): Promise<Buffer | undefined> {
  const page = await context.newPage();
  const watched = watchPage(page);
  try {
    await page.setViewportSize(scene.viewport);
    return await playScene(
      {
        open: async (route) => {
          await page.goto(new URL(route, baseUrl).href, { waitUntil: "load" });
        },
        perform: async (step) => {
          await perform(page, step);
        },
        ready: () => waitForReady(watched, READY),
        shoot: (crop) =>
          (crop ? page.locator(crop).first() : page).screenshot({
            type: "png",
            animations: "disabled",
          }),
      },
      scene,
    );
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
