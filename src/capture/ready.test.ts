import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { type ReadyPage, waitForReady } from "./ready.ts";

const QUICK = { timeoutMs: 2_000, quietMs: 100, pollMs: 10 };

/** A page whose app, requests and fonts the test moves by hand, as a browser would over time. */
class FakePage implements ReadyPage {
  mounted = false;
  fontLoader = (): Promise<void> => Promise.resolve();
  private readonly pending = new Set<string>();
  private last = Date.now();
  lastEndedAt = 0;

  start(url: string): void {
    this.pending.add(url);
    this.last = Date.now();
  }

  end(url: string): void {
    this.pending.delete(url);
    this.last = Date.now();
    this.lastEndedAt = this.last;
  }

  pendingRequests(): string[] {
    return [...this.pending];
  }

  lastRequestAt(): number {
    return this.last;
  }

  appReady(): Promise<boolean> {
    return Promise.resolve(this.mounted);
  }

  loadFonts(): Promise<void> {
    return this.fontLoader();
  }
}

function later(ms: number, change: () => void): void {
  setTimeout(change, ms).unref();
}

test(
  "waitForReady does not answer before the app reports it has mounted",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    later(400, () => {
      page.mounted = true;
    });
    await waitForReady(page, QUICK);
    assert.equal(page.mounted, true);
  },
);

test(
  "waitForReady answers once the app has mounted and the network is quiet",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    page.mounted = true;
    const started = Date.now();
    await waitForReady(page, QUICK);
    assert.ok(Date.now() - started < 1_000);
  },
);

test(
  "waitForReady waits until the network has been quiet for the whole window after the last request",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    page.mounted = true;
    page.start("/src/main.ts");
    later(150, () => page.end("/src/main.ts"));
    later(200, () => page.start("/src/pages/onboarding.vue"));
    later(350, () => page.end("/src/pages/onboarding.vue"));
    await waitForReady(page, QUICK);
    assert.deepEqual(page.pendingRequests(), []);
    assert.ok(page.lastEndedAt > 0);
    assert.ok(Date.now() - page.lastEndedAt >= QUICK.quietMs);
  },
);

test(
  "waitForReady waits for the fonts the page uses, and for the requests their loading makes",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    page.mounted = true;
    let fontsLoaded = false;
    page.fontLoader = async () => {
      if (fontsLoaded) return;
      page.start("/fonts/geist.woff2");
      await sleep(300);
      page.end("/fonts/geist.woff2");
      fontsLoaded = true;
    };
    await waitForReady(page, QUICK);
    assert.equal(fontsLoaded, true);
    assert.ok(Date.now() - page.lastEndedAt >= QUICK.quietMs);
  },
);

test(
  "waitForReady fails within its bound when a request never ends, and names it",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    page.mounted = true;
    page.start("/api/events");
    const started = Date.now();
    await assert.rejects(
      waitForReady(page, { ...QUICK, timeoutMs: 500 }),
      /did not settle within 0\.5s: 1 request still in flight: \/api\/events/,
    );
    assert.ok(Date.now() - started < 1_500);
  },
);

test(
  "waitForReady fails within its bound when the app never reports it has mounted",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    await assert.rejects(
      waitForReady(page, { ...QUICK, timeoutMs: 500 }),
      /did not settle within 0\.5s: the app never set data-dms-ready/,
    );
  },
);

test(
  "waitForReady fails within its bound when the fonts never finish loading",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    page.mounted = true;
    page.fontLoader = () => new Promise(() => undefined);
    const started = Date.now();
    await assert.rejects(
      waitForReady(page, { ...QUICK, timeoutMs: 500 }),
      /did not settle within 0\.5s: the fonts were still loading/,
    );
    assert.ok(Date.now() - started < 1_500);
  },
);

test(
  "waitForReady fails within its bound when requests never stop starting",
  { timeout: 5_000 },
  async () => {
    const page = new FakePage();
    page.mounted = true;
    const timer = setInterval(() => {
      page.start("/poll");
      page.end("/poll");
    }, 20);
    try {
      await assert.rejects(
        waitForReady(page, { ...QUICK, timeoutMs: 500 }),
        /did not settle within 0\.5s: the network was never quiet for 100ms/,
      );
    } finally {
      clearInterval(timer);
    }
  },
);
