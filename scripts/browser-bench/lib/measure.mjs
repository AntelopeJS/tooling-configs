import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CPU_IDS, CPU_LIST, benchEnv } from "./paths.mjs";

const SAMPLE_MS = 50;
const PSS_EVERY_TICKS = 2;
const PAGE_BYTES = 4096;
const SETTLE_AFTER_EXIT_MS = 300;
const CLOCK_TICKS_PER_SECOND = 100;
const UID = process.getuid();

/**
 * @param {string} unit The transient unit name
 * @returns {string} The scope's cgroup directory
 */
const scopeDir = (unit) =>
  `/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${unit}.scope`;

const kib = (text, key) =>
  Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0) * 1024;

/**
 * @param {string[]} cmdline NUL-split command line
 * @returns {string} A class such as `chrome:renderer` or `node:pw-server.mjs`
 */
function classify(cmdline) {
  const text = cmdline.join(" ");
  const type = /--type=([\w-]+)/.exec(text)?.[1];
  if (type) return `chrome:${type}`;
  if (text.includes("--extension-process")) return "chrome:renderer-extension";
  if (text.includes("--ntp-process")) return "chrome:renderer-ntp";
  if (text.includes("--renderer-client-id")) return "chrome:renderer";
  if (text.includes("--gpu-preferences")) return "chrome:gpu";
  if (text.includes("--shared-files")) return "chrome:utility";
  if (text.includes("--remote-debugging") || text.includes("--dump-dom"))
    return "chrome:browser";
  const exe = basename(cmdline[0].split(" ")[0] ?? "");
  if (exe === "node") return `node:${basename(cmdline[1] ?? "")}`;
  if (exe.includes("headless_shell")) return "chrome:browser";
  return exe;
}

/**
 * @param {string} dir The cgroup directory
 * @param {number} excludePid A pid left out of the sums
 * @returns {Array<{ pid: number, cls: string, rss: number, pss: number, ticks: number }> | null} The live processes, null once the scope is gone
 */
