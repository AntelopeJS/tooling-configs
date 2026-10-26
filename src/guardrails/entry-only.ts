import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function matcher(value: string | string[]): RegExp[] {
  const patterns = Array.isArray(value) ? value : [value];
  return patterns.map((pattern) => new RegExp(pattern));
}

interface EntryRule {
  name: string;
  from: { pathNot: string | string[] };
  to: { path: string | string[]; pathNot: string | string[] };
}

const LOAD_RULES = `
const rules = require(process.cwd()+"/.dependency-cruiser.cjs").forbidden;
if (!Array.isArray(rules)) throw Error("Expected forbidden rules");
const selected = rules.filter(rule => typeof rule.name === "string" && rule.name.endsWith("-entry-only"));
for (const rule of selected) {
  if (rule.severity !== "error" || !rule.from || !rule.to ||
    Object.keys(rule.from).some(key => key !== "pathNot") ||
    Object.keys(rule.to).some(key => !["path", "pathNot"].includes(key)))
    throw Error(rule.name+": unsupported entry-only selectors");
  for (const value of [rule.from.pathNot, rule.to.path, rule.to.pathNot]) {
    const patterns = Array.isArray(value) ? value : [value];
    if (!patterns.length || patterns.some(pattern => typeof pattern !== "string"))
      throw Error(rule.name+": expected string or string-array selector");
  }
}
process.stdout.write(JSON.stringify(selected));
`;

/** Rejects tracked importers exempted from another module's entry-only boundary. */
export function checkEntryOnlyConfiguration(root: string): string[] {
  if (!existsSync(join(root, ".dependency-cruiser.cjs"))) return [];
  const rules: EntryRule[] = JSON.parse(
    execFileSync(process.execPath, ["-e", LOAD_RULES], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    }),
  );
  const paths = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  return rules.flatMap((rule) => {
    const domain = matcher(rule.to.path);
    const exemption = matcher(rule.from.pathNot);
    return paths
      .filter(
        (path) =>
          exemption.some((pattern) => pattern.test(path)) &&
          !domain.some((pattern) => pattern.test(path)),
      )
      .map(
        (path) =>
          `${rule.name} exempts ${path} outside its module; give the module a second entry instead`,
      );
  });
}
