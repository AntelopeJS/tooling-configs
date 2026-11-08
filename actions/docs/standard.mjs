import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { marked } from "marked";

import { foreignProse } from "./language.mjs";

const MODES = ["tutorial", "how-to", "reference", "explanation"];
const REQUIRED = ["title", "description", "mode"];
const WORD_LIMIT = 3000;
const ILLUSTRATION = "illustration";
const CAPTURES = "docs/captures.ts";
const VALE_CONFIG = fileURLToPath(new URL("vale/vale.ini", import.meta.url));

/** The generated Node prerequisite block, which is where a Node version may appear in prose. */
const NODE_BLOCK =
  /<!--\s*antelopejs-docs-node:start\s*-->[\s\S]*?<!--\s*antelopejs-docs-node:end\s*-->/g;

/** `Node 20`, `Node.js >= 22`, `node 22.18+`: the runtime named with a version number after it. */
const NODE_RANGE =
  /\bnode(?:\.js)?\s*(?:(?:v|>=?|<=?|~|\^|≥|≤)\s*\d|\d{2}|\d+\.\d)/i;

/** Frameworks, runtimes and tools whose version a page pins in package.json or .nvmrc, spelled as prose writes them. Node has its own rule. */
const DEPENDENCIES = [
  "AdonisJS",
  "Angular",
  "Bun",
  "Deno",
  "Express",
  "Fastify",
  "MongoDB",
  "MySQL",
  "NestJS",
  "Next\\.js",
  "npm",
  "Nuxt",
  "pnpm",
  "PostgreSQL",
  "Postgres",
  "React",
  "Redis",
  "Svelte",
  "Tailwind(?: ?CSS)?",
  "TypeScript",
  "Vite",
  "Vitest",
  "Vue",
  "Yarn",
  "yarn",
];

/** A number followed by one of these is a measure, not a version. */
const UNIT =
  "[ \\t]*(?:%|:\\d|(?:[kmgt]i?b|bytes?|m?s|secs?|seconds?|min|minutes?|times)(?![a-z]))";

/**
 * `AdonisJS 6`, `**Vue** 3.5`, `Express.js 5`, `pnpm v10`, `TypeScript version 5.6`, `Vue 3.5.0-beta.1`: a listed
 * dependency with a version after it, on the same line or the next. The next line does not count when it starts a list
 * item: a `1.` marker, or any number when the name's own line is a numbered item. No listed dependency has reached major 100, so a
 * year, an HTTP status, a ratio, a decimal comma or a measure such as `99.9%` is not a version.
 */
const DEPENDENCY_VERSION = new RegExp(
  `(?<![\\w.@/-])(?:${DEPENDENCIES.join("|")})(?:\\.js)?[*_]*[ \\t\\u00a0]*(?:\\r?\\n(?:[ \\t]*>)*[ \\t]*(?!>|(?:1|(?<=^[ \\t>]*\\d+[.)][ \\t][^\\n]*\\n[ \\t>]*)\\d+)[.)][ \\t]))?(?:version[ \\t]+)?(?:(?:v|[<>]=?|[~^≥≤])[ \\t]*)?\\d{1,2}(?:\\.(?:\\d+|x))*(?:-[\\da-z]+(?:\\.[\\da-z]+)*)?(?![\\w/-]|[.,]\\d|${UNIT})`,
  "gm",
);

const isReadme = (path) => /^readme(?:\.[a-z]+)?\.md$/i.test(basename(path));

/** Whether the consumer's package.json opts in: `antelopeJs.docs.standard` is true. */
export function readStandard(root) {
  const manifest = resolve(root, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    return (
      JSON.parse(readFileSync(manifest, "utf8"))?.antelopeJs?.docs?.standard ===
      true
    );
  } catch {
    return false;
  }
}

/** The top-level `key: value` pairs of a YAML frontmatter block; a block scalar counts as present. */
function frontmatterFields(frontmatter) {
  const fields = new Map();
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    fields.set(match[1], /^[>|][+-]?$/.test(value) ? "(block)" : value);
  }
  return fields;
}

/** The 1-based line where each top-level token starts. */
function tokenLines(doc) {
  const lines = new Map();
  let offset = 0;
  for (const token of doc.tokens) {
    lines.set(
      token,
      doc.firstLine + (doc.text.slice(0, offset).match(/\n/g)?.length ?? 0),
    );
    offset += token.raw.length;
  }
  return lines;
}

/** Replaces a span with spaces, keeping newlines so lines stay put. */
const blank = (span) => span.replace(/[^\n]/g, " ");

