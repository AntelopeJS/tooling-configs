import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";

import { CI_PATH } from "./ci-workflow.ts";

const MARKDOWN = /\.(?:md|mdc)$/i;
const UNPUBLISHED_FOLDER = "design";
const UNPUBLISHED_FILE = /grill.*\.md$/;
const FENCE = /^[\s>]*(`{3,}|~{3,})\s*([^\s[{`]*)(.*)$/;
const TYPESCRIPT_LANGUAGES = new Set(["ts", "typescript", "tsx", "mts", "cts"]);
const FRAGMENT = "fragment";
const DOCS_API = /<!--\s*docs-api:/;

/** Whether one fence opener is a TypeScript fence the docs check typechecks: a TypeScript language not flagged `fragment`. */
function checkedFence(language: string, info: string): boolean {
  if (!TYPESCRIPT_LANGUAGES.has(language.toLowerCase())) return false;
  return !info
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
    .split(/\s+/)
    .includes(FRAGMENT);
}

/** Whether a Markdown file needs a tsconfig in the docs check: it holds a checked TypeScript fence or a `docs-api` page. */
function typed(text: string): boolean {
  if (DOCS_API.test(text)) return true;
  let open: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const fence = FENCE.exec(line);
    if (!fence) continue;
    const [, marker, language, info] = fence;
    if (open === undefined) {
      open = marker;
      if (checkedFence(language, info)) return true;
    } else if (marker.startsWith(open) && language === "" && info.trim() === "")
      open = undefined;
  }
  return false;
}

/** The Markdown files a `docs-files` entry selects, as the docs check walks it. */
function markdownFiles(root: string, path: string, base = path): string[] {
  const absolute = join(root, path);
  const stat = statSync(absolute, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory()) return MARKDOWN.test(path) ? [path] : [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory())
      return child === `${base}/${UNPUBLISHED_FOLDER}`
        ? []
        : markdownFiles(root, child, base);
    return MARKDOWN.test(entry.name) && !UNPUBLISHED_FILE.test(entry.name)
      ? [child]
      : [];
  });
}

/**
 * The docs files, relative to `root`, that hold TypeScript fences or `docs-api`
 * pages the docs check typechecks, under a CI caller job that lists them in
 * `docs-files` but sets no `docs-typescript-project`.
 */
export function untypedDocsFiles(root: string): string[] {
  const path = join(root, CI_PATH);
  if (!existsSync(path)) return [];
  const jobs = parseDocument(readFileSync(path, "utf8")).get("jobs", true);
  if (!isMap(jobs)) return [];
  const found = new Set<string>();
  for (const { value: job } of jobs.items) {
    const inputs = isMap(job) ? job.get("with", true) : undefined;
    if (!isMap(inputs)) continue;
    const project = inputs.get("docs-typescript-project", true);
    const files = inputs.get("docs-files", true);
    if ((isScalar(project) && String(project.value).trim()) || !isScalar(files))
      continue;
    for (const entry of String(files.value).split("\n")) {
      const trimmed = entry.trim().replace(/\/+$/, "");
      if (!trimmed) continue;
      for (const file of markdownFiles(root, trimmed))
        if (typed(readFileSync(join(root, file), "utf8"))) found.add(file);
    }
  }
  return [...found];
}
