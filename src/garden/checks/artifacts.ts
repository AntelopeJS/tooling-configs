import type { Check } from "../check.ts";
import { GardenContext, ORG } from "../context.ts";
import { list, object, parseJson, str, type JsonObject } from "../json.ts";
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