/** HTML `<pre>` blocks, comments and tags, link destinations, URLs and inline code spans: none of them is prose. */
const NOT_PROSE =
  /<pre\b[\s\S]*?<\/pre>|<!--[\s\S]*?-->|<\/?[a-z][^>]*>|\]\([^)\n]*\)|\bhttps?:\/\/\S+|(`+)[^\n]*?\1/gi;

/** The page text with every code block, at any depth, and every non-prose span blanked. */
function proseWithoutCode(doc) {
  const lines = doc.text.split("\n");
  for (const [from, to] of doc.code)
    for (let line = from; line <= to; line += 1)
      lines[line - doc.firstLine] = blank(lines[line - doc.firstLine] ?? "");
  return lines.join("\n").replace(NODE_BLOCK, blank).replace(NOT_PROSE, blank);
}

function checkFrontmatter(doc, name, fail) {
  const fields = frontmatterFields(doc.frontmatter);
  for (const key of REQUIRED)
    if (!fields.get(key)) fail(`${name}: frontmatter needs ${key}`);
  const mode = fields.get("mode");
  if (mode && !MODES.includes(mode))
    fail(
      `${name}: frontmatter mode must be tutorial, how-to, reference or explanation, not ${mode}`,
    );
}

function checkHeading(doc, name, lines, fail) {
  for (const token of doc.tokens)
    if (token.type === "heading" && token.depth === 1)
      fail(
        `${name}:${lines.get(token)}: the title comes from frontmatter, remove the body H1`,
      );
}

function checkWords(doc, name, fail) {
  const body = doc.tokens
    .filter((token) => token.type !== "code")
    .map((token) => token.raw)
    .join("");
  const count = body
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (count > WORD_LIMIT)
    fail(`${name}: ${count} words, split the page at ${WORD_LIMIT}`);
}

function checkVersionProse(doc, name, fail) {
  const prose = proseWithoutCode(doc);
  prose.split("\n").forEach((text, index) => {
    if (NODE_RANGE.test(text))
      fail(
        `${name}:${doc.firstLine + index}: Node version range in prose, state it once in package.json engines`,
      );
  });
  const frontmatter = doc.frontmatter
    .split("\n")
    .map((line) => line.replace(NOT_PROSE, blank))
    .join("\n");
  const rendered = `${frontmatter}${prose}`;
  for (const { 0: version, index } of rendered.matchAll(DEPENDENCY_VERSION))
    fail(
      `${name}:${1 + (rendered.slice(0, index).match(/\n/g)?.length ?? 0)}: "${version.replace(/[*_]|\r?\n[\s>]*/g, " ").replace(/\s+/g, " ")}" states a version in prose, point at the pin in package.json or .nvmrc`,
    );
}

/** The `output` of every scene in docs/captures.ts. Each must be a string literal, because the check reads the file and does not run it. */
function captureOutputs(root) {
  const path = resolve(root, CAPTURES);
  if (!existsSync(path)) return new Set();
  const source = readFileSync(path, "utf8");
  return new Set(
    [...source.matchAll(/\boutput\s*:\s*(["'`])([^"'`\n]+)\1/g)].map((match) =>
      resolve(root, match[2]),
    ),
  );
}

function images(doc) {
  const found = [];
  marked.walkTokens(doc.tokens, (token) => {
    if (token.type === "image")
      found.push({ href: token.href, marked: token.title === ILLUSTRATION });
    if (token.type !== "html") return;
    for (const tag of token.text.matchAll(/<img\b[^>]*>/gi)) {
      const src = tag[0].match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (src)
        found.push({
          href: src[1] ?? src[2],
          marked: /\sdata-illustration\b/i.test(tag[0]),
        });
    }
  });
  return found;
}

function checkImages(doc, name, outputs, root, fail) {
  for (const image of images(doc)) {
    if (image.marked) continue;
    const local = !/^[a-z][a-z\d+.-]*:|^\/\//i.test(image.href);
    const target = local
      ? resolve(
          dirname(doc.path),
          decodeURIComponent(image.href.split(/[?#]/)[0]),
        )
      : undefined;
    if (target && outputs.has(target)) continue;
    fail(
      `${name}: image ${image.href} is neither a ${CAPTURES} output nor marked ${ILLUSTRATION}`,
    );
  }
}

function runVale(valeBin, root, documents, fail) {
  const files = documents
    .filter((doc) => /\.md$/i.test(doc.path))
    .map((doc) => doc.path);
  const run = spawnSync(
    valeBin,
    ["--config", VALE_CONFIG, "--output=JSON", ...files],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (run.error) {
    fail("standard mode needs Vale: run install-vale.sh and set VALE_BIN");
    return;
  }
  let report;
  try {
    report = JSON.parse(run.stdout || "{}");
  } catch {
    fail(`Vale failed: ${run.stderr.trim() || run.stdout.trim()}`);
    return;
  }
  for (const [file, alerts] of Object.entries(report))
    for (const { Line, Check, Message } of alerts)
      fail(
        `${relative(root, resolve(root, file))}:${Line}: ${Check} ${Message}`,
      );
}

/**
 * The Docs standard, run only when the repository opts in. Each page needs `title`, `description` and a `mode`
 * in its frontmatter, no body H1 and at most 3,000 words; every file reads as English, names no Node, framework or tool version in prose,
 * references only images that a `docs/captures.ts` scene writes or that are marked `illustration`, and has no Vale warning.
 * A README keeps its H1 and needs no frontmatter.
 */
export function checkStandard({ root, documents, fail, valeBin }) {
  const outputs = captureOutputs(root);
  for (const doc of documents) {
    const name = relative(root, doc.path);
    const lines = tokenLines(doc);
    if (!isReadme(doc.path)) {
      checkFrontmatter(doc, name, fail);
      checkHeading(doc, name, lines, fail);
    }
    checkWords(doc, name, fail);
    checkVersionProse(doc, name, fail);
    checkImages(doc, name, outputs, root, fail);
    for (const { line } of foreignProse(doc.text))
      fail(`${name}:${doc.firstLine + line - 1}: prose is not English`);
  }
  if (valeBin !== false) runVale(valeBin, root, documents, fail);
}
