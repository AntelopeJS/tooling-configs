import { pathToFileURL } from "node:url";
import { PW_ENTRY } from "../lib/paths.mjs";
import { contextOptions, launchOptions, runPwStep } from "../lib/pw-ops.mjs";
import { main } from "../lib/scenario.mjs";

main((config) => {
  let browser;
  const pages = new Map();
  const pageFor = async (account) => {
    if (!pages.has(account)) {
      const context = await browser.newContext(contextOptions());
      pages.set(account, await context.newPage());
    }
    return pages.get(account);
  };
  return {
    async start(_scenario, recorder) {
      const { chromium } = await import(pathToFileURL(PW_ENTRY).href);
      browser = await recorder.step("launch", () =>
        chromium.launch(launchOptions(config.variant)),
      );
    },
    async execute(step, pngPath) {
      return runPwStep(
        await pageFor(step.account ?? "main"),
        step,
        config.baseUrl,
        pngPath,
      );
    },
    finish: () => browser.close(),
    release: async () => undefined,
    dispose: async () => {
      await browser?.close().catch(() => undefined);
    },
  };
});
