import { markers, placeMarkedBlock } from "./marker-block.ts";
import { tableLines } from "./markdown-table.ts";

const FRAMEWORK_MODULES = markers("antelopejs-framework-modules");
export const FRAMEWORK_MODULES_START = FRAMEWORK_MODULES.start;
export const FRAMEWORK_MODULES_END = FRAMEWORK_MODULES.end;

const ORGANIZATION = "https://github.com/AntelopeJS";
const SCOPE = "@antelopejs/";

/** One area of the framework: the interface repositories that define its contracts and the repositories that implement them. */
interface FrameworkArea {
  area: string;
  contracts: readonly string[];
  providers: readonly string[];
}

/** The framework areas in display order. Every README holding the markers lists exactly these. */
const AREAS: readonly FrameworkArea[] = [
  {
    area: "API",
    contracts: ["interface-api", "interface-api-util", "interface-data-api"],
    providers: ["api"],
  },
  { area: "Auth", contracts: ["interface-auth"], providers: ["auth-jwt"] },
  {
    area: "Database",
    contracts: [
      "interface-database",
      "interface-database-decorators",
      "interface-database-catalog",
      "interface-mongodb",
      "interface-rethinkdb",
    ],
    providers: ["postgres", "mongodb", "rethinkdb"],
  },
  {
    area: "Redis",
    contracts: ["interface-redis", "interface-redis-scheduler"],
    providers: ["redis"],
  },
  {
    area: "Email",
    contracts: ["interface-email"],
    providers: ["nodemailer", "brevo"],
  },
  {
    area: "File storage",
    contracts: ["interface-file-storage"],
    providers: ["file-storage-local", "file-storage-s3"],
  },
  {
    area: "Payments",
    contracts: [
      "interface-payment",
      "interface-subscriptions",
      "interface-stripe",
    ],
    providers: ["stripe", "mollie", "checkout-com", "payment-subscriptions"],
  },
];

function cell(repos: readonly string[], current: string | undefined): string {
  return repos
    .map((repo) =>
      repo === current
        ? `**\`${repo}\`**`
        : `[\`${repo}\`](${ORGANIZATION}/${repo})`,
    )
    .join(" · ");
}

/** The generated block, the README's own repository in bold, formatted as oxfmt leaves it. */
export function frameworkModulesBlock(current: string | undefined): string {
  return [
    FRAMEWORK_MODULES_START,
    "",
    ...tableLines([
      ["Area", "Contracts", "Providers"],
      ...AREAS.map(({ area, contracts, providers }) => [
        area,
        cell(contracts, current),
        cell(providers, current),
      ]),
    ]),
    "",
    FRAMEWORK_MODULES_END,
    "",
  ].join("\n");
}

/** The repository a package lives in: its name without the `@antelopejs/` scope, as every framework package is named. */
function frameworkRepo(packageName: string | undefined): string | undefined {
  return packageName?.startsWith(SCOPE)
    ? packageName.slice(SCOPE.length)
    : undefined;
}

/** The README with the block between its markers rewritten for the package named `packageName`. A README without markers comes back as it is. */
export function placeFrameworkModulesBlock(
  current: string,
  packageName: string | undefined,
): string {
  return placeMarkedBlock(
    current,
    FRAMEWORK_MODULES,
    frameworkModulesBlock(frameworkRepo(packageName)),
  );
}
