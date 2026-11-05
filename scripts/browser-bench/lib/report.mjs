const MIB = 2 ** 20;

/**
 * @param {number[]} values The samples
 * @returns {number} The median
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {number[]} values The samples
 * @param {number} digits Decimal places
 * @returns {string} `median (min–max)`
 */
function spread(values, digits = 0) {
  if (values.length === 0) return "n/a";
  const f = (value) => value.toFixed(digits);
  return `${f(median(values))} (${f(Math.min(...values))}-${f(Math.max(...values))})`;
}

const cpuMs = (run) =>
  (run.cpuUsec - (run.driverIsRunner ? 0 : run.runnerCpuUsec)) / 1000;

const valid = (runs, scenario, variant) =>
  runs.filter(
    (run) =>
      run.scenario === scenario &&
      run.variant === variant &&
      !run.warmup &&
      run.ok,
  );

const attempted = (runs, scenario, variant) =>
  runs.filter(
    (run) =>
      run.scenario === scenario && run.variant === variant && !run.warmup,
  );

const table = (header, rows) =>
  [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

const variantsOf = (runs, scenario) => [
  ...new Set(
    runs.filter((run) => run.scenario === scenario).map((run) => run.variant),
  ),
];

/**
 * @param {Array<Record<string, any>>} runs All runs
 * @param {string} scenario The scenario
 * @returns {string} The headline table of the scenario
 */
function headline(runs, scenario) {
  const rows = variantsOf(runs, scenario).map((variant) => {
    const ok = valid(runs, scenario, variant);
    return [
      variant,
      `${ok.length}/${attempted(runs, scenario, variant).length}`,
      spread(ok.map((run) => run.wallMs)),
      spread(ok.map(cpuMs)),
      spread(ok.map((run) => run.rssPeakBytes / MIB)),
      spread(ok.map((run) => run.pssPeakBytes / MIB)),
      spread(ok.map((run) => run.processesPeak)),
      spread(ok.map((run) => run.pressureUsec / 1000)),
      spread(ok.map((run) => run.residual.rssBytes / MIB)),
    ];
  });
  return table(
    [
      "variant",
      "ok/runs",
      "wall ms",
      "CPU ms (whole tree)",
      "peak RSS MiB",
      "peak PSS MiB",
      "procs",
      "CPU-stall ms",
      "left after exit MiB",
    ],
    rows,
  );
}

/**
 * @param {Array<Record<string, any>>} runs All runs
 * @returns {string} Per-step medians of the 20-step session
 */
function stepTable(runs) {
  const variants = variantsOf(runs, "session");
  const labels = [];
  for (const run of runs.filter(
    (entry) => entry.scenario === "session" && entry.ok,
  ))
    for (const { label } of run.steps)
      if (!labels.includes(label)) labels.push(label);
  const rows = labels.map((label) => [
    label,
    ...variants.map((variant) => {
      const times = valid(runs, "session", variant).flatMap((run) =>
        run.steps.filter((step) => step.label === label).map((step) => step.ms),
      );
      return times.length ? median(times).toFixed(0) : "";
    }),
  ]);
  return table(["step (median ms)", ...variants], rows);
}

/**
 * @param {Array<Record<string, any>>} runs All runs
 * @returns {string} Per-command latency and CPU
 */
function latencyTable(runs) {
  const rows = variantsOf(runs, "latency").map((variant) => {
    const ok = valid(runs, "latency", variant);
    const calls = ok
      .flatMap((run) =>
        run.steps
          .filter((step) => step.label.endsWith(" url"))
          .map((step) => step.ms),
      )
      .sort((a, b) => a - b);
    const count =
      ok[0]?.steps.filter((step) => step.label.endsWith(" url")).length ?? 1;
    return [
      variant,
      `${ok.length}/${attempted(runs, "latency", variant).length}`,
      calls.length ? median(calls).toFixed(1) : "n/a",
      calls.length ? calls[Math.floor(calls.length * 0.95)].toFixed(1) : "n/a",
      spread(
        ok.map((run) => cpuMs(run) / count),
        1,
      ),
    ];
  });
  return table(
    [
      "variant",
      "ok/runs",
      "per command wall ms, median",
      "p95",
      "CPU ms per command (median, range of runs)",
    ],
    rows,
  );
}

/**
 * @param {Array<Record<string, any>>} runs All runs
 * @returns {string} Idle cost of a resident browser with one open page
 */
function idleTable(runs) {
  const rows = variantsOf(runs, "idle").map((variant) => {
    const ok = valid(runs, "idle", variant);
    return [
      variant,
      `${ok.length}/${attempted(runs, "idle", variant).length}`,
      spread(
        ok.map((run) => (cpuMs(run) / run.wallMs) * 100),
        1,
      ),
      spread(ok.map((run) => run.rssPeakBytes / MIB)),
      spread(ok.map((run) => run.pssPeakBytes / MIB)),
      spread(ok.map((run) => run.processesPeak)),
    ];
  });
  return table(
    [
      "variant",
      "ok/runs",
      "idle CPU % of one core (5 s window)",
      "RSS MiB",
      "PSS MiB",
      "procs",
    ],
    rows,
  );
}

/**
 * @param {Array<Record<string, any>>} runs All runs
 * @param {Record<string, any>} meta The machine description
 * @returns {string} How busy the machine was while measuring
 */
function noiseTable(runs, meta) {
  const rows = [...new Set(runs.map((run) => run.scenario))].map((scenario) => {
    const set = runs.filter((run) => run.scenario === scenario && !run.warmup);
    return [
      scenario,
      spread(set.map((run) => run.coreBusyPct)),
      spread(
        set.map((run) => run.loadAvg1),
        0,
      ),
    ];
  });
  return table(
    [
      "scenario",
      `busy % of cores ${meta.pinned} during a run (incl. the run itself)`,
      `1-min load average (${meta.host.logicalCpus} threads)`,
    ],
    rows,
  );
}

/**
 * @param {Array<Record<string, any>>} runs All runs
 * @returns {string} Output sizes an agent would have to read
 */
function sizeTable(runs) {
  const keys = [
    "snapshotBytes 02 snapshot",
    "snapshotBytes 08 snapshot",
    "snapshotBytes 14 snapshot",
    "screenshotBytes 11 screenshot",
    "screenshotBytes 20 screenshot",
  ];
  const rows = variantsOf(runs, "session").map((variant) => {
    const ok = valid(runs, "session", variant);
    return [
      variant,
      ...keys.map((key) => (ok[0]?.facts?.[key] ?? "").toString()),
    ];
  });
  return table(
    [
      "variant",
      "login snapshot B",
      "200-row list snapshot B",
      "dialog snapshot B",
      "full-page PNG B",
      "viewport PNG B",
    ],
    rows,
  );
}

const gib = (bytes) => `${(bytes / MIB).toFixed(0)} MiB`;

/**
 * @param {{ meta: Record<string, any>, options: Record<string, any>, runs: Array<Record<string, any>> }} data The raw results
 * @returns {string} The Markdown report
 */
export function renderReport({ meta, options, runs }) {
  const sections = [
    "# Browser driver benchmark: agent-browser vs Playwright",
    `Generated ${meta.date} by \`node scripts/browser-bench/run.mjs\` (${options.rounds} measured rounds after 1 warm-up round, rounds interleave all variants).`,
    "## Machine and pinning",
    `${meta.host.cpuModel}, ${meta.host.logicalCpus} logical CPUs, ${meta.host.memTotalGiB.toFixed(0)} GiB, kernel ${meta.host.kernel}, Node ${meta.node}. Every process measured is pinned to cores **${meta.pinned}** (\`taskset -c ${meta.pinned}\`). Each run is a transient \`systemd-run --user --scope\` cgroup, so CPU time and memory cover the whole tree: driver, daemon, browser and every child that already exited. The 1-min load average was ${meta.loadAvgAtStart[0].toFixed(0)} at start, so read wall time with the CPU-stall column.`,
    noiseTable(runs, meta),
    "## Versions and install size",
    table(
      ["component", "version"],
      Object.entries(meta.versions).map(([name, version]) => [name, version]),
    ),
    table(
      ["installed under the work directory", "size"],
      Object.entries(meta.installBytes).map(([name, bytes]) => [
        name,
        gib(bytes),
      ]),
    ),
    "## Results",
    "Cells are `median (min-max)` over the valid measured runs. RSS is sampled every 50 ms and PSS every 100 ms from the scope's process list, so a peak shorter than that can be missed.**CPU ms** is user+system CPU of the whole cgroup over the timed region, minus the benchmark runner's own CPU when the runner only plays the agent (every variant except `pw-shell`, `pw-chrome157`). **Peak RSS** sums resident memory over every process in the tree (shared pages counted once per process, so it overstates); **peak PSS** divides shared pages among their users and is the honest footprint. **CPU-stall** is time the scope's tasks sat runnable but unscheduled (cpu.pressure), the cost of the busy machine.",
    "### A. Cold start: launch, goto, aria snapshot, close",
    headline(runs, "cold"),
    "### B. 20-step session, cold: launch + 20 steps + close",
    headline(runs, "session"),
    "### B2. 20-step session on a browser that is already running",
    headline(runs, "session-warm"),
    "### C. Three isolated accounts alive at once (18 steps)",
    headline(runs, "accounts"),
    "### D. Idle cost of one resident browser with a 200-row page open",
    idleTable(runs),
    "### E. One command round trip (`get url`) on a running browser",
    latencyTable(runs),
    "### Where the session time goes (median ms per step, scenario B)",
    stepTable(runs),
    "### Size of what an agent reads and writes",
    sizeTable(runs),
  ];
  return `${sections.join("\n\n")}\n`;
}
