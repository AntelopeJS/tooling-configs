import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Document,
  type YAMLMap,
} from "yaml";

import { isText } from "./workflow-needs.ts";

/**
 * The runner of each OS a hand-written job runs on, chosen at run time: the repository variable when it is set, else
 * GitHub's runner for a public repository and Blacksmith's four-vCPU image for any other or an event without the
 * visibility. The shared workflows choose theirs the same way.
 */
const RUNNERS = {
  linux: {
    variable: "RUNNER_CI",
    public: "ubuntu-latest",
    private: "blacksmith-4vcpu-ubuntu-2404",
  },
  windows: {
    variable: "RUNNER_CI_WINDOWS",
    public: "windows-latest",
    private: "blacksmith-4vcpu-windows-2025",
  },
} as const;

/** An OS sync has a runner for. */
export type Os = keyof typeof RUNNERS;

function runnerChoice(os: Os): string {
  const { variable, public: open, private: closed } = RUNNERS[os];
  return `vars.${variable} || (github.event.repository.visibility == 'public' && '${open}' || '${closed}')`;
}

/** The `runs-on` sync writes for a hand-written job of each OS. */
export const RUNS_ON: Readonly<Record<Os, string>> = {
  linux: `\${{ ${runnerChoice("linux")} }}`,
  windows: `\${{ ${runnerChoice("windows")} }}`,
};

/** The `runs-on` of a job on a matrix `os`: the choice of `os` for the leg whose `matrix.os` is `label`, the other OS's for every other leg. */
export function matrixRunsOn(label: string, os: Os): string {
  const other: Os = os === "windows" ? "linux" : "windows";
  return `\${{ matrix.os == '${label}' && (${runnerChoice(os)}) || (${runnerChoice(other)}) }}`;
}

/** The commit and the release an action is pinned to. */
export interface ActionPin {
  sha: string;
  version: string;
}

const CACHE_PIN: ActionPin = {
  sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  version: "v6.1.0",
};

