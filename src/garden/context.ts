import { ApiError, type GardenApi } from "./api.ts";
import {
  alert,
  artifacts,
  branch,
  checkRuns,
  logins,
  orgRepo,
  packageJson,
  pullRequest,
  workflowRun,
  type Alert,
  type Artifact,
  type Branch,
  type CheckRun,
  type OrgRepo,
  type PackageJson,
  type PullRequest,
  type WorkflowRun,
} from "./decode.ts";
import {
  child,
  children,
  flag,
  list,
  object,
  optStr,
  str,
  time,
  type JsonObject,
  type JsonValue,
} from "./json.ts";

export const ORG = "AntelopeJS";
const PACKS = ["full", "template", "none"] as const;
const TIERS = ["N1", "N2", "N3", "N4"] as const;

type Pack = (typeof PACKS)[number];
type Tier = (typeof TIERS)[number];

export interface GardenRepo extends OrgRepo {
  pack: Pack | undefined;
  tier: Tier | undefined;
}

/** `dms-cicd` and every `cms*` repository are being archived and are never read. */
function isUntouchable(name: string): boolean {
  return name === "dms-cicd" || name.startsWith("cms");
}

function isInScope(repo: GardenRepo): boolean {
  return (
    (repo.pack === "full" || repo.pack === "template") &&
    (repo.tier === "N1" || repo.tier === "N2" || repo.tier === "N3")
  );
}

function isMissing(error: Error): boolean {
  return error instanceof ApiError && error.status === 404;
}

export class Memo<T> {
  private readonly values = new Map<string, Promise<T>>();

  get(key: string, make: () => Promise<T>): Promise<T> {
    let value = this.values.get(key);
    if (value === undefined) {
      value = make();
      this.values.set(key, value);
    }
    return value;
  }
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function pack(value: string | undefined): Pack | undefined {
  return PACKS.find((candidate) => candidate === value);
}

function tier(value: string | undefined): Tier | undefined {
  return TIERS.find((candidate) => candidate === value);
}

function propertyValues(entries: JsonValue[]): Map<string, JsonObject> {
  const byRepo = new Map<string, JsonObject>();
  for (const entry of entries) {
    const source = object(entry, "property values");
    const values: JsonObject = {};
    for (const property of children(source, "properties"))
      values[str(property, "property_name")] = property.value ?? null;
    byRepo.set(str(source, "repository_name"), values);
  }
  return byRepo;
}

/** Reads GitHub and npm through one memoised seam, so every check shares each answer. */
export class GardenContext {
  readonly api: GardenApi;
  private readonly listing = new Memo<GardenRepo[]>();
  private readonly branches = new Memo<string>();
  private readonly trees = new Memo<string[]>();
  private readonly files = new Memo<string | undefined>();
  private readonly manifests = new Memo<PackageJson[]>();
  private readonly runs = new Memo<WorkflowRun[] | undefined>();
  private readonly checks = new Memo<CheckRun[]>();
  private readonly pulls = new Memo<PullRequest[]>();
  private readonly alertLists = new Memo<Alert[] | undefined>();
  private readonly packuments = new Memo<JsonValue | undefined>();
  private readonly removals = new Memo<boolean>();
  private readonly searches = new Memo<Set<string>>();
  private readonly branchLists = new Memo<Branch[]>();
  private readonly closed = new Memo<PullRequest[]>();
  private readonly commitTimes = new Memo<number>();
  private readonly cleanups = new Memo<boolean>();
  private readonly pathChanges = new Memo<number | undefined>();

  constructor(api: GardenApi) {
    this.api = api;
  }

  /** Non-archived repositories, untouchable ones removed, joined with their `pack` and `tier` properties. */
  async repos(): Promise<GardenRepo[]> {
    return (await this.listed()).filter((repo) => !repo.archived);
  }

  /** Names of archived repositories, which the Registry must not list. */
  async archived(): Promise<Set<string>> {
    return new Set(
      (await this.listed())
        .filter((repo) => repo.archived)
        .map((repo) => repo.name),
    );
  }

  private listed(): Promise<GardenRepo[]> {
    return this.listing.get(ORG, async () => {
      const [repos, values] = await Promise.all([
        this.api.pages(`/orgs/${ORG}/repos?type=all`),
        this.api.pages(`/orgs/${ORG}/properties/values`),
      ]);
      const properties = propertyValues(values);
      return repos
        .map(orgRepo)
        .filter((repo) => !isUntouchable(repo.name))
        .map((repo) => {
          const own = properties.get(repo.name) ?? {};
          return {
            ...repo,
            pack: pack(optStr(own, "pack")),
            tier: tier(optStr(own, "tier")),
          };
        })
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    });
  }

