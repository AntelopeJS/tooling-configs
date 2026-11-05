# Browser driver for the verify skills

The `verify-*` skills keep `playwright-core` as their browser driver. agent-browser is faster per command, but Playwright starts faster, uses less memory, and keeps several accounts in one browser.

This page records the decision and the measurements behind it. It is an explanation, not a how-to. The reproduction steps are at the end.

## What was compared and why

Only `verify-dms` drives a browser. It runs `dms-control browser` (`dms/packages/dms/bin/control/browser.mjs`), which has this shape:

- One resident headless Chromium per verification run.
- One browser context per account, so several accounts are logged in at once.
- Actions address elements by ARIA role and accessible name.
- One command per action. After each action, `perform()` waits 400 ms, then writes an ARIA snapshot and a full-page screenshot.

`verify-interface`, `verify-module` and `verify-template` do not use a browser. The `antelopejs-capture` command in this repository also uses `playwright-core`.

The candidates were `playwright-core` 1.56.1, which `verify-dms` already depends on, and agent-browser 0.41.2, a native CLI with a resident daemon that talks to Chrome over CDP. Many agents share one machine, so the deciding numbers are wall time, CPU time of the whole process tree, and peak memory.

The benchmark drives three small static pages served from memory on `127.0.0.1`: a login form, a list of 200 rows, and a page with a dialog. It runs six scenarios.

| Scenario | What it does                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------- |
| A        | Cold start. Launch, open the login page, take an ARIA snapshot, close.                             |
| B        | A 20-step session, launch and close included. Login, select a row, fill a dialog, two screenshots. |
| B2       | The same 20 steps on a browser that is already running.                                            |
| C        | Three isolated accounts alive at once, 18 steps in total.                                          |
| D        | Idle cost of one resident browser with the 200-row page open.                                      |
| E        | One command (`get url`) on a running browser.                                                      |

There are four variants. Each runs in its own `systemd-run --user --scope` cgroup, so CPU and memory cover the driver, the daemon, the browser and every child process.

| Variant           | What it is                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `pw-shell`        | Playwright, one script, on its headless shell. The floor for Playwright.                        |
| `pw-shell-server` | Playwright with a resident server and one Node client per action, as `dms-control` works today. |
| `pw-chrome157`    | Playwright, one script, on Chrome 157, the browser agent-browser ships.                         |
| `ab-chrome157`    | agent-browser, one CLI process per command.                                                     |

`pw-chrome157` exists to separate the driver from the browser. Playwright 1.56 ships a Chromium 141 headless shell, and agent-browser ships Chrome 157.

## Results

Each cell is the median of 7 measured rounds after 1 warm-up round, from the second of two full runs. The median of the first run is in brackets where it was kept. Both runs had 0 failed runs. Peak memory is `RSS / PSS` in MiB. PSS divides shared pages among the processes that use them, so it is the honest footprint. RSS counts shared pages once per process and overstates.

| Scenario                     | `pw-shell`   | `pw-shell-server` | `pw-chrome157` | `ab-chrome157` |
| ---------------------------- | ------------ | ----------------- | -------------- | -------------- |
| A. wall ms                   | 532 [353]    | 802 [443]         | 853 [387]      | 1792 [1315]    |
| A. CPU ms, whole tree        | 711 [537]    | 952 [637]         | 1128 [786]     | 1768 [1240]    |
| A. peak RSS / PSS            | 454 / 191    | 529 / 221         | 812 / 264      | 1328 / 368     |
| B. wall ms                   | 1522 [943]   | 3122 [2007]       | 1682 [1013]    | 2304 [1980]    |
| B2. wall ms                  | n/a          | 2665 [1721]       | n/a            | 1113 [792]     |
| B2. CPU ms                   | n/a          | 3002 [1993]       | n/a            | 823 [582]      |
| C. wall ms                   | 641 [449]    | 2018 [1562]       | 1003 [739]     | 4033 [3123]    |
| C. peak RSS / PSS, processes | 680 / 247, 9 | 751 / 272, 10     | 1405 / 372, 15 | 4088 / 788, 50 |
| D. idle RSS / PSS, processes | n/a          | 491 / 228, 7      | n/a            | 1445 / 405, 17 |
| E. wall ms per command       | n/a          | 94 [58]           | n/a            | 4.5 [2.3]      |

