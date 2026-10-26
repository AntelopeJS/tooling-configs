import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface EntryRule {
  name: string;
  exempt: string[];
  domain: string[];
}

interface EntryOnlyReport {
  errors: string[];
  advisories: string[];
}

interface LoadedRules {
  rules: EntryRule[];
  advisories: string[];
}

const LOAD_RULES = `
const advisories = [];
const rules = [];
const SUPPORTED = { from: ["pathNot"], to: ["path", "pathNot"] };
function patterns(value) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.some(pattern => typeof pattern !== "string")) return null;
  try { list.forEach(pattern => new RegExp(pattern)); } catch { return null; }
  return list;
}
function problem(rule) {
  if (!rule.from || typeof rule.from !== "object" || !rule.to || typeof rule.to !== "object")
    return "Warning: entry-only rule " + rule.name + " has no from and to selectors, so its exemptions cannot be checked.";
  const unsupported = [
    ...(rule.severity === "error" ? [] : ["severity " + String(rule.severity)]),
    ...Object.keys(rule.from).filter(key => !SUPPORTED.from.includes(key)).map(key => "from." + key),
    ...Object.keys(rule.to).filter(key => !SUPPORTED.to.includes(key)).map(key => "to." + key),
  ];
  if (unsupported.length)
    return "Note: entry-only rule " + rule.name + " skipped, because its selectors are not supported (" + unsupported.join(", ") + "); only error rules built from from.pathNot and to.path or to.pathNot patterns are checked.";
  if (rule.to.path === undefined)
    return "Warning: entry-only rule " + rule.name + " has no to.path, so there is no module to exempt against.";
  if (patterns(rule.from.pathNot) === null || !patterns(rule.to.path)?.length || patterns(rule.to.pathNot) === null)
    return "Warning: entry-only rule " + rule.name + " has selectors that are not valid regular expression strings, so its exemptions cannot be checked.";
  return undefined;
}
try {
  const forbidden = require(process.cwd()+"/.dependency-cruiser.cjs").forbidden;
  if (!Array.isArray(forbidden)) advisories.push("Warning: .dependency-cruiser.cjs has no forbidden rule array, so entry-only exemptions are not checked.");
  else for (const rule of forbidden) {
    if (!rule || typeof rule.name !== "string" || !rule.name.endsWith("-entry-only")) continue;
    const advisory = problem(rule);
    if (advisory === undefined) rules.push({ name: rule.name, exempt: patterns(rule.from.pathNot), domain: patterns(rule.to.path) });
    else advisories.push(advisory);
  }
} catch (error) {
  advisories.push("Warning: .dependency-cruiser.cjs could not be loaded, so entry-only exemptions are not checked (" + String(error && error.message) + ").");
}
process.stdout.write(JSON.stringify({ rules, advisories }));
`;

function matcher(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern));
}

/** Rejects tracked importers exempted from another module's entry-only boundary. A rule it cannot interpret yields a printed note or warning in `advisories` and never a failure. */
export function checkEntryOnlyConfiguration(root: string): EntryOnlyReport {
  if (!existsSync(join(root, ".dependency-cruiser.cjs")))
    return { errors: [], advisories: [] };
  const { rules, advisories }: LoadedRules = JSON.parse(
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
  const errors = rules.flatMap((rule) => {
    const domain = matcher(rule.domain);
    const exemption = matcher(rule.exempt);
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
  return { errors, advisories };
}
