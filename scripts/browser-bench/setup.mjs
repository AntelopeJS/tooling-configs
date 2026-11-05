import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AB_BIN,
  HOME,
  SYSLIBS,
  WORK,
  benchEnv,
  chromeShell,
  chromeStable,
} from "./lib/paths.mjs";

const AGENT_BROWSER_VERSION = "0.41.2";
const PLAYWRIGHT_VERSION = "1.56.1";
const SYSTEM_PACKAGES = ["libcups2t64", "libcairo2", "libpango-1.0-0"];

/**
 * @param {string} program Program to run
 * @param {string[]} args Its arguments
 * @param {string} cwd Where to run it
 * @returns {string} Its output
 */
function run(program, args, cwd = WORK) {
  try {
    return execFileSync(program, args, {
      cwd,
      env: { ...benchEnv(), npm_config_cache: join(HOME, ".npm") },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `${program} ${args.join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`,
      { cause: error },
    );
  }
}

const missingLibraries = () =>
  run("ldd", [chromeStable()])
    .split("\n")
    .filter((line) => line.includes("not found"));

/**
 * Installs everything under the work directory and touches nothing global:
 * npm packages without lifecycle scripts, both browsers, and, when Chrome
 * lacks system libraries, the Debian packages unpacked locally.
 */
export function ensureInstalled() {
  mkdirSync(HOME, { recursive: true });
  if (!existsSync(join(WORK, "node_modules/agent-browser"))) {
    if (!existsSync(join(WORK, "package.json")))
      run("npm", ["init", "-y"], WORK);
    run(
      "npm",
      [
        "i",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        `agent-browser@${AGENT_BROWSER_VERSION}`,
        `playwright-core@${PLAYWRIGHT_VERSION}`,
      ],
      WORK,
    );
  }
  chmodSync(AB_BIN, 0o755);
  if (!chromeStable()) run(AB_BIN, ["install"]);
  if (!chromeShell())
    run(process.execPath, [
      join(WORK, "node_modules/playwright-core/cli.js"),
      "install",
      "chromium-headless-shell",
    ]);
  if (missingLibraries().length > 0 && !existsSync(SYSLIBS)) {
    const packages = run("apt-get", ["-s", "install", ...SYSTEM_PACKAGES])
      .split("\n")
      .filter((line) => line.startsWith("Inst "))
      .map((line) => line.split(" ")[1]);
    const debs = join(WORK, "syslibs-debs");
    mkdirSync(debs, { recursive: true });
    run("apt-get", ["download", ...packages], debs);
    for (const deb of readdirSync(debs))
      run("dpkg-deb", ["-x", join(debs, deb), join(WORK, "syslibs")]);
  }
}