The spread over the 7 rounds of the second run, as min to max wall time in milliseconds, shows how noisy the machine was.

| Scenario | `pw-shell`  | `pw-shell-server` | `pw-chrome157` | `ab-chrome157` |
| -------- | ----------- | ----------------- | -------------- | -------------- |
| A        | 261 to 608  | 414 to 828        | 376 to 936     | 1314 to 1958   |
| B        | 954 to 1702 | 1993 to 3720      | 980 to 2024    | 1459 to 3292   |
| B2       | n/a         | 1704 to 3087      | n/a            | 777 to 1359    |
| C        | 408 to 1073 | 1445 to 3191      | 613 to 1797    | 2839 to 6145   |

The two runs differ in absolute time. Cores 8 to 15 were about 37% busy during the first run and about 94% busy during the second, because the machine is shared. Absolute times drift by 1.2 to 2.2 times between the runs. The ratios between variants held. The cold-start ratio against `pw-chrome157` moved the most, from 3.4 to 2.1, because short Playwright runs react most to a busy machine. Its direction did not change.

| Ratio of medians, agent-browser to Playwright  | Run 1 | Run 2 |
| ---------------------------------------------- | ----- | ----- |
| Warm 20 steps, wall, against `pw-shell-server` | 0.46  | 0.42  |
| Warm 20 steps, CPU, against `pw-shell-server`  | 0.29  | 0.27  |
| Three accounts, PSS, against `pw-shell-server` | 2.9   | 2.9   |
| Three accounts, RSS, against `pw-shell-server` | 5.4   | 5.4   |
| Idle, PSS, against `pw-shell-server`           | 1.7   | 1.8   |

## Why Playwright

**Cold start.** A verify run starts a fresh browser. Playwright on its headless shell takes 532 ms and 711 ms of CPU. agent-browser takes 1792 ms and 1768 ms. With no driver at all, Chrome 157 needs 667 ms to launch, load the page and exit, so most of the gap comes from the browser agent-browser launches. Its Chrome runs 17 processes, against 11 for Playwright on the same Chrome. Two launch-flag attempts, `--no-startup-window` and `--disable-extensions`, shortened it by 4 to 7% in the second run, inside overlapping spreads, and not at all in a later rerun. The cause of the extra second is not isolated.

**Memory.** An idle resident browser holds 228 MiB PSS in 7 processes under Playwright and 405 MiB in 17 under agent-browser. Part of that is the browser, because agent-browser ships full Chrome and Playwright a headless shell. With the same Chrome 157, Playwright is still lower, at 389 MiB against 498 MiB PSS in scenario B.

**Several accounts.** `verify-dms` needs several accounts at once. Playwright adds a context to one browser. agent-browser adds a session, and each session is its own daemon and its own Chrome. Three accounts cost 751 MiB RSS and 10 processes under Playwright, and 4088 MiB and 50 processes under agent-browser.

**No root-only system libraries.** agent-browser's Chrome for Testing did not start on the benchmark host as installed. It needs `libcups.so.2`, `libcairo.so.2` and `libpango-1.0.so.0`, and the fix it prints, `agent-browser install --with-deps`, runs `apt` as root. Playwright's headless shell started with no extra libraries. To measure agent-browser, the benchmark unpacks the 15 Debian packages (7 MiB) under its work directory and sets `LD_LIBRARY_PATH` for agent-browser only. Every host that runs agent-browser needs the same libraries, installed with root or unpacked by hand.

**Smaller moving parts.** Playwright is already a dependency, so there is nothing to add. `playwright-core` is 8 MiB on disk, agent-browser is 116 MiB. Playwright's ARIA snapshot is the YAML format the `aria.yml` evidence uses today. agent-browser's snapshot is a different tree and was 55% larger on the 200-row page (28406 bytes against 18273). The unnamed `default` agent-browser session and its sockets are shared by every agent on a machine, so every use would need a unique `--session` and a private `AGENT_BROWSER_SOCKET_DIR`.

## Where agent-browser is faster

A command on a running browser takes 4.5 ms and 3.6 ms of CPU under agent-browser. Under `pw-shell-server` it takes 94 ms and 102 ms. Twenty steps on a running browser take 1113 ms and 823 ms of CPU under agent-browser, against 2665 ms and 3002 ms. That is 2.4 times faster and 3.6 times cheaper in CPU.

