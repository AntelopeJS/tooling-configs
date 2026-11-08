import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { JourneyResult } from "./results.ts";
import { flaggedDoors } from "./doors.ts";
import {
  formalGate,
  readFormalResult,
  touchedFormalChecks,
  type FormalResult,
} from "./formal.ts";
import type { Judgement } from "./judgement.ts";
import { planFor, SMOKE_FEATURE, type FullReason, type Plan } from "./map.ts";
import { featureJourneys, readResults } from "./runner.ts";
import {
  timingReport,
  timingTable,
  type FeatureResults,
} from "./timing-report.ts";
import { git, type RunState, type Workspace } from "./workspace.ts";

/** The overall result a verdict carries; NOT VERIFIED when a journey could not reach the product, never PASS. */
type VerdictResult = "PASS" | "PASS+NOTES" | "NOT VERIFIED" | "FAIL";

/** A rendered verdict and the facts it was computed from. */
export interface Verdict {
  result: VerdictResult;
  headSha: string;
  skillSha: string;
  pr: number;
  markdown: string;
  reasons: string[];
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function bullets(entries: string[], empty: string): string[] {
  return (entries.length > 0 ? entries : [empty]).map((entry) => `- ${entry}`);
}

function journeyRow(label: string, result: JourneyResult): string {
  const outcome =
    result.status === "PASS"
      ? "pass"
      : result.status === "FAIL"
        ? "**fail**"
        : "**not verified**";
  const reused =
    result.reusedFrom === undefined
      ? ""
      : ` (not run again: reuses [${result.reusedFrom}](${result.reusedFrom}))`;
  return `| ${label} | \`${result.journey}\`: ${result.entryPoint} | ${outcome}: ${result.title}${reused} | [${result.folder}](${result.folder}) |`;
}

/** For a reused result, the status of its source when that is no longer PASS (`missing` when gone); otherwise null. */
function staleReuse(state: RunState, result: JourneyResult): string | null {
  if (result.reusedFrom === undefined) return null;
  const file = join(state.evidence, result.reusedFrom, "result.json");
  if (!existsSync(file)) return "missing";
  const source: JourneyResult = JSON.parse(readFileSync(file, "utf8"));
  return source.status === "PASS" ? null : source.status;
}

/** The features outside the plan that have journey results in the run's evidence, in name order. */
function featuresOutsidePlan(state: RunState, plan: Plan): string[] {
  return readdirSync(state.evidence, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !plan.run.includes(entry.name) &&
        existsSync(join(state.evidence, entry.name, "feature.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

function journeyRows(workspace: Workspace, state: RunState, plan: Plan) {
  const rows: string[] = [];
  const reasons: string[] = [];
  const notVerified: string[] = [];
  const outsideNotVerified: string[] = [];
  const listed: FeatureResults[] = [];
  for (const feature of plan.run) {
    const results = readResults(state, feature) ?? [];
    listed.push({ feature, results });
    const registered = featureJourneys(workspace, feature) ?? [];
    for (const id of registered.filter(
      (journey) => !results.some((result) => result.journey === journey),
    ))
      reasons.push(`${feature}/${id} was not run`);
    for (const result of results) {
      if (!registered.includes(result.journey))
        reasons.push(
          `${feature}/${result.journey} is not a registered journey`,
        );
      if (result.status === "FAIL")
        reasons.push(`${feature}/${result.journey} failed`);
      if (result.status === "NOT VERIFIED")
        notVerified.push(`${feature}/${result.journey}: ${result.notVerified}`);
      const stale = staleReuse(state, result);
      if (stale !== null)
        reasons.push(
          `${feature}/${result.journey} reuses ${result.reusedFrom}, which is now ${stale}`,
        );
      rows.push(journeyRow(feature, result));
    }
  }
  for (const feature of featuresOutsidePlan(state, plan)) {
    const results = readResults(state, feature) ?? [];
    listed.push({ feature, results });
    for (const result of results) {
      if (result.status === "FAIL")
        reasons.push(
          `${feature}/${result.journey} failed; ${feature} is outside the diff's features, so check its covers globs`,
        );
      const stale = staleReuse(state, result);
      if (stale !== null)
        reasons.push(
          `${feature}/${result.journey} reuses ${result.reusedFrom}, which is now ${stale}`,
        );
      if (result.status === "NOT VERIFIED")
        outsideNotVerified.push(
          `${feature}/${result.journey}: ${result.notVerified}`,
        );
      rows.push(journeyRow(`${feature} (outside the diff's features)`, result));
    }
  }
  return { rows, reasons, notVerified, outsideNotVerified, listed };
}

function doorReasons(
  workspace: Workspace,
  judgement: Judgement,
  plan: Plan,
): string[] {
  const reasons: string[] = [];
  for (const door of flaggedDoors(workspace, plan.changed))
    for (const file of door.files) {
      const listed = judgement.doors.some(
        (row) => row.kind === door.kind && row.location.includes(file),
      );
      const dismissed = judgement.falsePositives.some(
        (entry) => entry.kind === door.kind && entry.location === file,
      );
      if (!listed && !dismissed)
        reasons.push(
          `path rules flag a ${door.kind} door at ${file} that the One-way doors section neither lists nor dismisses`,
        );
    }
  return reasons;
}

function doorsSection(judgement: Judgement): string[] {
  const dismissed = judgement.falsePositives.map(
    (entry) =>
      `- Not a door: \`${entry.location}\` matches the ${entry.kind} path rules. ${entry.reason}`,
  );
  if (judgement.doors.length === 0)
    return [`None: ${judgement.doorsNone}`, ...dismissed];
  return [
    ...dismissed,
    "| Kind | Location | What cannot be undone | Containment |",
    "|---|---|---|---|",
    ...judgement.doors.map(
      (door) =>
        `| ${door.kind} | \`${door.location}\` | ${door.irreversible} | ${door.containment} |`,
    ),
  ];
}

function formalSection(workspace: Workspace, state: RunState, plan: Plan) {
  const reasons: string[] = [];
  const lines: string[] = [];
  const ran: FormalResult[] = [];
  const touched = touchedFormalChecks(workspace, plan.changed).map(
    (check) => check.name,
  );
  for (const check of workspace.config.formal ?? []) {
    const result = readFormalResult(state, check.name);
    const gate = touched.includes(check.name);
    if (!result) {
      if (gate)
        reasons.push(
          `formal check ${check.name} covers the diff but was not run`,
        );
      continue;
    }
    ran.push(result);
    if (gate && result.behaviour === undefined && result.exitCode === 0)
      reasons.push(
        `formal check ${check.name} covers the diff but its run did not compare the covered behaviour with the base`,
      );
    const weight = formalGate(result);
    if (gate && weight.fails)
      reasons.push(`formal check ${check.name}: ${weight.outcome}`);
    const summary = gate
      ? weight.outcome
      : result.violated.length > 0
        ? `violated: ${result.violated.join(", ")}`
        : `exit ${result.exitCode}, no violated rule`;
    lines.push(
      `\`${check.name}\` (${gate ? "covers the diff, gates the verdict" : "does not cover the diff, informational"}): ${summary}. [evidence](${result.folder})`,
    );
  }
  return { reasons, lines, ran };
}

function docsReasons(judgement: Judgement, plan: Plan): string[] {
  return plan.docs.flatMap((page) => {
    const docs = judgement.docs.find((entry) => entry.page === page);
    if (!docs)
      return [`docs page ${page} of a feature the plan runs has no judgement`];
    return docs.matches ? [] : [`${page} no longer matches the behaviour`];
  });
}

function fullLine(full: FullReason): string {
  return full.reason === "all"
    ? "Every feature must run: the run was created with `--all`, before a release."
    : `Every feature must run: the diff changes shared files ${full.files.map((file) => `\`${file}\``).join(", ")}.`;
}

function resultOf(
  reasons: string[],
  notVerified: string[],
  notes: number,
): VerdictResult {
  if (reasons.length > 0) return "FAIL";
  if (notVerified.length > 0) return "NOT VERIFIED";
  return notes > 0 ? "PASS+NOTES" : "PASS";
}

/** The verdict's Unmapped surfaces section, empty when every changed surface has a feature. */
function unmappedSection(unmapped: string[]): string[] {
  if (unmapped.length === 0) return [];
  return [
    "### Unmapped surfaces",
    ...unmapped.map(
      (file) =>
        `- \`${file}\` matches no feature glob; add it to a feature file.`,
    ),
    "",
  ];
}

/**
 * Computes the verdict of a run from its journey results, the diff plan and
 * the verifier's judgement, and writes verdict.md, verdict.json and plan.json
 * into the evidence folder.
 */
export function renderVerdict(
  workspace: Workspace,
  state: RunState,
  pr: number,
  judgement: Judgement,
): Verdict {
  const plan = planFor(workspace, state.baseRef, state.all);
  const skillSha =
    git(workspace.root, [
      "log",
      "-1",
      "--format=%H",
      "--",
      relative(workspace.root, workspace.skill),
    ]) || plan.headSha;
  const reasons: string[] = [];
  if (plan.headSha !== state.headSha)
    reasons.push(
      `the run was created at ${short(state.headSha)} but HEAD is ${short(plan.headSha)}`,
    );
  const journeys = journeyRows(workspace, state, plan);
  const formal = formalSection(workspace, state, plan);
  reasons.push(
    ...journeys.reasons,
    ...plan.unmapped.map((file) => `unmapped surface ${file}`),
    ...docsReasons(judgement, plan),
    ...doorReasons(workspace, judgement, plan),
    ...formal.reasons,
  );
  const notVerified = [
    ...journeys.notVerified,
    ...journeys.outsideNotVerified,
    ...judgement.notVerified,
  ];
  const result = resultOf(
    reasons,
    journeys.notVerified,
    notVerified.length + judgement.attention.length,
  );
  const timings = timingReport(state.timings, journeys.listed, formal.ran);
  const touched = plan.touched.map(
    (entry) =>
      `\`${entry.feature}\` (diff: ${entry.files.map((file) => `\`${file}\``).join(", ")})`,
  );
  const markdown = [
    `## Verify: ${result}`,
    "",
    "### One-way doors",
    ...doorsSection(judgement),
    "",
    `**Head** \`${short(plan.headSha)}\` · **Skill** \`verify-${workspace.kind}\` @ \`${short(skillSha)}\` (not trusted yet) · **Verifier** ${judgement.verifier}`,
    "",
    "### Touched features",
    ...bullets(touched, "none"),
    `- ${SMOKE_FEATURE}: runs on every verdict`,
    ...(plan.full ? [`- ${fullLine(plan.full)}`] : []),
    "",
    ...unmappedSection(plan.unmapped),
    ...(reasons.length > 0
      ? ["### Why it fails", ...reasons.map((reason) => `- ${reason}`), ""]
      : []),
    "### Journeys",
    "| Feature | Entry point | Result | Evidence |",
    "|---|---|---|---|",
    ...journeys.rows,
    "",
    "### Formal checks",
    ...bullets(formal.lines, "None configured."),
    "",
    "### Docs",
    ...bullets(
      judgement.docs.map(
        (docs) =>
          `\`${docs.page}\`: ${docs.matches ? "matches" : "**stale**"}${docs.note ? `. ${docs.note}` : ""}`,
      ),
      "The plan lists no docs page to judge.",
    ),
    "",
    "### Not verified",
    ...bullets(notVerified, "Nothing."),
    "",
    "### Attention",
    ...bullets(judgement.attention, "Nothing."),
    "",
    "### Timing",
    ...timingTable(timings),
    "",
  ].join("\n");
  writeFileSync(join(state.evidence, "verdict.md"), markdown);
  writeFileSync(
    join(state.evidence, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  writeFileSync(
    join(state.evidence, "verdict.json"),
    `${JSON.stringify({ result, headSha: plan.headSha, skillSha, pr, reasons, timings }, null, 2)}\n`,
  );
  return {
    result,
    headSha: plan.headSha,
    skillSha,
    pr,
    markdown,
    reasons,
  };
}
