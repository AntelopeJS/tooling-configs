import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  CPU_LIST,
  HOME,
  PW_BROWSERS,
  SYSLIBS,
  WORK,
  benchEnv,
  chromeShell,
  chromeStable,
  withSystemLibs,
} from "./paths.mjs";

const sizeOf = (path) => {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    return readdirSync(path).reduce(
      (total, name) => total + sizeOf(join(path, name)),
      stat.size,
    );
  } catch {
    return 0;
  }
};

const versionOf = (binary) => {
  try {
    return execFileSync(binary, ["--version"], {
      env: withSystemLibs(benchEnv()),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
};

const packageVersion = (name) =>
  JSON.parse(
    readFileSync(join(WORK, "node_modules", name, "package.json"), "utf8"),
  ).version;

const folder = (root, prefix) => {
  const name = readdirSync(root).find((entry) => entry.startsWith(prefix));
  return join(root, name);
};

/** @returns {Record<string, any>} The machine, versions and install sizes of this run */
export function collectMeta() {
  const cpu = os.cpus();
  return {
    date: new Date().toISOString(),
    host: {
      cpuModel: cpu[0].model,
      logicalCpus: cpu.length,
      kernel: os.release(),
      memTotalGiB: os.totalmem() / 2 ** 30,
    },
    pinned: CPU_LIST,
    loadAvgAtStart: os.loadavg(),
    node: process.version,
    versions: {
      "agent-browser": packageVersion("agent-browser"),
      "playwright-core": packageVersion("playwright-core"),
      "chrome (agent-browser)": versionOf(chromeStable()),
      "headless shell (playwright)": versionOf(chromeShell()),
    },
    installBytes: {
      "agent-browser npm package": sizeOf(
        join(WORK, "node_modules/agent-browser"),
      ),
      "playwright-core npm package": sizeOf(
        join(WORK, "node_modules/playwright-core"),
      ),
      "Chrome for Testing (agent-browser install)": sizeOf(
        folder(join(HOME, ".agent-browser/browsers"), "chrome-"),
      ),
      "Playwright chromium-headless-shell + ffmpeg": sizeOf(PW_BROWSERS),
      "system libraries unpacked for Chrome": sizeOf(join(SYSLIBS, "../../..")),
    },
  };
}
