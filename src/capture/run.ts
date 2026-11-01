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
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { MongoMemoryServer } from "mongodb-memory-server";
import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";

import { child, object, parseJson, type JsonObject } from "../garden/json.ts";
import { openContext, renderScene } from "./browser.ts";
import { type CaptureArgs, checkoutSettings, demoEnvironment } from "./demo.ts";
import { settle } from "./settle.ts";
import { stopProcessGroup } from "./stop.ts";
import { type CaptureScene, parseScenes, selectScenes } from "./scenes.ts";

const DEMO_URL = "https://github.com/AntelopeJS/template-dms-demo.git";
const DEMO_PORT = 3101;
const READY_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_GRACE_MS = 30_000;
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
function checkoutDemo(root: string, ref: string, into: string): string {
  const demo = join(into, "demo");
  const url = process.env.ANTELOPEJS_CAPTURE_DEMO_URL ?? DEMO_URL;
  run(
    "git",
    ["clone", "--quiet", "--depth", "1", "--branch", ref, url, demo],
    into,
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
  return demo;
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

async function captureAll(
  session: Session,
  scenes: CaptureScene[],
): Promise<string[]> {
  const failures: string[] = [];
  const first = scenes[0];
  const context = await openContext(
    session.browser,
    first?.viewport ?? { width: 1440, height: 900 },
  );
  for (const scene of scenes) {
    try {
      const png = await renderScene(context, session.url, scene);
      if (png === undefined || scene.output === undefined) continue;
      const failure = await settle(sharp, session.root, session.check, {
        scene: scene.id,
        output: scene.output,
        png,
      });
      if (failure !== undefined) failures.push(failure);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`scene ${scene.id}: ${reason.split("\n")[0]}`);
    }
  }
  await context.close();
  return failures;
}

/** Runs the scenes against the demo and writes, or with `check` compares, their WebP files. Answers the failures, one line per scene. */
export async function capture(
  root: string,
  args: CaptureArgs,
): Promise<string[]> {
  const scenes = selectScenes(loadScenes(root), args.scene);
  const scratch = mkdtempSync(join(tmpdir(), "antelopejs-capture-"));
  const mongo = await MongoMemoryServer.create();
  let demo: ChildProcess | undefined;
  try {
    const checkout = checkoutDemo(root, args.demoRef, scratch);
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
    if (demo) await stopProcessGroup(demo, STOP_GRACE_MS);
    await mongo.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}