/** The actions the shared workflows pin, plus setup-java, each at the one commit a hand-written job pins it to. */
export const ACTION_PINS: ReadonlyMap<string, ActionPin> = new Map([
  [
    "actions/checkout",
    { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  ],
  [
    "actions/setup-node",
    { sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", version: "v7.1.0" },
  ],
  ["actions/cache", CACHE_PIN],
  ["actions/cache/restore", CACHE_PIN],
  ["actions/cache/save", CACHE_PIN],
  [
    "pnpm/action-setup",
    { sha: "73e46992e05b19abd31f2f3c20e0e7370d762115", version: "v6.1.1" },
  ],
  [
    "actions/upload-artifact",
    { sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9", version: "v7.0.2" },
  ],
  [
    "actions/download-artifact",
    { sha: "9000827ccba6bdab643e8b6fd33ac0654aef8333", version: "v8.0.2" },
  ],
  [
    "actions/create-github-app-token",
    { sha: "f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc", version: "v3.4.0" },
  ],
  [
    "actions/setup-java",
    { sha: "d1374f8ac74474200d16ef8ecee22c7ae7a51880", version: "v6.3.0" },
  ],
]);

/** The `cancel-in-progress` value of a pull request workflow: a new push cancels the older pull request run, never a push or merge queue run. */
export const CANCEL_IN_PROGRESS = "${{ github.event_name == 'pull_request' }}";

const CONCURRENCY_GROUP = "${{ github.workflow }}-${{ github.ref }}";
const WHOLE_EXPRESSION = /^\$\{\{([\s\S]*)\}\}$/;
const MATRIX_OS = /^\$\{\{\s*matrix\.os\s*\}\}$/;
const MATRIX_KEY = /^\$\{\{\s*matrix\.os\s*==\s*'([^']+)'\s*&&/;
const SIMPLE_TERNARY =
  /^\$\{\{\s*matrix\.os\s*==\s*'[^']+'\s*&&\s*('[^']*'|vars\.\w+)\s*\|\|\s*('[^']*'|vars\.\w+)\s*\}\}$/;

/** A job of `jobs` that calls no workflow: it has no job-level `uses`. */
export interface HandJob {
  id: string;
  job: YAMLMap;
}

/** The jobs of `jobs` that call no workflow, in file order. */
export function handWrittenJobs(jobs: YAMLMap): HandJob[] {
  return jobs.items.flatMap(({ key, value }) =>
    isScalar(key) && isMap(value) && !value.has("uses")
      ? [{ id: String(key.value), job: value }]
      : [],
  );
}

/** The steps of `job` that are maps, in order. */
export function stepsOf(job: YAMLMap): YAMLMap[] {
  const steps = job.get("steps", true);
  return isSeq(steps) ? steps.items.filter(isMap) : [];
}

/** Whether `job` only gathers the results of the jobs it needs: it has `needs` and none of its steps uses an action. */
export function isAggregator(job: YAMLMap): boolean {
  return job.has("needs") && stepsOf(job).every((step) => !step.has("uses"));
}

function osOf(label: string): Os | undefined {
  if (/windows/i.test(label)) return "windows";
  return /macos|arm/i.test(label) ? undefined : "linux";
}

/** The OS of a matrix label, read only from a name that says it: a Windows, or an Ubuntu or Linux one that is not Arm. */
function legOsOf(label: string): Os | undefined {
  if (/arm/i.test(label)) return undefined;
  if (/windows/i.test(label)) return "windows";
  return /ubuntu|linux/i.test(label) ? "linux" : undefined;
}

/** The OS a ternary branch runs on: a label by {@link legOsOf}, the variable of an OS of {@link RUNNERS}, else none. */
function branchOsOf(term: string): Os | undefined {
  const literal = /^'([^']*)'$/.exec(term)?.[1];
  if (literal !== undefined) return legOsOf(literal);
  const variable = term.slice("vars.".length);
  if (variable === RUNNERS.linux.variable) return "linux";
  return variable === RUNNERS.windows.variable ? "windows" : undefined;
}

function osOfChain(expression: string): Os | undefined {
  const literals: string[] = [];
  for (const term of expression.split("||").map((part) => part.trim())) {
    const literal = /^'([^']*)'$/.exec(term);
    if (literal) literals.push(literal[1]);
    else if (!/^vars\.\w+$/.test(term)) return undefined;
  }
  return osOf(literals.at(-1) ?? "");
}

/**
 * The {@link RUNS_ON} expression a `runs-on` string stands for: the Windows one when the label is, or the last literal of
 * an expression is, a Windows one, else the Linux one. A literal label maps by itself, an expression sync writes stays,
 * and an expression made only of `vars.<name>` and `'literal'` terms joined by `||`, such as
 * `${{ vars.RUNNER_CI || 'ubuntu-latest' }}`, maps by its last literal. `undefined` for a macOS or Arm label, which no
 * runner of {@link RUNS_ON} stands for, and for any other expression, which sync cannot resolve.
 */
export function runsOnFor(value: string): string | undefined {
  if (value === RUNS_ON.linux || value === RUNS_ON.windows) return value;
  const expression = WHOLE_EXPRESSION.exec(value.trim())?.[1];
  const os = !value.includes("${{")
    ? osOf(value)
    : expression === undefined
      ? undefined
      : osOfChain(expression);
  return os === undefined ? undefined : RUNS_ON[os];
}

/** What a step over the hand-written jobs changed, and the findings it only reports. */
export interface Settled {
  changed: boolean;
  advisories: string[];
}

/** Whether `node` is a scalar holding a string. */
function isTextScalar(node: unknown): node is Scalar<string> {
  return isScalar(node) && isText(node.value);
}

function unresolved(path: string, id: string, value: string): Settled {
  return {
    changed: false,
    advisories: [
      `Runner: ${path} job ${id} runs on ${value}, which sync cannot resolve to a Linux or Windows runner. Use a literal label.`,
    ],
  };
}

