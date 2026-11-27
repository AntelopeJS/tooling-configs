/** How a repository's caller departs from the shared triggers and inputs. */
export interface CiProfile {
  /** The branch that collects changes before `main` and whose pushes run the full set, `develop` in cloud; absent on trunk, where the merge queue gates `main`. */
  integrationBranch?: string;
  /** Whether the caller may keep the `windows: true` and `windows-pull-requests` inputs that ask ci-node.yml for Windows on pull requests. */
  windowsOnPullRequests: boolean;
  /** Whether ci-node.yml may run checks and tests in one job; `false` for a repository whose tests take minutes, so its caller passes `single-job: false`. */
  singleJob: boolean;
  /** Whether the `ci` caller needs the hand-written jobs, for a repository whose rulesets require only `ci / checks`; elsewhere the aggregator that needs them with `ci` is the check to require. */
  gateHandJobs: boolean;
}

/** The profile of a repository with no entry of its own. */
export const DEFAULT_PROFILE: CiProfile = {
  windowsOnPullRequests: false,
  singleJob: true,
  gateHandJobs: false,
};

const PROFILES = new Map<string, Partial<CiProfile>>([
  ["@antelopejs/core", { windowsOnPullRequests: true, singleJob: false }],
  ["cloud-sdk-workspace", { windowsOnPullRequests: true }],
  ["@antelopejs-private/cloud", { integrationBranch: "develop" }],
  ["dms-workspace", { singleJob: false }],
  ["@antelopejs/dms-frontend", { singleJob: false }],
  ["@antelopejs/mongodb", { singleJob: false }],
  ["@antelopejs/dms-assistant", { singleJob: false }],
  ["@antelopejs/dms-antelope-cloud", { gateHandJobs: true }],
  ["antelope-web", { gateHandJobs: true }],
]);

/** The CI profile of the repository whose package.json is named `name`; the default for any other name. */
export function ciProfile(name: string | undefined): CiProfile {
  return { ...DEFAULT_PROFILE, ...PROFILES.get(name ?? "") };
}
