import { markers, placeMarkedBlock } from "./marker-block.ts";
import { tableLines } from "./markdown-table.ts";

const DMS_MODULES = markers("antelopejs-dms-modules");
export const DMS_MODULES_START = DMS_MODULES.start;
export const DMS_MODULES_END = DMS_MODULES.end;

const ORGANIZATION = "https://github.com/AntelopeJS";

/** One AntelopeJS DMS module: its repository name and what it adds to a DMS. */
interface DmsModule {
  repo: string;
  row: string;
}

/** The AntelopeJS DMS modules in display order. Every README holding the markers lists exactly these. */
const MODULES: readonly DmsModule[] = [
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
      ...MODULES.map(({ repo, row }) => [
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
  return placeMarkedBlock(current, DMS_MODULES, modulesBlock());
}