function leftAlone(
  path: string,
  id: string,
  value: string,
  why: string,
): Settled {
  return {
    changed: false,
    advisories: [
      `Runner: ${path} job ${id} runs on ${value}, which sync leaves alone: ${why}, so a rewrite could move a leg to a runner of another OS.`,
    ],
  };
}

function setText(node: Scalar<string>, value: string): boolean {
  if (node.value === value) return false;
  node.value = value;
  node.type = Scalar.PLAIN;
  return true;
}

/** The labels of each OS a matrix `os` takes, or why sync cannot list every leg. */
type MatrixLegs =
  | { kind: "labels"; labels: Record<Os, Set<string>> }
  | { kind: "generated" }
  | { kind: "unknown"; why: string };

function isExpression(node: unknown): boolean {
  return isTextScalar(node) && node.value.includes("${{");
}

/**
 * Why sync cannot read the legs a matrix or an include item `map` declares, if it cannot: a merge key, which can bring
 * any key in, or a key spelled `os` in another case, which GitHub reads as `matrix.os` and sync would miss.
 */
function unreadableKey(map: YAMLMap, where: string): string | undefined {
  for (const { key } of map.items) {
    const name = isScalar(key) ? String(key.value) : "";
    if (name === "<<") return `${where} has a merge key`;
    if (name !== "os" && name.toLowerCase() === "os")
      return `${where} has the key ${name}, which GitHub reads as matrix.os`;
  }
  return undefined;
}

/** The `os` values every include item of `matrix` adds, or why sync cannot read one. */
function includedLabels(
  matrix: YAMLMap,
): { kind: "nodes"; nodes: unknown[] } | { kind: "unknown"; why: string } {
  const include = matrix.get("include", true);
  if (include === undefined) return { kind: "nodes", nodes: [] };
  if (!isSeq(include))
    return { kind: "unknown", why: "its matrix include is generated" };
  const nodes: unknown[] = [];
  for (const item of include.items) {
    if (!isMap(item))
      return { kind: "unknown", why: "an include item is generated" };
    const why = unreadableKey(item, "an include item");
    if (why !== undefined) return { kind: "unknown", why };
    if (item.has("os")) nodes.push(item.get("os", true));
  }
  return { kind: "nodes", nodes };
}

/**
 * Every label the matrix `os` of `job` takes, its literal list and the `os` of each include item together, grouped by
 * OS. `generated` when the list is an expression and no include item can add a leg; `unknown`, with the reason, when an
 * include is generated, an item or a label is an expression, a label names no Linux or Windows runner, or the matrix or
 * an include item has a key {@link unreadableKey} refuses. An `exclude` only removes legs, so its keys are not read.
 */
function matrixLegs(job: YAMLMap): MatrixLegs {
  const matrix = job.getIn(["strategy", "matrix"], true);
  if (!isMap(matrix)) return { kind: "unknown", why: "it has no matrix" };
  const why = unreadableKey(matrix, "its matrix");
  if (why !== undefined) return { kind: "unknown", why };
  const included = includedLabels(matrix);
  if (included.kind === "unknown") return included;
  const os = matrix.get("os", true);
  if (isExpression(os))
    return included.nodes.length
      ? {
          kind: "unknown",
          why: "its matrix os is generated and an include item adds to it",
        }
      : { kind: "generated" };
  if (os !== undefined && !isSeq(os))
    return { kind: "unknown", why: "its matrix os is not a list" };
  const nodes = [...(isSeq(os) ? os.items : []), ...included.nodes];
  if (!nodes.length) return { kind: "unknown", why: "its matrix has no os" };
  const labels: Record<Os, Set<string>> = {
    linux: new Set(),
    windows: new Set(),
  };
  for (const node of nodes) {
    if (!isTextScalar(node) || isExpression(node))
      return { kind: "unknown", why: "a matrix os value is an expression" };
    const leg = legOsOf(node.value);
    if (leg === undefined)
      return {
        kind: "unknown",
        why: `${node.value} names no Linux or Windows runner`,
      };
    labels[leg].add(node.value);
  }
  return { kind: "labels", labels };
}

