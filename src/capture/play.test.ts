import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "../garden/json.ts";
import { playScenes, type SceneBrowser, type SessionState } from "./play.ts";
import { type CaptureScene, parseScenes } from "./scenes.ts";

type Cookie = SessionState["cookies"][number];

/** A context of the fake browser: the cookies it holds, as a signed-in DMS keeps its session. */
interface FakeContext {
  cookies: Cookie[];
}

function sessionCookie(value: string): Cookie {
  return {
    name: "session",
    value,
    domain: "localhost",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  };
}

/**
 * A browser where a `fill` of `session` signs in and a click on `sign-out` clears the cookies, as a
 * DMS does. A screenshot shows the session the page sees, empty when signed out.
 */
const browser: SceneBrowser<FakeContext> = {
  open: (_viewport, session) =>
    Promise.resolve({ cookies: [...(session?.cookies ?? [])] }),
  save: (context) =>
    Promise.resolve({ cookies: [...context.cookies], origins: [] }),
  render: (context, scene) => {
    for (const step of scene.steps) {
      if (step.action === "fill" && step.selector === "session")
        context.cookies = [sessionCookie(step.value)];
      if (step.action === "click" && step.selector === "sign-out")
        context.cookies = [];
    }
    if (scene.setup) return Promise.resolve(undefined);
    const session = context.cookies.find((cookie) => cookie.name === "session");
    return Promise.resolve(Buffer.from(session?.value ?? "signed out"));
  },
  close: () => Promise.resolve(),
};

const SIGN_IN: JsonValue = {
  id: "sign-in",
  route: "/",
  setup: true,
  steps: [{ action: "fill", selector: "session", value: "admin" }],
};

function shot(id: string, extra: Record<string, JsonValue> = {}): JsonValue {
  return { id, route: `/${id}`, output: `docs/images/${id}.webp`, ...extra };
}

async function shots(scenes: CaptureScene[]): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  const failures = await playScenes(browser, scenes, (scene, png) => {
    seen[scene.id] = png.toString();
    return Promise.resolve(undefined);
  });
  assert.deepEqual(failures, []);
  return seen;
}

test("a scene after one that signs out still sees the session the setup scenes made", async () => {
  const scenes = parseScenes([
    SIGN_IN,
    shot("sign-out", { steps: [{ action: "click", selector: "sign-out" }] }),
    shot("dashboard"),
  ]);
  assert.deepEqual(await shots(scenes), {
    "sign-out": "signed out",
    dashboard: "admin",
  });
});

test("a signed-out scene opens with no session, and the scenes after it keep the setup session", async () => {
  const scenes = parseScenes([
    SIGN_IN,
    shot("sign-in-page", { signedOut: true }),
    shot("dashboard"),
  ]);
  assert.deepEqual(await shots(scenes), {
    "sign-in-page": "signed out",
    dashboard: "admin",
  });
});
