import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  visit,
  type Document,
  type YAMLMap,
} from "yaml";

import { isText } from "./workflow-needs.ts";

/** The only runners a hand-written job may use: Blacksmith's four-vCPU Linux and Windows images. */
export const BLACKSMITH_RUNNERS = {
  linux: "blacksmith-4vcpu-ubuntu-2404",
  windows: "blacksmith-4vcpu-windows-2025",
} as const;

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

function runnerFor(label: string): string | undefined {
  if (/windows/i.test(label)) return BLACKSMITH_RUNNERS.windows;
  return /macos|arm/i.test(label) ? undefined : BLACKSMITH_RUNNERS.linux;
}

/**
 * The Blacksmith runner a `runs-on` string stands for: the Windows image when the label is, or the last literal of an
 * expression is, a Windows one, else the Linux image. A literal label maps to that image, and an expression made only of
 * `vars.<name>` and `'literal'` terms joined by `||`, such as `${{ vars.RUNNER_CI || 'ubuntu-latest' }}`, maps by its
 * last literal. `undefined` for a macOS or Arm label, which no Blacksmith 4 vCPU image stands for, and for any other expression, which sync cannot resolve.
 */
export function blacksmithRunsOn(value: string): string | undefined {
  if (!value.includes("${{")) return runnerFor(value);
  const expression = WHOLE_EXPRESSION.exec(value.trim())?.[1];
  if (expression === undefined) return undefined;
  const literals: string[] = [];
  for (const term of expression.split("||").map((part) => part.trim())) {
    const literal = /^'([^']*)'$/.exec(term);
    if (literal) literals.push(literal[1]);
    else if (!/^vars\.\w+$/.test(term)) return undefined;
  }
  return runnerFor(literals.at(-1) ?? "");
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
      `Runner: ${path} job ${id} runs on ${value}, which sync cannot resolve to ${BLACKSMITH_RUNNERS.linux} or ${BLACKSMITH_RUNNERS.windows}. Use a literal label.`,
    ],
  };
}

function setRunner(node: Scalar<string>): boolean {
  const runner = blacksmithRunsOn(node.value);
  if (runner === undefined || runner === node.value) return false;
  node.value = runner;
  node.type = Scalar.PLAIN;
  return true;
}

function matrixOsNodes(job: YAMLMap): Scalar<string>[] | undefined {
  const matrix = job.getIn(["strategy", "matrix"], true);
  if (!isMap(matrix)) return undefined;
  const os = matrix.get("os", true);
  const include = matrix.get("include", true);
  if ((os !== undefined && !isSeq(os)) || matrix.has("exclude"))
    return undefined;
  const nodes = [
    ...(isSeq(os) ? os.items : []),
    ...(isSeq(include)
      ? include.items.flatMap((entry) =>
          isMap(entry) ? [entry.get("os", true)] : [],
        )
      : []),
  ];
  const scalars = nodes.filter(isTextScalar);
  return scalars.length > 0 && scalars.length === nodes.length
    ? scalars
    : undefined;
}

function readsMatrixOs(job: YAMLMap): boolean {
  const runsOn = job.get("runs-on", true);
  let found = false;
  visit(job, {
    Scalar(key, node) {
      if (
        key !== "key" &&
        node !== runsOn &&
        String(node.value).includes("matrix.os")
      )
        found = true;
    },
  });
  return found;
}

function setMatrixRunners(job: YAMLMap): boolean | undefined {
  const nodes = matrixOsNodes(job);
  if (
    nodes === undefined ||
    readsMatrixOs(job) ||
    nodes.some(({ value }) => blacksmithRunsOn(value) === undefined)
  )
    return undefined;
  return nodes.map(setRunner).includes(true);
}

/** Maps the `runs-on` of `job` to a Blacksmith label; the advisory names a runner sync cannot resolve. */
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
  if (MATRIX_OS.test(runsOn.value)) {
    const changed = setMatrixRunners(job);
    return changed === undefined
      ? unresolved(path, id, runsOn.value)
      : { changed, advisories: [] };
  }
  if (blacksmithRunsOn(runsOn.value) === undefined)
    return unresolved(path, id, runsOn.value);
  return { changed: setRunner(runsOn), advisories: [] };
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
 * Gives every hand-written job of the workflow at `path` a Blacksmith runner and the pinned actions of {@link ACTION_PINS},
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
