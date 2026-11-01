import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { playScene, type ScenePage } from "./browser.ts";
import type { CaptureScene, CaptureStep } from "./scenes.ts";

const MOUNT_MS = 200;

/**
 * A DMS page as the browser gets it: the server-rendered markup at `load`, and the app mounted
 * `MOUNT_MS` later. Each step records whether it acted on the mounted app; one that acts on the
 * server-rendered markup is lost when the app mounts, or submits the form natively.
 */
class DmsPage implements ScenePage {
  mounted = false;
  readonly acted: { step: CaptureStep; onApp: boolean }[] = [];

  open(): Promise<void> {
    this.mounted = false;
    setTimeout(() => {
      this.mounted = true;
    }, MOUNT_MS).unref();
    return Promise.resolve();
  }

  perform(step: CaptureStep): Promise<void> {
    this.acted.push({ step, onApp: this.mounted });
    return Promise.resolve();
  }

  async ready(): Promise<void> {
    while (!this.mounted) await sleep(10);
  }

  shoot(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.mounted ? "app" : "markup"));
  }
}

const STEPS: CaptureStep[] = [
  { action: "fill", selector: 'input[name="name"]', value: "Helio" },
  { action: "click", selector: 'button:has-text("Continue")' },
];

function scene(setup: boolean): CaptureScene {
  return {
    id: "onboarding",
    route: "/onboarding",
    viewport: { width: 1440, height: 900 },
    steps: STEPS,
    setup,
  };
}

for (const setup of [true, false])
  test(`the steps of a ${setup ? "setup" : "screenshot"} scene act on the mounted app, not on the server-rendered page`, async () => {
    const page = new DmsPage();
    await playScene(page, scene(setup));
    assert.deepEqual(
      page.acted,
      STEPS.map((step) => ({ step, onApp: true })),
    );
  });

test("a screenshot scene shoots the mounted app", async () => {
  const shot = await playScene(new DmsPage(), scene(false));
  assert.equal(shot?.toString(), "app");
});