/** The `runs-on` a `${{ matrix.os }}` job gets from {@link matrixLegs}, or why sync leaves it alone. */
function matrixListRunsOn(
  job: YAMLMap,
): { kind: "runsOn"; runsOn: string } | { kind: "unknown"; why: string } {
  const legs = matrixLegs(job);
  if (legs.kind === "generated")
    return { kind: "unknown", why: "its matrix os is generated" };
  if (legs.kind === "unknown") return legs;
  const { linux, windows } = legs.labels;
  if (linux.size > 1 || windows.size > 1)
    return {
      kind: "unknown",
      why: "its matrix names more than one label of one OS",
    };
  const [label] = windows;
  return {
    kind: "runsOn",
    runsOn:
      label === undefined ? RUNS_ON.linux : matrixRunsOn(label, "windows"),
  };
}

/**
 * Has a matrix job run on {@link matrixRunsOn}, the list of its matrix `os` left as it is so every comparison and
 * `exclude` on its labels keeps matching. A `${{ matrix.os }}` job keys the ternary on its one Windows label, or takes the
 * Linux {@link RUNS_ON} when it has none, when {@link matrixLegs} lists every leg with one label per OS. A ternary on
 * `matrix.os` against a label, Windows or Linux, becomes the expression ternary on that label when its first branch is a
 * literal of that label's OS or that OS's variable of {@link RUNNERS} and its second one of the other OS, and its matrix
 * `os` is generated or names that label as the one label of its OS. The expression ternary sync writes is checked against
 * the matrix the same way. A ternary keeps every leg on the OS it had, whatever entries the matrix gains.
 */
function setMatrixRunner(
  job: YAMLMap,
  runsOn: Scalar<string>,
): { kind: "set"; changed: boolean } | { kind: "unknown"; why: string } {
  if (MATRIX_OS.test(runsOn.value)) {
    const runner = matrixListRunsOn(job);
    return runner.kind === "unknown"
      ? runner
      : { kind: "set", changed: setText(runsOn, runner.runsOn) };
  }
  const label = MATRIX_KEY.exec(runsOn.value)?.[1] ?? "";
  const os = legOsOf(label);
  if (os === undefined)
    return {
      kind: "unknown",
      why: `${label} names no Linux or Windows runner`,
    };
  const runner = matrixRunsOn(label, os);
  const other: Os = os === "windows" ? "linux" : "windows";
  const branches = SIMPLE_TERNARY.exec(runsOn.value);
  if (
    runsOn.value !== runner &&
    (branches === null ||
      branchOsOf(branches[1]) !== os ||
      branchOsOf(branches[2]) !== other)
  )
    return {
      kind: "unknown",
      why: `its branches are not a ${os} and a ${other} runner`,
    };
  const legs = matrixLegs(job);
  if (legs.kind === "unknown") return legs;
  if (
    legs.kind === "labels" &&
    !(legs.labels[os].size === 1 && legs.labels[os].has(label))
  )
    return {
      kind: "unknown",
      why: `its matrix does not name ${label} as its one ${os} label`,
    };
  return { kind: "set", changed: setText(runsOn, runner) };
}

/** Moves the `runs-on` of `job` to a {@link RUNS_ON} expression or {@link matrixRunsOn}; the advisory names a runner sync cannot resolve. */
function rewriteRunner(
  document: Document,
  path: string,
  { id, job }: HandJob,
): Settled {
  const runsOn = job.get("runs-on", true);
  if (runsOn === undefined) return { changed: false, advisories: [] };
  if (!isTextScalar(runsOn))
    return unresolved(
      path,
      id,
      isNode(runsOn) ? JSON.stringify(runsOn.toJS(document)) : String(runsOn),
    );
  if (MATRIX_OS.test(runsOn.value) || MATRIX_KEY.test(runsOn.value)) {
    const result = setMatrixRunner(job, runsOn);
    return result.kind === "unknown"
      ? leftAlone(path, id, runsOn.value, result.why)
      : { changed: result.changed, advisories: [] };
  }
  const runner = runsOnFor(runsOn.value);
  return runner === undefined
    ? unresolved(path, id, runsOn.value)
    : { changed: setText(runsOn, runner), advisories: [] };
}

