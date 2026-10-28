import {
  child,
  children,
  flag,
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

export interface WorkflowRun {
  id: number;
  conclusion: string | undefined;
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  url: string;
  headSha: string;
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
  return {
    number: num(source, "number"),
    title: str(source, "title"),
    author: optStr(child(source, "user"), "login") ?? "",
    createdAt: time(source, "created_at"),
    url: str(source, "html_url"),
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
