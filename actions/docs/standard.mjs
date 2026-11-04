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

function proseWithoutCode(doc) {
  let text = doc.text.replace(NODE_BLOCK, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  for (const token of doc.tokens)
    if (token.type === "code")
      text = text.replace(token.raw, token.raw.replace(/[^\n]/g, " "));
  return text.replace(/`[^`\n]*`/g, (code) => " ".repeat(code.length));
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

function checkNodeRanges(doc, name, fail) {
  proseWithoutCode(doc)
    .split("\n")
    .forEach((text, index) => {
      if (NODE_RANGE.test(text))
        fail(
          `${name}:${doc.firstLine + index}: Node version range in prose, state it once in package.json engines`,
        );
    });
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
 * in its frontmatter, no body H1 and at most 3,000 words; every file reads as English, names no Node version in prose,
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
    checkNodeRanges(doc, name, fail);
    checkImages(doc, name, outputs, root, fail);
    for (const { line } of foreignProse(doc.text))
      fail(`${name}:${doc.firstLine + line - 1}: prose is not English`);
  }
  if (valeBin !== false) runVale(valeBin, root, documents, fail);
}
