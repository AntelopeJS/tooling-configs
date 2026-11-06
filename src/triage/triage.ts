import type { Graphql } from "../garden/api.ts";
import {
  child,
  children,
  flag,
  num,
  object,
  optStr,
  str,
  time,
  type JsonValue,
} from "../garden/json.ts";

type Kind = "bug" | "feature" | "other";

/** An open issue as the search returns it, before ranking. */
interface Issue {
  ref: string;
  url: string;
  kind: Kind;
  title: string;
  firstLine: string;
  createdAt: number;
  thumbsUp: number;
  linkedOpenPulls: number;
}

/** One shortlisted issue, as `--json` prints it. */
interface Item {
  ref: string;
  url: string;
  kind: Kind;
  title: string;
  firstLine: string;
  created: string;
}

export interface Shortlist {
  items: Item[];
  notShown: number;
}

/** Open, unassigned issues labelled `needs-triage` in the organization's public, non-archived repositories. */
const SEARCH =
  "org:AntelopeJS is:issue is:open is:public archived:false label:needs-triage no:assignee";

const LIMIT = 10;
const FIRST_LINE_LENGTH = 200;
const KIND_ORDER = { bug: 0, feature: 1, other: 2 } satisfies Record<
  Kind,
  number
>;

const QUERY = `query($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number title url body createdAt
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        issueType { name }
        reactions(content: THUMBS_UP) { totalCount }
        closedByPullRequestsReferences(first: 1, includeClosedPrs: false) { totalCount }
      }
    }
  }
}`;

/** The `bug` or `feature` label decides; without either, the issue type does. */
function kind(labels: string[], type: string | undefined): Kind {
  if (labels.includes("bug")) return "bug";
  if (labels.includes("feature")) return "feature";
  if (type === "Bug") return "bug";
  if (type === "Feature") return "feature";
  return "other";
}

/** The first line that carries text: blank lines, Markdown headings, HTML comments and an issue form's `_No response_` are skipped. */
function firstLine(body: string): string {
  const line = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry !== "" && !entry.startsWith("#") && entry !== "_No response_",
    );
  return (line ?? "").slice(0, FIRST_LINE_LENGTH);
}

function issue(value: JsonValue): Issue {
  const source = object(value, "issue");
  const labels = children(child(source, "labels"), "nodes").map((label) =>
    str(label, "name"),
  );
  const type = Object.hasOwn(source, "issueType") ? source.issueType : null;
  return {
    ref: `${str(child(source, "repository"), "nameWithOwner")}#${num(source, "number")}`,
    url: str(source, "url"),
    kind: kind(
      labels,
      type === null ? undefined : optStr(object(type, "issueType"), "name"),
    ),
    title: str(source, "title"),
    firstLine: firstLine(optStr(source, "body") ?? ""),
    createdAt: time(source, "createdAt"),
    thumbsUp: num(child(source, "reactions"), "totalCount"),
    linkedOpenPulls: num(
      child(source, "closedByPullRequestsReferences"),
      "totalCount",
    ),
  };
}

/** Bugs before features before the rest, then most 👍 first, then oldest first; the reference breaks a tie. */
function compare(a: Issue, b: Issue): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    b.thumbsUp - a.thumbsUp ||
    a.createdAt - b.createdAt ||
    (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
  );
}

/** Drops issues an open pull request is linked to, ranks the rest and keeps the first {@link LIMIT}. */
function rank(issues: Issue[]): Shortlist {
  const open = issues
    .filter((entry) => entry.linkedOpenPulls === 0)
    .sort(compare);
  return {
    items: open.slice(0, LIMIT).map((entry) => ({
      ref: entry.ref,
      url: entry.url,
      kind: entry.kind,
      title: entry.title,
      firstLine: entry.firstLine,
      created: new Date(entry.createdAt).toISOString().slice(0, 10),
    })),
    notShown: Math.max(open.length - LIMIT, 0),
  };
}

/** Reads every page of the search and ranks it. */
export async function triage(graphql: Graphql): Promise<Shortlist> {
  const issues: Issue[] = [];
  for (let after: string | undefined, more = true; more;) {
    const search = child(
      object(
        await graphql(
          QUERY,
          after === undefined ? { q: SEARCH } : { q: SEARCH, after },
        ),
        "data",
      ),
      "search",
    );
    issues.push(
      ...children(search, "nodes")
        .filter((node) => Object.keys(node).length > 0)
        .map(issue),
    );
    const page = child(search, "pageInfo");
    after = optStr(page, "endCursor");
    more = flag(page, "hasNextPage") && after !== undefined;
  }
  return rank(issues);
}

/** One line per shortlisted issue and one for the rest; nothing when no issue waits. */
export function lines(shortlist: Shortlist): string[] {
  return [
    ...shortlist.items.map(
      (entry) => `${entry.ref} ${entry.kind} ${entry.created} ${entry.title}`,
    ),
    ...(shortlist.notShown > 0 ? [`${shortlist.notShown} more not shown`] : []),
  ];
}
