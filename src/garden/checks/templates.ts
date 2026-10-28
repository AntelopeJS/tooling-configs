import { perRepo, type Check } from "../check.ts";
import { GardenContext, ORG, type GardenRepo } from "../context.ts";
import {
  child,
  children,
  object,
  optStr,
  parseJson,
  str,
  type JsonObject,
  type JsonValue,
} from "../json.ts";
import { admits } from "../semver.ts";
import { TOOLING_PACKAGE, tagVersion } from "../npm.ts";
import { finding, found, skip, type Finding } from "../types.ts";

const DAY = 24 * 60 * 60 * 1000;
const INTERFACES = "interfaces";
const REGISTRY_BIN = "antelopejs-registry";
const SCOPE = "@antelopejs/";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

async function templates(context: GardenContext): Promise<GardenRepo[]> {
  return (await context.repos()).filter((repo) => repo.pack === "template");
}

async function registryShipped(context: GardenContext): Promise<boolean> {
  const packument = await context.packument(TOOLING_PACKAGE);
  const latest =
    packument === undefined ? undefined : tagVersion(packument, "latest");
  if (packument === undefined || latest === undefined) return false;
  const bin = child(
    object(object(packument, "packument").versions ?? {}, "versions"),
    latest,
  );
  return Object.keys(child(bin, "bin")).includes(REGISTRY_BIN);
}

function listedTemplates(manifest: JsonObject): string[] {
  return [
    ...children(manifest, "templates"),
    ...children(manifest, "projectTemplates"),
  ].map(
    (entry) => /([^/]+?)(?:\.git)?$/.exec(str(entry, "repository"))?.[1] ?? "",
  );
}

async function declaredRanges(
  context: GardenContext,
  repo: GardenRepo,
): Promise<{ name: string; range: string }[]> {
  const ranges: { name: string; range: string }[] = [];
  for (const manifest of await context.packages(repo)) {
    const source = object(
      parseJson((await context.file(repo, manifest.path)) ?? "{}"),
      manifest.path,
    );
    for (const field of DEPENDENCY_FIELDS) {
      const group = child(source, field);
      for (const name of Object.keys(group).filter((key) =>
        key.startsWith(SCOPE),
      ))
        ranges.push({ name, range: optStr(group, name) ?? "" });
    }
  }
  return ranges;
}

function publishedAt(
  packument: JsonValue,
  version: string,
): number | undefined {
  const moment = child(object(packument, "packument"), "time")[version];
  return moment === undefined ? undefined : Date.parse(String(moment));
}

async function behind(
  context: GardenContext,
  repo: GardenRepo,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const now = context.api.now().getTime();
  for (const { name, range } of await declaredRanges(context, repo)) {
    const packument = await context.packument(name);
    const latest =
      packument === undefined ? undefined : tagVersion(packument, "latest");
    const released =
      packument === undefined || latest === undefined
        ? undefined
        : publishedAt(packument, latest);
    if (
      latest === undefined ||
      released === undefined ||
      admits(range, latest) ||
      now - released <= 7 * DAY
    )
      continue;
    findings.push(
      finding(
        { repo: repo.name, check: "template-behind-latest", subject: name },
        `${name} ${range} excludes ${latest}, published ${new Date(released).toISOString()}.`,
        `The range of ${name} admits ${latest}.`,
      ),
    );
  }
  return findings;
}

export const templateBehindLatest: Check = {
  id: "template-behind-latest",
  async run(context) {
    const repos = await templates(context);
    let described = false;
    for (const repo of repos)
      described ||= (await context.packages(repo)).some(
        ({ hasTemplate }) => hasTemplate,
      );
    return described
      ? perRepo(repos, (repo) => behind(context, repo))
      : skip("no template declares antelopeJs.template yet");
  },
};

export const templateMembership: Check = {
  id: "template-membership",
  async run(context) {
    if (!(await registryShipped(context)))
      return skip(`${REGISTRY_BIN} is not released yet`);
    const manifest = object(
      parseJson(
        await context.api.text(
          `/repos/${ORG}/${INTERFACES}/contents/manifest.json`,
        ),
      ),
      "manifest",
    );
    const listed = listedTemplates(manifest);
    const archived = await context.archived();
    return found([
      ...(await templates(context))
        .filter((repo) => !listed.includes(repo.name))
        .map((repo) =>
          finding(
            {
              repo: repo.name,
              check: "template-membership",
              subject: "missing",
            },
            `${repo.name} has pack=template and is not in the Registry.`,
            `${repo.name} is listed under templates or projectTemplates.`,
          ),
        ),
      ...listed
        .filter((name) => archived.has(name))
        .map((name) =>
          finding(
            {
              repo: INTERFACES,
              check: "template-membership",
              subject: `archived:${name}`,
            },
            `The Registry lists the archived repository ${name}.`,
            `The entry for ${name} is removed.`,
          ),
        ),
    ]);
  },
};

export const staleRegistry: Check = {
  id: "stale-registry",
  async run(context) {
    if (!(await registryShipped(context)))
      return skip(`${REGISTRY_BIN} is not released yet`);
    const interfaces = (await context.repos()).find(
      ({ name }) => name === INTERFACES,
    );
    if (interfaces === undefined)
      return skip("AntelopeJS/interfaces is not in the organization");
    const files = await context.tree(interfaces);
    const contents = await Promise.all(
      files
        .filter((path) => path.endsWith(".json"))
        .map(async (path) => ({
          path,
          content: (await context.file(interfaces, path)) ?? "",
        })),
    );
    if (!(await context.api.registryDiffers(contents))) return found([]);
    const now = context.api.now().getTime();
    const open = (await context.openPulls(interfaces)).find((pull) =>
      /regenerat/i.test(pull.title),
    );
    if (open !== undefined && now - open.createdAt <= DAY) return found([]);
    const evidence =
      open === undefined
        ? "The Registry output differs from the committed manifests and no regeneration PR is open."
        : `The regeneration PR has been open since ${new Date(open.createdAt).toISOString()}: ${open.url}`;
    return found([
      finding(
        { repo: INTERFACES, check: "stale-registry", subject: "manifests" },
        evidence,
        "The committed manifests match antelopejs-registry output.",
      ),
    ]);
  },
};

const CANARY = "template-canary.yml";

export const templateCanary: Check = {
  id: "template-canary",
  async run(context) {
    let wired = 0;
    const result = await perRepo(await templates(context), async (repo) => {
      const runs = await context.workflowRuns(
        repo,
        CANARY,
        repo.defaultBranch,
        "",
      );
      if (runs === undefined) return [];
      wired++;
      const latest = runs[0];
      return latest?.conclusion === "failure"
        ? [
            finding(
              { repo: repo.name, check: "template-canary", subject: "canary" },
              `The latest ${CANARY} run is red: ${latest.url}`,
              `${CANARY} is green with every @antelopejs/* dependency on next.`,
            ),
          ]
        : [];
    });
    return wired ? result : skip(`no template runs ${CANARY} yet`);
  },
};
