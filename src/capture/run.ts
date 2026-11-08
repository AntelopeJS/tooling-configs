import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { MongoMemoryServer } from "mongodb-memory-server";
import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";

import { child, object, parseJson, type JsonObject } from "../garden/json.ts";
import { playwrightScenes } from "./browser.ts";
import { assertBuilt } from "./built.ts";
import { type CaptureArgs, checkoutSettings, demoEnvironment } from "./demo.ts";
import { keepDemoLogs } from "./logs.ts";
import { playScenes } from "./play.ts";
import { settle } from "./settle.ts";
import { stopProcessGroup } from "./stop.ts";
import { type CaptureScene, parseScenes, selectScenes } from "./scenes.ts";

const DEMO_URL = "https://github.com/AntelopeJS/template-dms-demo.git";
const DEMO_PORT = 3101;
const READY_TIMEOUT_MS = 15 * 60 * 1000;
const STOP = { graceMs: 30_000, killWaitMs: 10_000 };
const READ_SCENES =
  "import(process.argv[1]).then((module) => process.stdout.write(JSON.stringify(module.default ?? module.scenes)))";

/** Reads the scenes in a child Node, which loads `docs/captures.ts` as the file itself declares it, then parses its JSON. */
function loadScenes(root: string): CaptureScene[] {
  const file = join(root, "docs", "captures.ts");
  if (!existsSync(file)) throw new Error("docs/captures.ts does not exist");
  const printed = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", READ_SCENES, pathToFileURL(file).href],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return parseScenes(parseJson(printed));
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status === 0) return;
  const output = `${result.stdout}${result.stderr}`.trim().split("\n");
  throw new Error(
    `${command} ${args.join(" ")} failed in ${cwd}\n${output.slice(-20).join("\n")}`,
  );
}

/** A checkout of the demo whose dependencies on this repository's packages are overridden to the working tree. Never committed: it lives in a throwaway directory. */
function checkoutDemo(root: string, ref: string, demo: string): void {
  const url = process.env.ANTELOPEJS_CAPTURE_DEMO_URL ?? DEMO_URL;
  run(
    "git",
    ["clone", "--quiet", "--depth", "1", "--branch", ref, url, demo],
    dirname(demo),
  );
  const manifestPath = join(demo, "package.json");
  const manifest = object(
    parseJson(readFileSync(manifestPath, "utf8")),
    "package.json",
  );
  const workspacePath = join(demo, "pnpm-workspace.yaml");
  const settings = checkoutSettings(
    child(manifest, "pnpm"),
    existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : "",
    root,
  );
  const patched: JsonObject = { ...manifest, pnpm: settings.pnpm };
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`);
  writeFileSync(workspacePath, settings.workspace);
  run("pnpm", ["install", "--no-frozen-lockfile"], demo);
}

/** Starts the demo's capture script and resolves with its URL once the script prints `ready <url>`. */
function startDemo(
  demo: string,
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; process: ChildProcess }> {
  const started = spawn("pnpm", ["run", "capture:start"], {
    cwd: demo,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `the demo was not ready in ${READY_TIMEOUT_MS / 1000}s\n${output}`,
          ),
        ),
      READY_TIMEOUT_MS,
    );
    const watch = (chunk: Buffer): void => {
      output += chunk.toString();
      const url = /^ready (\S+)$/m.exec(output)?.[1];
      if (url === undefined) return;
      clearTimeout(timer);
      resolve({ url, process: started });
    };
    started.stdout.on("data", watch);
    started.stderr.on("data", watch);
    started.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the demo stopped with exit code ${code}\n${output}`));
    });
  });
}

interface Session {
  root: string;
  browser: Browser;
  url: string;
  check: boolean;
}

function captureAll(
  session: Session,
  scenes: CaptureScene[],
): Promise<string[]> {
  return playScenes(
    playwrightScenes(session.browser, session.url),
    scenes,
    (scene, png) =>
      scene.output === undefined
        ? Promise.resolve(undefined)
        : settle(sharp, session.root, session.check, {
            scene: scene.id,
            output: scene.output,
            png,
          }),
  );
}

/** Checks the demo out into `checkout`, starts it on an empty MongoDB and captures the scenes, then stops both. */
async function captureFromDemo(
  root: string,
  args: CaptureArgs,
  scenes: CaptureScene[],
  checkout: string,
): Promise<string[]> {
  const mongo = await MongoMemoryServer.create();
  let demo: ChildProcess | undefined;
  try {
    checkoutDemo(root, args.demoRef, checkout);
    const started = await startDemo(
      checkout,
      demoEnvironment({
        mongoUrl: mongo.getUri(),
        database: "docs_captures",
        port: DEMO_PORT,
      }),
    );
    demo = started.process;
    const browser = await chromium.launch();
    try {
      return await captureAll(
        { root, browser, url: started.url, check: args.check },
        scenes,
      );
    } finally {
      await browser.close();
    }
  } finally {
    try {
      if (demo) await stopProcessGroup(demo, STOP);
    } finally {
      await mongo.stop();
    }
  }
}

/**
 * Runs the scenes against the demo and writes, or with `check` compares, their WebP files. Answers the failures,
 * one line per scene. Refuses a module whose build output is missing before it starts anything. On a failure the
 * demo's logs outlive the deleted checkout, and the failures or the error name where they are.
 */
export async function capture(
  root: string,
  args: CaptureArgs,
): Promise<string[]> {
  const scenes = selectScenes(loadScenes(root), args.scene);
  assertBuilt(root);
  const scratch = mkdtempSync(join(tmpdir(), "antelopejs-capture-"));
  const checkout = join(scratch, "demo");
  try {
    const failures = await captureFromDemo(root, args, scenes, checkout);
    return failures.length ? [...failures, ...keepDemoLogs(checkout)] : [];
  } catch (error) {
    const kept = keepDemoLogs(checkout);
    if (kept.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error([reason, ...kept].join("\n"), { cause: error });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