The cause is how `dms-control` calls Playwright, not Playwright. Each action starts a Node process that makes one HTTP request to the resident server. The benchmark's client costs 58 to 94 ms per action for that, before any browser work. agent-browser is a native binary that talks to its daemon over a Unix socket. The same 20 steps in one Playwright script, launch and close included, take 954 to 1702 ms (`pw-shell`).

The verify skill speed-up work can remove that cost with a thinner path from the agent to the resident server. Two options are several actions per request, or a client that is not Node. Either is cheaper than adding a second driver. Two limits on this number apply. The benchmark client is thinner than the real one, so the real per-action cost is at least what was measured. And `perform()` writes a full-page screenshot after every action. A full-page screenshot of the 200-row page takes 357 to 498 ms on every variant in the second run, so real sessions are dominated by screenshots and the driver gap shrinks.

## When to revisit

Revisit the choice if verify sessions grow to hundreds of commands on a single account. That is the only shape where agent-browser's 2 to 5 ms commands outweigh its slower start and heavier browser.

Switching would also need a unique `--session` and socket directory per run, and `libcups2t64`, `libcairo2`, `libpango-1.0-0` and their dependencies on every host. agent-browser on Playwright's headless shell is not an option. It hung on the first snapshot after a form-submit navigation in 4 of 4 attempts, so the benchmark does not measure it.

## Machine, versions and pinning

The numbers come from an AMD Ryzen 7 5800X with 16 logical CPUs and 63 GiB of memory, kernel 6.12.115, Node v24.22.2. The machine was shared and busy. Every measured process was pinned to cores 8 to 15 with `taskset`. CPU 8 is the hyperthread sibling of CPU 0, and another benchmark ran on cores 0 to 3, so shared physical cores inflated CPU time, most visibly in the second run.

| Component                   | Version                                 |
| --------------------------- | --------------------------------------- |
| `agent-browser`             | 0.41.2                                  |
| `playwright-core`           | 1.56.1                                  |
| Chrome (agent-browser)      | Google Chrome for Testing 157.0.8103.38 |
| Headless shell (Playwright) | Chromium 141.0.7390.37                  |

The benchmark installs both packages with exact versions and `--ignore-scripts`, so nothing global changes. This repository keeps `playwright-core` as a dev dependency at `^1.56.1` and as an optional peer at `>=1.56.0`.

Each scenario ran 7 measured rounds after 1 warm-up round, with all variants interleaved and the order rotated between rounds. Memory is sampled every 50 ms for RSS and every 100 ms for PSS, so a shorter peak can be missed. Every step checks its result, so a run that skipped work fails instead of looking fast.

## Reproduce

The benchmark is in `scripts/browser-bench/`. It needs Linux on x86-64 with a systemd user session, cgroup v2, `taskset` and `npm`. If Chrome lacks system libraries, it runs `apt-get download` and unpacks the packages locally. It never installs anything as root.

From the repository root:

```bash
node scripts/browser-bench/run.mjs --verbose
```

The first run installs both packages and both browsers into the work directory, about 865 MiB, and later runs reuse them. The command prints failures only. `--verbose` adds one line per run, and `--print` prints the report. The exit code is 1 when a measured run fails.

| Option             | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `--work-dir <dir>` | Where everything is installed and written. Defaults to `browser-bench` under `$TMPDIR`.     |
| `--cpus <list>`    | The cores to pin to, for example `8-15`. Defaults to every core the process may use.        |
| `--rounds <n>`     | Measured rounds after the warm-up round. Defaults to 7.                                     |
| `--only <list>`    | Scenarios to run, from `cold`, `session`, `session-warm`, `accounts`, `idle` and `latency`. |
| `--out <name>`     | Base name of the result files. Defaults to `browser-results`.                               |
| `--no-sample`      | Skips the memory sampler.                                                                   |

The run writes `<work-dir>/browser-results.json` with every run and `<work-dir>/browser-results.md` with the tables. Neither is part of the repository. A run of `--rounds 1 --only cold,latency,idle` took 67 seconds on the machine above.

To compare with this page, pin to idle cores. The ratios between variants are stable. Absolute times are not.
