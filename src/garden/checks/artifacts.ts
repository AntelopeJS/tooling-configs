import type { Check } from "../check.ts";
import { GardenContext, ORG } from "../context.ts";
import {
  children,
  list,
  object,
  optStr,
  parseJson,
  str,
  type JsonObject,
} from "../json.ts";
import { firstZipEntry } from "../zip.ts";
import { finding, found, skip, type Finding } from "../types.ts";

const WORKFLOWS_REPO = ".github";

async function latestReport(
  context: GardenContext,
  repo: string,
  name: string,
): Promise<JsonObject | undefined> {
  const [latest] = await context.artifactsNamed(repo, name);
  if (latest === undefined) return undefined;
  const archive = await context.api.bytes(
    `/repos/${ORG}/${repo}/actions/artifacts/${latest.id}/zip`,
  );
  return object(parseJson(firstZipEntry(archive)), name);
}

function survivors(
  report: JsonObject,
): { file: string; survived: number; total: number }[] {
  const files = object(report.files ?? {}, "files");
  return Object.keys(files).map((file) => {
    const mutants = children(object(files[file], file), "mutants");
    return {
      file,
      survived: mutants.filter(
        (mutant) => optStr(mutant, "status") === "Survived",
      ).length,
      total: mutants.length,
    };
  });
}

export const mutation: Check = {
  id: "mutation",
  async run(context) {
    if (
      !(await context.exists(WORKFLOWS_REPO, ".github/workflows/mutation.yml"))
    )
      return skip("AntelopeJS/.github has no mutation.yml yet");
    const repos = (await context.scope()).filter(
      (repo) => repo.tier === "N1" || repo.tier === "N2",
    );
    const findings: Finding[] = [];
    let reports = 0;
    for (const repo of repos) {
      const report = await latestReport(context, repo.name, "mutation-report");
      if (report === undefined) continue;
      reports++;
      for (const { file, survived, total } of survivors(report))
        if (survived > 0)
          findings.push(
            finding(
              { repo: repo.name, check: "mutation", subject: file },
              `${survived} of ${total} mutants survive in ${file}.`,
              `Tests kill the surviving mutants of ${file}, or Stryker ignores them with a reason.`,
            ),
          );
    }
    return reports
      ? found(findings)
      : skip(
          "no mutation-report artifact exists in any N1 or N2 repository yet",
        );
  },
};

export const linkRot: Check = {
  id: "link-rot",
  async run(context) {
    if (
      !(await context.exists(WORKFLOWS_REPO, ".github/workflows/link-rot.yml"))
    )
      return skip("AntelopeJS/.github has no link-rot.yml yet");
    const report = await latestReport(context, WORKFLOWS_REPO, "link-rot");
    if (report === undefined) return skip("no link-rot artifact exists yet");
    const repos = object(report.repos ?? {}, "repos");
    const findings: Finding[] = [];
    for (const repo of Object.keys(repos)) {
      const files = object(repos[repo], repo);
      for (const file of Object.keys(files)) {
        const links = list(files[file], file).map((link) => object(link, file));
        if (links.length)
          findings.push(
            finding(
              { repo: repo, check: "link-rot", subject: file },
              `${links.length} dead external links in ${file}: ${links.map((link) => str(link, "url")).join(", ")}`,
              `Every external link in ${file} resolves.`,
            ),
          );
      }
    }
    return found(findings);
  },
};
