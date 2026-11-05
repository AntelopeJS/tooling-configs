import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  benchEnv,
  chromeShell,
  chromeStable,
  withSystemLibs,
} from "../lib/paths.mjs";
import { createRecorder, measured } from "../lib/runner.mjs";

const config = JSON.parse(process.argv[2]);
const recorder = createRecorder();
const isShell = config.variant === "shell";
const args = [
  isShell ? "--headless" : "--headless=new",
  "--no-sandbox",
  `--user-data-dir=${config.outDir}/profile`,
  "--dump-dom",
  new URL("/login.html", config.baseUrl).href,
];

await measured(config, recorder, {
  body: () =>
    recorder.step("launch, load, exit", async () => {
      const child = spawn(isShell ? chromeShell() : chromeStable(), args, {
        env: withSystemLibs(benchEnv()),
        stdio: ["ignore", "pipe", "ignore"],
      });
      let dom = "";
      child.stdout.on("data", (chunk) => (dom += chunk));
      const [code] = await once(child, "close");
      if (code !== 0 || !dom.includes("Sign in"))
        throw new Error(`browser exited ${code} without the login page`);
    }),
});
process.exit(0);
