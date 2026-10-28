import { perRepo, type Check } from "../check.ts";
import { GardenContext, ORG, type GardenRepo } from "../context.ts";
import { children, num, object, optStr } from "../json.ts";
import { finding, found, skip } from "../types.ts";
import { redSince } from "./ci-health.ts";

const DAY = 24 * 60 * 60 * 1000;
const SCENE = /scene[\s:=]+["']?([A-Za-z0-9._-]+)/gi;

async function sceneIds(
  context: GardenContext,
  repo: GardenRepo,
  runId: number,
): Promise<string[]> {
  const jobs = children(
    object(
      await context.api.json(
        `/repos/${ORG}/${repo.name}/actions/runs/${runId}/jobs`,
      ),
      "jobs",
    ),
    "jobs",
  );
  const ids = new Set<string>();
  for (const job of jobs) {
    const notes = await context.api.pages(
      `/repos/${ORG}/${repo.name}/check-runs/${num(job, "id")}/annotations`,
    );
    for (const note of notes)
      for (const match of optStr(
        object(note, "annotation"),
        "message",
      )?.matchAll(SCENE) ?? [])
        ids.add(match[1]);
  }
  return [...ids].sort();
}

export const captureScenes: Check = {
  id: "capture-scenes",
  async run(context) {
    let wired = 0;
    const result = await perRepo(await context.scope(), async (repo) => {
      const runs = await context.workflowRuns(
        repo,
        "docs-captures.yml",
        repo.defaultBranch,
        "",
      );
      if (runs === undefined) return [];
      wired++;
      const latest = runs[0];
      if (latest === undefined || latest.conclusion !== "failure") return [];
      const ids = await sceneIds(context, repo, latest.id);
      return (ids.length ? ids : ["run"]).map((id) =>
        finding(
          { repo: repo.name, check: "capture-scenes", subject: id },
          `The latest docs-captures.yml run failed${id === "run" ? "" : ` on scene ${id}`}: ${latest.url}`,
          `Every capture scene renders in docs-captures.yml.`,
        ),
      );
    });
    return wired ? result : skip("no repository runs docs-captures.yml yet");
  },
};

const WEB = "antelope-web";

export const webBuild: Check = {
  id: "antelope-web-build",
  async run(context) {
    const repo = (await context.repos()).find(({ name }) => name === WEB);
    if (repo === undefined)
      return skip("antelope-web is not in the organization");
    const workflows = (await context.tree(repo)).filter((path) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path),
    );
    for (const path of workflows) {
      const text = (await context.file(repo, path)) ?? "";
      if (!/^\s*schedule:/m.test(text)) continue;
      const runs =
        (await context.workflowRuns(
          repo,
          path.split("/").pop() ?? "",
          repo.defaultBranch,
          "schedule",
        )) ?? [];
      const since = redSince(runs);
      return found(
        since === undefined ||
          context.api.now().getTime() - since.createdAt <= DAY
          ? []
          : [
              finding(
                { repo: WEB, check: "antelope-web-build", subject: path },
                `${path} has been red since ${new Date(since.createdAt).toISOString()}: ${since.url}`,
                `${path} is green.`,
              ),
            ],
      );
    }
    return skip("antelope-web has no scheduled workflow yet");
  },
};
