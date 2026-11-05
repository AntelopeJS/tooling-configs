import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureInScope } from "./lib/measure.mjs";
import { CPU_LIST, DRIVERS, RUNTIME, WORK, allowedCpus } from "./lib/paths.mjs";
import { renderReport } from "./lib/report.mjs";
import { collectMeta } from "./lib/meta.mjs";
import { ensureInstalled } from "./setup.mjs";
import { startSite } from "./site.mjs";

const options = parseArgs(process.argv.slice(2));

if (!options.pinned && allowedCpus() !== CPU_LIST) {
  const again = spawnSync(
    "taskset",
    ["-c", CPU_LIST, process.execPath, ...process.argv.slice(1), "--pinned"],
    { stdio: "inherit" },
  );
  process.exit(again.status ?? 1);
}

/**
 * Each variant names its runner, the browser it drives, and whether the
 * runner process is itself the driver. When it is not, the runner is the
 * "agent" and its CPU and memory are left out of the driver's numbers.
 */
const VARIANTS = {
  "floor-shell": {
    runner: "floor-run.mjs",
    variant: "shell",
    driverIsRunner: false,
  },
  "floor-chrome157": {
    runner: "floor-run.mjs",
    variant: "chrome157",
    driverIsRunner: false,
  },
  "pw-shell": { runner: "pw-run.mjs", variant: "shell", driverIsRunner: true },
  "pw-shell-server": {
    runner: "pw-server-run.mjs",
    variant: "shell",
    driverIsRunner: false,
  },
  "pw-chrome157": {
    runner: "pw-run.mjs",
    variant: "chrome157",
    driverIsRunner: true,
  },
  "ab-chrome157": {
    runner: "ab-run.mjs",
    variant: "native",
    driverIsRunner: false,
  },
  "ab-wrapper": {
    runner: "ab-run.mjs",
    variant: "wrapper",
    driverIsRunner: false,
  },
  "ab-nostartwin": {
    runner: "ab-run.mjs",
    variant: "native",
    driverIsRunner: false,
    extraEnv: { AGENT_BROWSER_ARGS: "--no-startup-window" },
  },
  "ab-nostartwin-noext": {
    runner: "ab-run.mjs",
    variant: "native",
    driverIsRunner: false,
    extraEnv: {
      AGENT_BROWSER_ARGS: "--no-startup-window,--disable-extensions",
    },
  },
};

const MATRIX = [
  {
    scenario: "cold",
    variants: [
      "floor-shell",
      "floor-chrome157",
      "pw-shell",
      "pw-shell-server",
      "pw-chrome157",
      "ab-chrome157",
      "ab-nostartwin",
      "ab-nostartwin-noext",
    ],
  },
  {
    scenario: "session",
    variants: ["pw-shell", "pw-shell-server", "pw-chrome157", "ab-chrome157"],
  },
  { scenario: "session-warm", variants: ["pw-shell-server", "ab-chrome157"] },
  {
    scenario: "accounts",
    variants: ["pw-shell", "pw-shell-server", "pw-chrome157", "ab-chrome157"],
  },
  { scenario: "idle", variants: ["pw-shell-server", "ab-chrome157"] },
  {
    scenario: "latency",
    variants: ["pw-shell-server", "ab-chrome157", "ab-wrapper"],
  },
];

const cells = MATRIX.flatMap(({ scenario, variants }) =>
  variants.map((name) => ({ scenario, name })),
).filter((cell) => !options.only || options.only.includes(cell.scenario));

ensureInstalled();
const site = await startSite();
const meta = collectMeta();
const runs = [];
let counter = 0;

try {
  for (let round = 0; round <= options.rounds; round += 1) {
    const shift = (round * 5) % cells.length;
    const order = [...cells.slice(shift), ...cells.slice(0, shift)];
    for (const cell of order) {
      counter += 1;
      const spec = VARIANTS[cell.name];
      const config = {
        scenario: cell.scenario,
        variant: spec.variant,
        baseUrl: site.baseUrl,
        outDir: join(WORK, "out", String(counter)),
        socketDir: join(RUNTIME, counter.toString(36)),
        resultPath: join(WORK, "out", `${counter}.json`),
      };
      const measured = await measureInScope({
        unit: `bench-${process.pid}-${counter}`,
        runner: join(DRIVERS, spec.runner),
        config,
        driverIsRunner: spec.driverIsRunner,
        extraEnv: spec.extraEnv,
        sample: options.sample,
      });
      rmSync(config.outDir, { recursive: true, force: true });
      rmSync(config.socketDir, { recursive: true, force: true });
      for (const suffix of ["", ".t0", ".t1"])
        rmSync(config.resultPath + suffix, { force: true });
      const ok = measured.errors.length === 0 && measured.exit.code === 0;
      runs.push({
        scenario: cell.scenario,
        variant: cell.name,
        round,
        warmup: round === 0,
        ok,
        ...measured,
      });
      if (options.verbose)
        process.stderr.write(
          `round ${round} ${cell.scenario}/${cell.name} ${ok ? "ok" : "FAILED"} wall=${Math.round(measured.wallMs ?? 0)}ms cpu=${Math.round((measured.cpuUsec ?? 0) / 1000)}ms ${ok ? "" : measured.errors.join(" | ")}\n`,
        );
    }
  }
} finally {
  await site.close();
}

mkdirSync(WORK, { recursive: true });
writeFileSync(
  join(WORK, `${options.out}.json`),
  JSON.stringify({ meta, options, runs }, null, 1),
);
writeFileSync(
  join(WORK, `${options.out}.md`),
  renderReport({ meta, options, runs }),
);

const failed = runs.filter((run) => !run.warmup && !run.ok);
if (failed.length > 0) {
  process.stderr.write(
    `${failed.length} measured runs failed, first: ${failed[0].scenario}/${failed[0].variant}: ${failed[0].errors.join(" | ")}\n`,
  );
  process.exitCode = 1;
}
if (options.print)
  process.stdout.write(readFileSync(join(WORK, `${options.out}.md`), "utf8"));

/**
 * @param {string[]} argv Arguments after the script path
 * @returns {{ rounds: number, only: string[] | null, verbose: boolean, print: boolean, pinned: boolean, sample: boolean, out: string }} The options
 */
function parseArgs(argv) {
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  return {
    rounds: argv.includes("--rounds") ? Number(value("--rounds")) : 7,
    only: argv.includes("--only") ? value("--only").split(",") : null,
    verbose: argv.includes("--verbose"),
    print: argv.includes("--print"),
    pinned: argv.includes("--pinned"),
    sample: !argv.includes("--no-sample"),
    out: argv.includes("--out") ? value("--out") : "browser-results",
  };
}
