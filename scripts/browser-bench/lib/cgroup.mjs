import { readFileSync } from "node:fs";

/** @returns {string} The cgroup directory of the calling process */
function ownCgroupDir() {
  const line = readFileSync("/proc/self/cgroup", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("0::"));
  return `/sys/fs/cgroup${line.slice(3)}`;
}

/**
 * @param {string} text File contents
 * @param {string} key Line key
 * @returns {number} The number after the key, 0 when absent
 */
const field = (text, key) =>
  Number(new RegExp(`^${key} (\\d+)`, "m").exec(text)?.[1] ?? 0);

/**
 * Counters of the scope the caller runs in. `usage_usec` and `pgmajfault`
 * include processes that already exited.
 *
 * @param {string} dir The cgroup directory
 * @returns {{ cpuUsec: number, pressureUsec: number, majorFaults: number, peakBytes: number }} The counters
 */
export function readCgroup(dir = ownCgroupDir()) {
  const pressure = readFileSync(`${dir}/cpu.pressure`, "utf8");
  return {
    cpuUsec: field(readFileSync(`${dir}/cpu.stat`, "utf8"), "usage_usec"),
    pressureUsec: Number(/^some .*total=(\d+)/m.exec(pressure)?.[1] ?? 0),
    majorFaults: field(
      readFileSync(`${dir}/memory.stat`, "utf8"),
      "pgmajfault",
    ),
    peakBytes: Number(readFileSync(`${dir}/memory.peak`, "utf8")),
  };
}
