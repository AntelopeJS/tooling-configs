import {
  child,
  children,
  flag,
  isObject,
  list,
  num,
  object,
  optStr,
  optTime,
  str,
  time,
  type JsonValue,
} from "./json.ts";

export interface OrgRepo {
  name: string;
  archived: boolean;
  isPrivate: boolean;
  language: string | undefined;
  defaultBranch: string;
}

/** A reusable workflow a run called, as `path@ref` pinned to the commit `sha` it resolved to. */
interface ReferencedWorkflow {
  path: string;
  sha: string;
}

export interface WorkflowRun {
  id: number;
  conclusion: string | undefined;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  url: string;
  headSha: string;
  /** Empty when the run called no reusable workflow or the payload predates the field. */
  referencedWorkflows: ReferencedWorkflow[];
}

export interface CheckRun {
  id: number;
  name: string;
  conclusion: string | undefined;
  url: string;
  summary: string;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  createdAt: number;
  url: string;
  /** Branch name the pull request merges from. */
  head: string;
  /** `owner/name` of the repository holding the head branch; undefined once a fork is deleted. */
  headRepo: string | undefined;
  headSha: string;
  /** Branch name the pull request merges into. */
  base: string;
  merged: boolean;
}

export interface Branch {
  name: string;
  protected: boolean;
  sha: string;
}

export interface Alert {
  number: number;
  advisory: string;
  severity: string;
  runtime: boolean;
  createdAt: number;
  url: string;
  package: string;
}

export interface PackageJson {
  path: string;
  name: string | undefined;
  private: boolean;
  tooling: string | undefined;
  hasTemplate: boolean;
}

export interface Artifact {
  id: number;
  name: string;
  createdAt: number;
  expired: boolean;
  runId: number;
}

export function orgRepo(value: JsonValue): OrgRepo {
  const source = object(value, "repository");
  return {
    name: str(source, "name"),
    archived: flag(source, "archived"),
    isPrivate: flag(source, "private"),
    language: optStr(source, "language"),
    defaultBranch: optStr(source, "default_branch") ?? "main",
  };
}

export function workflowRun(value: JsonValue): WorkflowRun {
  const source = object(value, "workflow run");
  const created = time(source, "created_at");
  return {
    id: num(source, "id"),
    conclusion: optStr(source, "conclusion"),
    createdAt: created,
    startedAt: optTime(source, "run_started_at") ?? created,
    updatedAt: time(source, "updated_at"),
    url: str(source, "html_url"),
    headSha: optStr(source, "head_sha") ?? "",
    referencedWorkflows: (source.referenced_workflows === null
      ? []
      : children(source, "referenced_workflows")
    ).map((workflow) => ({
      path: str(workflow, "path"),
      sha: optStr(workflow, "sha") ?? "",
    })),
  };
}

export function checkRuns(value: JsonValue): CheckRun[] {
  return children(object(value, "check runs"), "check_runs").map((source) => ({
    id: num(source, "id"),
    name: str(source, "name"),
    conclusion: optStr(source, "conclusion"),
    url: optStr(source, "html_url") ?? "",
    summary: optStr(child(source, "output"), "summary") ?? "",
  }));
}

export function pullRequest(value: JsonValue): PullRequest {
  const source = object(value, "pull request");
  const head = child(source, "head");
  return {
    number: num(source, "number"),
    title: str(source, "title"),
    author: optStr(child(source, "user"), "login") ?? "",
    createdAt: time(source, "created_at"),
    url: str(source, "html_url"),
    head: optStr(head, "ref") ?? "",
    headRepo: isObject(head.repo) ? optStr(head.repo, "full_name") : undefined,
    headSha: optStr(head, "sha") ?? "",
    base: optStr(child(source, "base"), "ref") ?? "",
    merged: optStr(source, "merged_at") !== undefined,
  };
}

export function branch(value: JsonValue): Branch {
  const source = object(value, "branch");
  return {
    name: str(source, "name"),
    protected: flag(source, "protected"),
    sha: str(child(source, "commit"), "sha"),
  };
}

export function alert(value: JsonValue): Alert {
  const source = object(value, "alert");
  const advisory = child(source, "security_advisory");
  const dependency = child(source, "dependency");
  return {
    number: num(source, "number"),
    advisory: optStr(advisory, "ghsa_id") ?? String(num(source, "number")),
    severity: optStr(advisory, "severity") ?? "unknown",
    runtime: optStr(dependency, "scope") === "runtime",
    createdAt: time(source, "created_at"),
    url: str(source, "html_url"),
    package: optStr(child(dependency, "package"), "name") ?? "unknown",
  };
}

export function packageJson(path: string, text: string): PackageJson {
  const source = object(JSON.parse(text), path);
  const antelope = child(source, "antelopeJs");
  const tooling = [source.dependencies, source.devDependencies]
    .map((group) =>
      group === undefined
        ? undefined
        : optStr(object(group, path), "@antelopejs/tooling-configs"),
    )
    .find((range) => range !== undefined);
  return {
    path,
    name: optStr(source, "name"),
    private: flag(source, "private"),
    tooling,
    hasTemplate: antelope.template !== undefined,
  };
}

export function artifacts(value: JsonValue): Artifact[] {
  return children(object(value, "artifacts"), "artifacts").map((source) => ({
    id: num(source, "id"),
    name: str(source, "name"),
    createdAt: time(source, "created_at"),
    expired: flag(source, "expired"),
    runId: num(child(source, "workflow_run"), "id"),
  }));
}

export function logins(value: JsonValue): string[] {
  return list(value, "members").map((entry) =>
    str(object(entry, "member"), "login"),
  );
}

/** The logins of a collaborator list whose role on the repository is `admin`; `maintain` is not. */
export function adminLogins(value: JsonValue): string[] {
  return list(value, "collaborators")
    .map((entry) => object(entry, "collaborator"))
    .filter((entry) => optStr(entry, "role_name") === "admin")
    .map((entry) => str(entry, "login"));
}