function pinStep(step: YAMLMap): boolean {
  const uses = step.get("uses", true);
  if (!isTextScalar(uses)) return false;
  const at = uses.value.indexOf("@");
  const name = uses.value.slice(0, at);
  const pin = at > 0 ? ACTION_PINS.get(name) : undefined;
  if (pin === undefined) return false;
  const pinned = `${name}@${pin.sha}`;
  const comment = ` ${pin.version}`;
  if (uses.value === pinned && uses.comment === comment) return false;
  uses.value = pinned;
  uses.comment = comment;
  return true;
}

function onPullRequests(document: Document): boolean {
  const on = document.get("on", true);
  if (isScalar(on)) return on.value === "pull_request";
  if (isSeq(on))
    return on.items.some(
      (item) => isScalar(item) && item.value === "pull_request",
    );
  return isMap(on) && on.has("pull_request");
}

function insertConcurrency(root: YAMLMap): boolean {
  const at = root.items.findIndex(
    ({ key }) => isScalar(key) && key.value === "jobs",
  );
  const block = parseDocument(
    `concurrency:\n  group: ${CONCURRENCY_GROUP}\n  cancel-in-progress: ${CANCEL_IN_PROGRESS}\n`,
  ).contents;
  if (at === -1 || !isMap(block) || !block.items.length) return false;
  const [concurrency] = block.items;
  if (isScalar(concurrency.key)) concurrency.key.spaceBefore = true;
  const jobsKey = root.items[at].key;
  if (isScalar(jobsKey)) jobsKey.spaceBefore = true;
  root.items.splice(at, 0, concurrency);
  return true;
}

function setConcurrency(document: Document): boolean {
  const root = document.contents;
  if (!isMap(root)) return false;
  const concurrency = root.get("concurrency", true);
  if (concurrency === undefined) return insertConcurrency(root);
  if (isMap(concurrency)) {
    const cancel = concurrency.get("cancel-in-progress");
    if (isText(cancel) && cancel.trim() === CANCEL_IN_PROGRESS) return false;
    concurrency.set("cancel-in-progress", CANCEL_IN_PROGRESS);
    return true;
  }
  root.set(
    "concurrency",
    document.createNode({
      group: isScalar(concurrency) ? concurrency.value : CONCURRENCY_GROUP,
      "cancel-in-progress": CANCEL_IN_PROGRESS,
    }),
  );
  return true;
}

/**
 * Gives every hand-written job of the workflow at `path` the runner {@link RUNS_ON} chooses from the visibility and the pinned actions of {@link ACTION_PINS},
 * each `uses: <name>@<sha>` with the release as its trailing comment, and a pull request workflow with a hand-written job
 * that is not an aggregator a top-level `concurrency` whose `cancel-in-progress` is {@link CANCEL_IN_PROGRESS}. A missing
 * `concurrency` is inserted before `jobs:`, a wrong `cancel-in-progress` is the only key set, and a right one stays. A
 * runner that no literal label stands for is left as it is, with an advisory naming the job.
 */
export function rewriteHandJobs(
  document: Document,
  jobs: YAMLMap,
  path: string,
): Settled {
  let changed = false;
  const advisories: string[] = [];
  const hand = handWrittenJobs(jobs);
  for (const entry of hand) {
    const runner = rewriteRunner(document, path, entry);
    advisories.push(...runner.advisories);
    const pinned = stepsOf(entry.job).map(pinStep);
    changed = runner.changed || pinned.includes(true) || changed;
  }
  const concurrent =
    onPullRequests(document) &&
    hand.some(({ job }) => !isAggregator(job)) &&
    setConcurrency(document);
  return { changed: concurrent || changed, advisories };
}
