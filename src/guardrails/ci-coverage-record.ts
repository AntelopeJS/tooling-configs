/** The folder the agent skills live in; a file under it always triggers the formal check of its own skill. */
export const SKILLS_DIRECTORY = ".agents/skills";

const SECTION_HEADINGS = [
  /^(#{2,3}) Coverage record\b/i,
  /^(#{2,3}) Scope and assumptions\b/i,
] as const;

const FILE_TOKEN =
  /(?<![\w./-])([\w./-]+\.(?:tsx|ts|mts|cts|js|mjs|cjs|vue))(?![\w-])(?::\d+(?:-\d+)?)?/g;

const OTHER_PATH =
  /`([^`\s]*(?:\/|\*)[^`\s]*|[^`\s]+\.(?:sql|json|jsonc|ya?ml|toml|graphql|prisma|css|scss|html|md|sh|py|go|rs))`/g;

/** What a coverage record says of the files a formal check models. */
export type CoveragePaths =
  | { kind: "paths"; paths: string[] }
  | { kind: "unresolved" }
  | { kind: "none" };

const FILE_ONLY =
  /^[\w./-]+\.(?:tsx|ts|mts|cts|js|mjs|cjs|vue)(?::\d+(?:-\d+)?)?$/;

const SEPARATOR_ROW = /^\|[\s:|-]*-[\s:|-]*$/;

function levelOf(line: string): number {
  return /^(#{1,6}) /.exec(line)?.[1].length ?? 0;
}

function sectionOf(lines: readonly string[]): string[] | undefined {
  for (const heading of SECTION_HEADINGS) {
    const start = lines.findIndex((line) => heading.test(line));
    if (start === -1) continue;
    const level = heading.exec(lines[start])?.[1].length ?? 0;
    const section: string[] = [];
    let fenced = false;
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith("```")) fenced = !fenced;
      if (!fenced && levelOf(line) > 0 && levelOf(line) <= level) break;
      section.push(line);
    }
    return section;
  }
  return undefined;
}

function tableRows(section: readonly string[]): string[] {
  const rows: string[] = [];
  let header = true;
  for (const line of section) {
    if (!line.startsWith("|")) header = true;
    else if (header) header = false;
    else if (!SEPARATOR_ROW.test(line)) rows.push(line);
  }
  return rows;
}

function resolveToken(
  token: string,
  files: readonly string[],
  skill: string,
): string | undefined {
  if (files.includes(token)) return token;
  const own = `${SKILLS_DIRECTORY}/${skill}/${token}`;
  if (files.includes(own)) return own;
  const matches = files.filter((file) => file.endsWith(`/${token}`));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The repository files the SKILL.md `markdown` of the formal check `skill` says it models, as git pathspecs, sorted.
 * They come from the table rows (header and separator rows apart) under the heading `Coverage record`, else under
 * `Scope and assumptions`, each at level 2 or 3: every token that looks like a source file (`.ts`, `.tsx`, `.mts`, `.cts`,
 * `.js`, `.mjs`, `.cjs` or `.vue`, a `:NN` or `:NN-MM` line suffix dropped) names a file of `files`. A token resolves to
 * that file when it is one; else to the file of the skill's own folder it names; else to the one file whose path ends
 * in `/<token>`. A token that resolves to no file or to several leaves no paths at all, since a check that runs on every
 * pull request is safer than one narrowed wrongly. Files under `.agents/skills/` are left out, because a change to the
 * skill folder always runs its check. A backticked path the extractor does not read as a source file, such as a glob, a
 * folder or a `.sql` file, leaves no paths too. `unresolved` when a token leaves no paths, `none` when there is no
 * record or it names no file outside the skill folder.
 */
export function coveragePaths(
  markdown: string,
  files: readonly string[],
  skill: string,
): CoveragePaths {
  const section = sectionOf(markdown.split(/\r?\n/));
  if (section === undefined) return { kind: "none" };
  const rows = tableRows(section);
  const other = rows.some((row) =>
    [...row.matchAll(OTHER_PATH)].some(([, token]) => !FILE_ONLY.test(token)),
  );
  if (other) return { kind: "unresolved" };
  const tokens = new Set(
    rows.flatMap((row) =>
      [...row.matchAll(FILE_TOKEN)].map(([, token]) =>
        token.replace(/^\.\//, ""),
      ),
    ),
  );
  const paths = new Set<string>();
  for (const token of tokens) {
    const path = resolveToken(token, files, skill);
    if (path === undefined) return { kind: "unresolved" };
    if (!path.startsWith(`${SKILLS_DIRECTORY}/`)) paths.add(path);
  }
  return paths.size
    ? { kind: "paths", paths: [...paths].sort() }
    : { kind: "none" };
}
