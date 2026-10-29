import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { JourneyResult } from "./results.ts";
import { flaggedDoors } from "./doors.ts";
import { readFormalResult, touchedFormalChecks } from "./formal.ts";
import type { Judgement } from "./judgement.ts";
import { planFor, SMOKE_FEATURE, type Plan } from "./map.ts";
import { featureJourneys, readResults } from "./runner.ts";
import { git, type RunState, type Workspace } from "./workspace.ts";

/** The overall result a verdict carries; NOT VERIFIED when a journey could not reach the product, never PASS. */
export type VerdictResult = "PASS" | "PASS+NOTES" | "NOT VERIFIED" | "FAIL";

/** A rendered verdict and the facts it was computed from. */
export interface Verdict {
  result: VerdictResult;
  headSha: string;
  skillSha: string;
  pr: number;
  repository: string;
  markdown: string;
  reasons: string[];
}

const CONTAINED_KINDS = new Set(["data", "format"]);

/** The GitHub `owner/repo` of the origin remote. */
function originRepository(root: string): string {
  const url = git(root, ["remote", "get-url", "origin"]);
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(url);
  if (!match) throw new Error(`origin ${url} is not a GitHub repository`);
  return match[1];
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function bullets(entries: string[], empty: string): string[] {
  return (entries.length > 0 ? entries : [empty]).map((entry) => `- ${entry}`);
}

function journeyRows(
  workspace: Workspace,
  state: RunState,
  plan: Plan,
  link: (path: string) => string,
) {
  const rows: string[] = [];
  const reasons: string[] = [];
  const notVerified: string[] = [];
  const byJourney = new Map<string, JourneyResult>();
  for (const feature of plan.run) {
    const results = readResults(state, feature) ?? [];
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
      byJourney.set(`${feature}/${result.journey}`, result);
      if (result.status === "FAIL")
        reasons.push(`${feature}/${result.journey} failed`);
      if (result.status === "NOT VERIFIED")
        notVerified.push(`${feature}/${result.journey}: ${result.notVerified}`);
      const outcome =
        result.status === "PASS"
          ? "pass"
          : result.status === "FAIL"
            ? "**fail**"
            : "**not verified**";
      rows.push(
        `| ${feature} | \`${result.journey}\`: ${result.entryPoint} | ${outcome}: ${result.title} | [${result.folder}](${link(result.folder)}) |`,
      );
    }
  }
  return { rows, reasons, notVerified, byJourney };
}

function doorReasons(
  workspace: Workspace,
  judgement: Judgement,
  results: Map<string, JourneyResult>,
  plan: Plan,
): string[] {
  const reasons: string[] = [];
  for (const row of judgement.doors.filter((door) =>
    CONTAINED_KINDS.has(door.kind),
  )) {
    const allowed = workspace.config.doors[row.kind]?.containments ?? [];
    const journey = results.get(row.containmentJourney);
    if (!allowed.includes(row.containmentJourney))
      reasons.push(
        `${row.kind} door at ${row.location} names ${row.containmentJourney || "no journey"}; its containment must be one of ${allowed.join(", ") || "the kind's containments in verify.config.ts, which lists none"}`,
      );
    else if (journey?.status !== "PASS")
      reasons.push(
        `${row.kind} door at ${row.location}: containment journey ${row.containmentJourney} did not pass in this run`,
      );
  }
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
        `| ${door.kind} | \`${door.location}\` | ${door.irreversible} | ${door.containment}${door.containmentJourney ? ` (journey \`${door.containmentJourney}\`)` : ""} |`,
    ),
  ];
}

function formalSection(
  workspace: Workspace,
  state: RunState,
  plan: Plan,
  link: (path: string) => string,
) {
  const reasons: string[] = [];
  const lines: string[] = [];
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
    if (gate && (result.violated.length > 0 || result.exitCode !== 0))
      reasons.push(
        `formal check ${check.name}: ${result.violated.length > 0 ? `violated ${result.violated.join(", ")}` : `exit ${result.exitCode}`}`,
      );
    const summary =
      result.violated.length > 0
        ? `violated: ${result.violated.join(", ")}`
        : `exit ${result.exitCode}, no violated rule`;
    lines.push(
      `\`${check.name}\` (${gate ? "covers the diff, gates the verdict" : "does not cover the diff, informational"}): ${summary}. [evidence](${link(result.folder)})`,
    );
  }
  return { reasons, lines };
}

function docsReasons(judgement: Judgement, plan: Plan): string[] {
  return plan.docs.flatMap((page) => {
    const docs = judgement.docs.find((entry) => entry.page === page);
    if (!docs)
      return [`docs page ${page} of a touched feature has no judgement`];
    return docs.matches ? [] : [`${page} no longer matches the behaviour`];
  });
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
  const plan = planFor(workspace, state.baseRef);
  const repository = originRepository(workspace.root);
  const skillSha =
    git(workspace.root, [
      "log",
      "-1",
      "--format=%H",
      "--",
      relative(workspace.root, workspace.skill),
    ]) || plan.headSha;
  const link = (path: string) =>
    `https://github.com/${repository}/tree/verify-evidence/pr-${pr}/${plan.headSha}/${path}`;
  const reasons: string[] = [];
  if (plan.headSha !== state.headSha)
    reasons.push(
      `the run was created at ${short(state.headSha)} but HEAD is ${short(plan.headSha)}`,
    );
  const journeys = journeyRows(workspace, state, plan, link);
  const formal = formalSection(workspace, state, plan, link);
  reasons.push(
    ...journeys.reasons,
    ...plan.unmapped.map((file) => `unmapped surface ${file}`),
    ...docsReasons(judgement, plan),
    ...doorReasons(workspace, judgement, journeys.byJourney, plan),
    ...formal.reasons,
  );
  const notVerified = [...journeys.notVerified, ...judgement.notVerified];
  const result = resultOf(
    reasons,
    journeys.notVerified,
    notVerified.length + judgement.attention.length,
  );
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
    "",
    ...(plan.unmapped.length > 0
      ? [
          "### Unmapped surfaces",
          ...plan.unmapped.map(
            (file) =>
              `- \`${file}\` matches no feature glob; add it to a feature file.`,
          ),
          "",
        ]
      : []),
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
      "No touched feature links a page.",
    ),
    "",
    "### Not verified",
    ...bullets(notVerified, "Nothing."),
    "",
    "### Attention",
    ...bullets(judgement.attention, "Nothing."),
    "",
    `Evidence: \`verify-evidence\` branch, [\`pr-${pr}/${plan.headSha}/\`](${link("")})`,
    "",
  ].join("\n");
  writeFileSync(join(state.evidence, "verdict.md"), markdown);
  writeFileSync(
    join(state.evidence, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  writeFileSync(
    join(state.evidence, "verdict.json"),
    `${JSON.stringify({ result, headSha: plan.headSha, skillSha, pr, reasons }, null, 2)}\n`,
  );
  return {
    result,
    headSha: plan.headSha,
    skillSha,
    pr,
    repository,
    markdown,
    reasons,
  };
}
