import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORK_DIR_ENV = "BROWSER_BENCH_DIR";
const CPUS_ENV = "BROWSER_BENCH_CPUS";

/**
 * @param {string[]} argv Process arguments
 * @param {string} flag A flag such as `--work-dir`
 * @returns {string | undefined} The argument after the flag, when present
 */
function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/** @returns {string} The CPU list this process may run on, such as `0-15` */
export function allowedCpus() {
  return (
    /Cpus_allowed_list:\s+(\S+)/.exec(
      readFileSync("/proc/self/status", "utf8"),
    )?.[1] ?? ""
  );
}

/**
 * @param {string} list A CPU list such as `0,2,8-15`
 * @returns {number[]} The CPU ids it names
 */
function expandCpuList(list) {
  return list.split(",").flatMap((part) => {
    const [first, last = first] = part.split("-").map(Number);
    return Array.from(
      { length: last - first + 1 },
      (_, index) => first + index,
    );
  });
}

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Everything the benchmark installs and writes lives here: npm packages, both
 * browsers, unpacked libraries, raw runs and the report. `--work-dir` sets it,
 * then `BROWSER_BENCH_DIR`, then `browser-bench` under `$TMPDIR`.
 */
export const WORK = resolve(
  flagValue(process.argv, "--work-dir") ??
    process.env[WORK_DIR_ENV] ??
    join(tmpdir(), "browser-bench"),
);

/** The cores every measured process is pinned to: `--cpus`, then `BROWSER_BENCH_CPUS`, then every core this process may use. */
export const CPU_LIST =
  flagValue(process.argv, "--cpus") ?? process.env[CPUS_ENV] ?? allowedCpus();
export const CPU_IDS = expandCpuList(CPU_LIST);

export const HOME = join(WORK, "home");
export const RUNTIME = join(WORK, "run");
export const PW_BROWSERS = join(WORK, "pw-browsers");
export const SYSLIBS = join(WORK, "syslibs/usr/lib/x86_64-linux-gnu");
export const AB_BIN = join(
  WORK,
  "node_modules/agent-browser/bin/agent-browser-linux-x64",
);
export const AB_WRAPPER = join(
  WORK,
  "node_modules/agent-browser/bin/agent-browser.js",
);
export const PW_ENTRY = join(WORK, "node_modules/playwright-core/index.mjs");
export const DRIVERS = join(SCRIPTS, "drivers");

/**
 * @param {string} root Folder holding versioned browser folders
 * @param {string} prefix Folder name prefix
 * @param {string} relative Binary path inside the versioned folder
 * @returns {string} The binary path, or an empty string when not installed
 */
function findBinary(root, prefix, relative) {
  try {
    const folder = readdirSync(root).find((name) => name.startsWith(prefix));
    return folder ? join(root, folder, relative) : "";
  } catch {
    return "";
  }
}

export const chromeShell = () =>
  findBinary(
    PW_BROWSERS,
    "chromium_headless_shell-",
    "chrome-linux/headless_shell",
  );
export const chromeStable = () =>
  findBinary(join(HOME, ".agent-browser/browsers"), "chrome-", "chrome");

/**
 * @param {Record<string, string | undefined>} base Environment to extend
 * @returns {Record<string, string | undefined>} Environment for the isolated install
 */
export function benchEnv(base = process.env) {
  return {
    ...base,
    HOME,
    PLAYWRIGHT_BROWSERS_PATH: PW_BROWSERS,
    AGENT_BROWSER_SOCKET_DIR: base.AGENT_BROWSER_SOCKET_DIR ?? RUNTIME,
    [WORK_DIR_ENV]: WORK,
    [CPUS_ENV]: CPU_LIST,
  };
}

export const withSystemLibs = (env) => ({
  ...env,
  LD_LIBRARY_PATH: [SYSLIBS, env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
});
