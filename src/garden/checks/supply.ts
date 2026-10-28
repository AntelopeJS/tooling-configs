import { perRepo, type Check } from "../check.ts";
import { GardenContext, type GardenRepo } from "../context.ts";
import type { PullRequest } from "../decode.ts";
import { object, optStr, type JsonValue } from "../json.ts";
import { tagVersion } from "../npm.ts";
import { finding, type Finding } from "../types.ts";

const HOUR = 60 * 60 * 1000;
const STUCK_AFTER = 7 * 24 * HOUR;
const ADVISORY_AFTER = 7 * 24 * HOUR;
const CRITICAL_AFTER = 48 * HOUR;
const GROWTH_LIMIT = 1.2;

async function published(context: GardenContext, repo: GardenRepo) {
  return (await context.packages(repo)).filter(
    ({ name, private: hidden }) => name !== undefined && !hidden,
  );
}

async function alerts(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const open = await context.alerts(repo);
  if (open === undefined) return [];
  const now = context.api.now().getTime();
  const shipped = (await published(context, repo)).length > 0;
  const findings: Finding[] = [];
  for (const alert of open) {
    const critical = alert.severity === "critical";
    if (
      !alert.runtime ||
      now - alert.createdAt <= (critical ? CRITICAL_AFTER : ADVISORY_AFTER)
    )
      continue;
    findings.push(
      finding(
        { repo: repo.name, check: "advisories", subject: alert.advisory },
        `${alert.severity} advisory in the runtime dependency ${alert.package}, open since ${new Date(alert.createdAt).toISOString()}: ${alert.url}`,
        `The Dependabot alert ${alert.number} is fixed or dismissed with a reason.`,
        critical && shipped ? "urgent" : "normal",
      ),
    );
  }
  return findings;
}

function isStuck(pull: PullRequest): boolean {
  return (
    pull.author === "renovate[bot]" ||
    /docs captures/i.test(pull.title) ||
    (/registry/i.test(pull.title) && /regenerat/i.test(pull.title))
  );
}

async function stuck(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const now = context.api.now().getTime();
  return (await context.openPulls(repo))
    .filter((pull) => isStuck(pull) && now - pull.createdAt > STUCK_AFTER)
    .map((pull) =>
      finding(
        {
          repo: repo.name,
          check: "stuck-renovate",
          subject: `pr-${pull.number}`,
        },
        `${pull.title} has been open since ${new Date(pull.createdAt).toISOString()}: ${pull.url}`,
        `Pull request ${pull.number} is merged or closed.`,
      ),
    );
}

function versions(packument: JsonValue): string[] {
  return Object.keys(
    object(object(packument, "packument").versions ?? {}, "versions"),
  );
}

function tarball(packument: JsonValue, version: string): string | undefined {
  const entry = object(
    object(packument, "packument").versions ?? {},
    "versions",
  )[version];
  return entry === undefined
    ? undefined
    : optStr(object(object(entry, version).dist ?? {}, "dist"), "tarball");
}

async function size(
  context: GardenContext,
  name: string,
): Promise<{ current: string; newest: string; ratio: number } | undefined> {
  const packument = await context.packument(name);
  const latest =
    packument === undefined ? undefined : tagVersion(packument, "latest");
  if (packument === undefined || latest === undefined) return undefined;
  const all = versions(packument);
  const prerelease = tagVersion(packument, "next");
  const [base, newest] =
    prerelease === undefined ? [all.at(-2), all.at(-1)] : [latest, prerelease];
  const left = newest === undefined ? undefined : tarball(packument, newest);
  const right = base === undefined ? undefined : tarball(packument, base);
  if (
    base === undefined ||
    newest === undefined ||
    newest === base ||
    left === undefined ||
    right === undefined
  )
    return undefined;
  const [next, current] = await Promise.all([
    context.api.contentLength(left),
    context.api.contentLength(right),
  ]);
  return next === undefined || current === undefined || current === 0
    ? undefined
    : { current: base, newest, ratio: next / current };
}

async function grown(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const manifest of await published(context, repo)) {
    const measured =
      manifest.name === undefined
        ? undefined
        : await size(context, manifest.name);
    if (
      manifest.name === undefined ||
      measured === undefined ||
      measured.ratio <= GROWTH_LIMIT
    )
      continue;
    findings.push(
      finding(
        { repo: repo.name, check: "package-size", subject: manifest.name },
        `${manifest.name}@${measured.newest} is ${Math.round((measured.ratio - 1) * 100)}% larger than ${measured.current}.`,
        `The newest tarball is within 20% of latest.`,
      ),
    );
  }
  return findings;
}

export const advisories: Check = {
  id: "advisories",
  async run(context) {
    return perRepo(await context.scope(), (repo) => alerts(context, repo));
  },
};

export const stuckRenovate: Check = {
  id: "stuck-renovate",
  async run(context) {
    return perRepo(await context.scope(), (repo) => stuck(context, repo));
  },
};

export const packageSize: Check = {
  id: "package-size",
  async run(context) {
    return perRepo(await context.scope(), (repo) => grown(context, repo));
  },
};
