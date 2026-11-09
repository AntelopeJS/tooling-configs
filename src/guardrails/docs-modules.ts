import { tableLines } from "./markdown-table.ts";

export const DMS_MODULES_START = "<!-- antelopejs-dms-modules:start -->";
export const DMS_MODULES_END = "<!-- antelopejs-dms-modules:end -->";

const ORGANIZATION = "https://github.com/AntelopeJS";

/** One AntelopeJS DMS module: its repository name and what it adds to a DMS. */
interface DmsModule {
  repo: string;
  row: string;
}

/** The AntelopeJS DMS modules in display order. Every README holding the markers lists exactly these. */
const DMS_MODULES: readonly DmsModule[] = [
  {
    repo: "dms-builder",
    row: "Edit pages, tables and data sources by clicking, as TypeScript that compiles",
  },
  {
    repo: "dms-ai",
    row: "An assistant chat in the dashboard, on your own Claude Code or Codex",
  },
  {
    repo: "dms-database",
    row: "Schemas, relation diagrams, a data browser and a query console",
  },
  {
    repo: "dms-api",
    row: "API health, request logs, per-route statistics and a request tester",
  },
  {
    repo: "dms-automation",
    row: "Node-graph automations on schedules, webhooks and DMS events, with a trace for every run",
  },
  {
    repo: "dms-mailing",
    row: "E-mail templates in a block editor, versions, a send log and delivery metrics",
  },
  {
    repo: "dms-lang",
    row: "Translation coverage, a translation matrix and a translation queue",
  },
  {
    repo: "dms-media",
    row: "A media library with folders, per-folder permissions, image sizes and light editing",
  },
  {
    repo: "dms-saas",
    row: "Self-service sign-up, plans that gate features, and Stripe billing",
  },
  {
    repo: "dms-marketing",
    row: "Traffic, conversion funnels with A/B splits and click heatmaps, without cookies",
  },
  {
    repo: "dms-frontend",
    row: "The `ajs dms` CLI, the Vue renderer and the SDK every frontend module builds on",
  },
];

/** The generated block, formatted as oxfmt leaves it. */
export function modulesBlock(): string {
  return [
    DMS_MODULES_START,
    "",
    ...tableLines([
      ["Module", "What it adds"],
      ...DMS_MODULES.map(({ repo, row }) => [
        `[\`${repo}\`](${ORGANIZATION}/${repo})`,
        row,
      ]),
    ]),
    "",
    DMS_MODULES_END,
    "",
  ].join("\n");
}

/** The README with the block between its markers rewritten. A README without markers comes back as it is. */
export function placeModulesBlock(current: string): string {
  const start = current.indexOf(DMS_MODULES_START);
  const end = current.indexOf(DMS_MODULES_END);
  if (start === -1 && end === -1) return current;
  if (start === -1 || end < start)
    throw new Error(
      "incomplete antelopejs-dms-modules markers. Repair or delete them, then rerun antelopejs-sync.",
    );
  return `${current.slice(0, start)}${modulesBlock()}${current.slice(end + DMS_MODULES_END.length).replace(/^\r?\n/, "")}`;
}
