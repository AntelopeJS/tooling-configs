import { chromeStable, withSystemLibs } from "./paths.mjs";
import { VIEWPORT } from "./steps.mjs";

const ACTION_TIMEOUT_MS = 15_000;

/**
 * @param {"shell" | "chrome157"} variant Which browser Playwright drives
 * @returns {Record<string, unknown>} Options for `chromium.launch`
 */
export function launchOptions(variant) {
  if (variant === "shell") return { headless: true };
  return {
    headless: true,
    executablePath: chromeStable(),
    env: withSystemLibs(process.env),
  };
}

/** @returns {Record<string, unknown>} Context options that dms-control uses */
export const contextOptions = () => ({
  viewport: VIEWPORT,
  locale: "en-US",
  colorScheme: "light",
});

/**
 * Runs one step on a page, the way browser.mjs does: ARIA role and name
 * locators, `ariaSnapshot` of the body, `page.screenshot`.
 *
 * @param {import("playwright-core").Page} page The page
 * @param {Record<string, any>} step The step
 * @param {string} baseUrl The site
 * @param {string} pngPath Where a screenshot goes
 * @returns {Promise<{ text?: string, value?: unknown, path?: string }>} The outcome
 */
export async function runPwStep(page, step, baseUrl, pngPath) {
  const target = () =>
    page.getByRole(step.role, { name: step.name, exact: true });
  switch (step.op) {
    case "goto":
      await page.goto(new URL(step.path, baseUrl).href, {
        waitUntil: "load",
        timeout: 60_000,
      });
      return {};
    case "snapshot":
      return {
        text: await page
          .locator("body")
          .ariaSnapshot({ timeout: ACTION_TIMEOUT_MS }),
      };
    case "click":
      await target().click({ timeout: ACTION_TIMEOUT_MS });
      return {};
    case "fill":
      await target().fill(step.value, { timeout: ACTION_TIMEOUT_MS });
      return {};
    case "press":
      await page.keyboard.press(step.key);
      return {};
    case "waitUrl":
      await page.waitForURL(step.glob, { timeout: ACTION_TIMEOUT_MS });
      return {};
    case "waitText":
      await page
        .getByText(step.text)
        .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
      return {};
    case "screenshot":
      await page.screenshot({
        path: pngPath,
        fullPage: step.full,
        timeout: ACTION_TIMEOUT_MS,
      });
      return { path: pngPath };
    case "eval":
      return { value: (await page.evaluate(step.js)) ?? null };
    case "url":
      return { value: page.url() };
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}
