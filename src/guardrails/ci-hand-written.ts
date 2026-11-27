import type { Document, YAMLMap } from "yaml";

import { moveFormalChecks, type FormalPlan } from "./ci-formal.ts";
import { wireGate } from "./ci-gate.ts";
import { rewriteHandJobs, type Settled } from "./ci-hand-jobs.ts";

/**
 * Keeps the hand-written jobs of the workflow at `path`, those with no job-level `uses`, in step with the org's CI
 * conventions. With a `formal` plan, the formal checks move into the `formal-checks` input of `caller`
 * ({@link moveFormalChecks}). Each job then gets a Blacksmith runner, pinned actions and the pull request `concurrency`
 * ({@link rewriteHandJobs}), and joins the `needs` of `caller`, so a failing job fails `ci / checks` ({@link wireGate}).
 * The advisories name what it cannot fix: a runner no literal label stands for, and a job `ci / checks` does not cover.
 */
export function settleHandWritten(
  document: Document,
  jobs: YAMLMap,
  caller: { id: string; job: YAMLMap },
  formal: FormalPlan | undefined,
  path: string,
): Settled {
  const moved =
    formal !== undefined &&
    moveFormalChecks(document, jobs, caller.job, formal, path);
  const hand = rewriteHandJobs(document, jobs, path);
  const gate = wireGate(document, jobs, caller.id, path);
  return {
    changed: moved || hand.changed || gate.changed,
    advisories: [...hand.advisories, ...gate.advisories],
  };
}