  async scope(): Promise<GardenRepo[]> {
    return (await this.repos()).filter(isInScope);
  }

  async targetBranch(repo: GardenRepo): Promise<string> {
    return this.branches.get(repo.name, async () => {
      try {
        await this.api.json(`/repos/${ORG}/${repo.name}/branches/next`);
        return "next";
      } catch (error) {
        if (error instanceof Error && isMissing(error))
          return repo.defaultBranch;
        throw error;
      }
    });
  }

  tree(repo: GardenRepo): Promise<string[]> {
    return this.trees.get(repo.name, async () => {
      const body = object(
        await this.api.json(
          `/repos/${ORG}/${repo.name}/git/trees/${repo.defaultBranch}?recursive=1`,
        ),
        "tree",
      );
      return children(body, "tree").map((entry) => str(entry, "path"));
    });
  }

  file(
    repo: GardenRepo,
    path: string,
    ref = repo.defaultBranch,
  ): Promise<string | undefined> {
    return this.files.get(`${repo.name}:${ref}:${path}`, async () => {
      try {
        return await this.api.text(
          `/repos/${ORG}/${repo.name}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        );
      } catch (error) {
        if (error instanceof Error && isMissing(error)) return undefined;
        throw error;
      }
    });
  }

  /** Every `package.json` within three levels, `node_modules` excluded. */
  packages(repo: GardenRepo): Promise<PackageJson[]> {
    return this.manifests.get(repo.name, async () => {
      const paths = (await this.tree(repo)).filter(
        (path) =>
          /(?:^|\/)package\.json$/.test(path) &&
          !path.includes("node_modules/") &&
          path.split("/").length <= 3,
      );
      const manifests: PackageJson[] = [];
      for (const path of paths) {
        const text = await this.file(repo, path);
        if (text !== undefined) manifests.push(packageJson(path, text));
      }
      return manifests;
    });
  }

  /** Completed runs of a workflow file on a branch, newest first; undefined when the workflow does not exist. */
  workflowRuns(
    repo: GardenRepo,
    workflow: string,
    branch: string,
    event = "push",
  ): Promise<WorkflowRun[] | undefined> {
    return this.runs.get(
      `${repo.name}:${workflow}:${branch}:${event}`,
      async () => {
        try {
          const filter = event === "" ? "" : `&event=${event}`;
          const body = await this.api.json(
            `/repos/${ORG}/${repo.name}/actions/workflows/${workflow}/runs?branch=${branch}${filter}&status=completed&per_page=100`,
          );
          return children(object(body, "runs"), "workflow_runs").map((run) =>
            workflowRun(run),
          );
        } catch (error) {
          if (error instanceof Error && isMissing(error)) return undefined;
          throw error;
        }
      },
    );
  }

  checkRuns(repo: GardenRepo, branch: string): Promise<CheckRun[]> {
    return this.checks.get(`${repo.name}:${branch}`, async () =>
      checkRuns(
        await this.api.json(
          `/repos/${ORG}/${repo.name}/commits/${branch}/check-runs?per_page=100`,
        ),
      ),
    );
  }

  openPulls(repo: GardenRepo): Promise<PullRequest[]> {
    return this.pulls.get(repo.name, async () =>
      (await this.api.pages(`/repos/${ORG}/${repo.name}/pulls?state=open`)).map(
        pullRequest,
      ),
    );
  }

  /** Every branch of the repository, protected ones flagged. */
  branchList(repo: GardenRepo): Promise<Branch[]> {
    return this.branchLists.get(repo.name, async () =>
      (await this.api.pages(`/repos/${ORG}/${repo.name}/branches`)).map(branch),
    );
  }

  /** Closed and merged pull requests whose head is the branch of this repository, not a fork's namesake. */
  closedPulls(repo: GardenRepo, name: string): Promise<PullRequest[]> {
    return this.closed.get(`${repo.name}:${name}`, async () =>
      (
        await this.api.pages(
          `/repos/${ORG}/${repo.name}/pulls?state=closed&head=${ORG}:${encodeURIComponent(name)}`,
        )
      )
        .map(pullRequest)
        .filter(
          (pull) =>
            pull.head === name && pull.headRepo === `${ORG}/${repo.name}`,
        ),
    );
  }

  /** When the commit was committed, in milliseconds. */
  commitTime(repo: GardenRepo, sha: string): Promise<number> {
    return this.commitTimes.get(`${repo.name}:${sha}`, async () => {
      const body = object(
        await this.api.json(`/repos/${ORG}/${repo.name}/commits/${sha}`),
        "commit",
      );
      return time(child(child(body, "commit"), "committer"), "date");
    });
  }

  /** When the newest commit of the branch that touched the path was committed, in milliseconds; undefined when none did. */
  lastChange(
    repo: GardenRepo,
    path: string,
    branch: string,
  ): Promise<number | undefined> {
    return this.pathChanges.get(`${repo.name}:${branch}:${path}`, async () => {
      const [newest] = list(
        await this.api.json(
          `/repos/${ORG}/${repo.name}/commits?path=${path}&sha=${encodeURIComponent(branch)}&per_page=1`,
        ),
        "commits",
      );
      return newest === undefined
        ? undefined
        : time(
            child(child(object(newest, "commit"), "commit"), "committer"),
            "date",
          );
    });
  }

  /** Whether GitHub deletes a pull request's head branch once it merges. */
  deletesBranchOnMerge(repo: GardenRepo): Promise<boolean> {
    return this.cleanups.get(repo.name, async () => {
      const body = object(
        await this.api.json(`/repos/${ORG}/${repo.name}`),
        "repository",
      );
      if (!Object.hasOwn(body, "delete_branch_on_merge"))
        throw new Error(
          "delete_branch_on_merge is not readable; merge settings need a token with contents write access",
        );
      return flag(body, "delete_branch_on_merge");
    });
  }

  /** Open alerts, or undefined when Dependabot alerts are disabled for the repository. */
  alerts(repo: GardenRepo): Promise<Alert[] | undefined> {
    return this.alertLists.get(repo.name, async () => {
      try {
        return (
          await this.api.pages(
            `/repos/${ORG}/${repo.name}/dependabot/alerts?state=open`,
          )
        ).map(alert);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 403 &&
          /disabled/i.test(error.message)
        )
          return undefined;
        throw error;
      }
    });
  }

  async exists(repo: string, path: string, ref?: string): Promise<boolean> {
    try {
      await this.api.json(
        `/repos/${ORG}/${repo}/contents/${path}${ref === undefined ? "" : `?ref=${ref}`}`,
      );
      return true;
    } catch (error) {
      if (error instanceof Error && isMissing(error)) return false;
      throw error;
    }
  }

  /** Whether a commit of the default branch history removed the file; looks at the 30 newest commits that touched it. */
  removedInHistory(repo: GardenRepo, path: string): Promise<boolean> {
    return this.removals.get(`${repo.name}:${path}`, async () => {
      const commits = list(
        await this.api.json(
          `/repos/${ORG}/${repo.name}/commits?path=${path}&sha=${repo.defaultBranch}&per_page=30`,
        ),
        "commits",
      );
      for (const commit of commits) {
        const detail = object(
          await this.api.json(
            `/repos/${ORG}/${repo.name}/commits/${str(object(commit, "commit"), "sha")}`,
          ),
          "commit",
        );
        if (
          children(detail, "files").some(
            (file) =>
              str(file, "filename") === path &&
              optStr(file, "status") === "removed",
          )
        )
          return true;
      }
      return false;
    });
  }

  packument(name: string): Promise<JsonValue | undefined> {
    return this.packuments.get(name, () => this.api.npm(name));
  }

  /** Names of repositories holding an issue or pull request authored by the Renovate app. */
  renovateRepos(): Promise<Set<string>> {
    return this.searches.get("renovate", async () => {
      const hits = await this.api.pages(
        `/search/issues?q=${encodeURIComponent(`org:${ORG} author:app/renovate`)}`,
        "items",
      );
      return new Set(
        hits.map(
          (hit) =>
            str(object(hit, "issue"), "repository_url").split("/").pop() ?? "",
        ),
      );
    });
  }

  async artifactsNamed(repo: string, name: string): Promise<Artifact[]> {
    const body = await this.api.json(
      `/repos/${ORG}/${repo}/actions/artifacts?name=${name}&per_page=100`,
    );
    return artifacts(body)
      .filter((artifact) => !artifact.expired)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  organizationOwners(): Promise<string[]> {
    return this.api.pages(`/orgs/${ORG}/members?role=admin`).then(logins);
  }
}