function sampleTree(dir, excludePid, withPss = true) {
  let pids;
  try {
    pids = readFileSync(`${dir}/cgroup.procs`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return null;
  }
  const procs = [];
  for (const pid of pids) {
    if (pid === excludePid) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const resident =
        Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) *
        PAGE_BYTES;
      procs.push({
        pid,
        cls: classify(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")),
        rss: resident,
        pss: withPss
          ? kib(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"), "Pss")
          : 0,
        ticks: Number(fields[11]) + Number(fields[12]),
      });
    } catch {
      continue;
    }
  }
  return procs;
}

/** @returns {number[][]} Per core [busy, total] jiffies for the pinned cores */
function readCores() {
  const rows = new Map();
  for (const line of readFileSync("/proc/stat", "utf8").split("\n")) {
    const match = /^cpu(\d+) (.*)$/.exec(line);
    if (match) rows.set(Number(match[1]), match[2].split(" ").map(Number));
  }
  return CPU_IDS.map((id) => {
    const row = rows.get(id);
    const total = row.reduce((sum, value) => sum + value, 0);
    return [total - row[3] - row[4], total];
  });
}

/**
 * Samples the scope's process tree every {@link SAMPLE_MS} while the timed
 * region runs, which is between the runner's `.t0` and `.t1` marker files.
 *
 * @param {{ dir: string, excludePid: number, resultPath: string, enabled: boolean }} job The scope to watch
 * @returns {{ peaks: Record<string, number>, lastByPid: Map<number, { cls: string, ticks: number }>, stop: () => void }} The peaks seen so far and a stop function
 */
function startSampler({ dir, excludePid, resultPath, enabled }) {
  const peaks = { rss: 0, pss: 0, procs: 0, rssAll: 0, pssAll: 0 };
  const lastByPid = new Map();
  let tick = 0;
  const timer = enabled
    ? setInterval(() => {
        tick += 1;
        const procs = sampleTree(dir, excludePid, tick % PSS_EVERY_TICKS === 0);
        if (!procs) return;
        const rss = procs.reduce((sum, proc) => sum + proc.rss, 0);
        const pss = procs.reduce((sum, proc) => sum + proc.pss, 0);
        peaks.rssAll = Math.max(peaks.rssAll, rss);
        peaks.pssAll = Math.max(peaks.pssAll, pss);
        if (existsSync(`${resultPath}.t0`) && !existsSync(`${resultPath}.t1`)) {
          peaks.rss = Math.max(peaks.rss, rss);
          peaks.pss = Math.max(peaks.pss, pss);
          peaks.procs = Math.max(peaks.procs, procs.length);
          for (const proc of procs) lastByPid.set(proc.pid, proc);
        }
      }, SAMPLE_MS)
    : null;
  return { peaks, lastByPid, stop: () => timer && clearInterval(timer) };
}

/**
 * Runs `node <runner> <config>` in a transient cgroup scope pinned to the
 * benchmark cores, and samples the scope's process tree while it runs.
 *
 * @param {{ unit: string, runner: string, config: Record<string, unknown>, driverIsRunner: boolean, extraEnv?: Record<string, string>, sample?: boolean }} job The job
 * @returns {Promise<Record<string, any>>} The runner's result plus the sampled memory, residue and load
 */
export async function measureInScope({
  unit,
  runner,
  config,
  driverIsRunner,
  extraEnv = {},
  sample = true,
}) {
  mkdirSync(config.outDir, { recursive: true });
  mkdirSync(config.socketDir, { recursive: true });
  const dir = scopeDir(unit);
  const cores0 = readCores();
  const started = performance.now();
  const child = spawn(
    "taskset",
    [
      "-c",
      CPU_LIST,
      "systemd-run",
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      "-p",
      "MemoryAccounting=yes",
      "-p",
      "CPUAccounting=yes",
      process.execPath,
      runner,
      JSON.stringify(config),
    ],
    {
      env: {
        ...benchEnv({
          ...process.env,
          AGENT_BROWSER_SOCKET_DIR: config.socketDir,
        }),
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );

  const { peaks, lastByPid, stop } = startSampler({
    dir,
    excludePid: driverIsRunner ? -1 : child.pid,
    resultPath: config.resultPath,
    enabled: sample,
  });

  const exit = await exited;
  stop();
  const totalWallMs = performance.now() - started;
  await sleep(SETTLE_AFTER_EXIT_MS);
  const leftover = sampleTree(dir, -1) ?? [];
  const residual = {
    processes: leftover.length,
    rssBytes: leftover.reduce((sum, proc) => sum + proc.rss, 0),
    classes: [...new Set(leftover.map((proc) => proc.cls))],
  };
  if (leftover.length > 0) writeFileSync(`${dir}/cgroup.kill`, "1");
  for (let waited = 0; existsSync(dir) && waited < 3000; waited += 50)
    await sleep(50);

  const cores1 = readCores();
  const coreBusy = cores1.map(([busy, total], index) => {
    const [busy0, total0] = cores0[index];
    return (busy - busy0) / Math.max(1, total - total0);
  });

  const cpuByClass = {};
  for (const proc of lastByPid.values())
    cpuByClass[proc.cls] =
      (cpuByClass[proc.cls] ?? 0) + proc.ticks / CLOCK_TICKS_PER_SECOND;

  let result = null;
  try {
    result = JSON.parse(readFileSync(config.resultPath, "utf8"));
  } catch {
    result = {
      errors: [
        `no result written (exit ${exit.code ?? exit.signal}): ${stderr.trim().slice(0, 300)}`,
      ],
      steps: [],
      facts: {},
    };
  }
  return {
    ...result,
    exit,
    totalWallMs,
    rssPeakBytes: peaks.rss,
    pssPeakBytes: peaks.pss,
    rssPeakAllBytes: peaks.rssAll,
    pssPeakAllBytes: peaks.pssAll,
    processesPeak: peaks.procs,
    residual,
    cpuByClass,
    coreBusyPct:
      (100 * coreBusy.reduce((sum, value) => sum + value, 0)) / coreBusy.length,
    loadAvg1: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]),
    driverIsRunner,
  };
}
