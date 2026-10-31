#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { decodeHTML } from "entities";
import GithubSlugger from "github-slugger";
import { marked } from "marked";

import { checkStandard, readStandard } from "./standard.mjs";
import { checkTypescript } from "./typescript.mjs";
import { checkVersionClaims, plain, sameRange } from "./versions.mjs";

const markdown = /\.(md|mdc)$/i;
const fields = new Set([
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
]);

/** HTML comments are declarations, never rendered anchors or navigation. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** YAML frontmatter, which is metadata rather than rendered Markdown. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** Fence languages typechecked as TypeScript, and the virtual module extension each one gets. */
const TYPESCRIPT_FENCES = new Map([
  ["ts", "ts"],
  ["typescript", "ts"],
  ["tsx", "tsx"],
  ["mts", "mts"],
  ["cts", "cts"],
]);

/** The info-string word that opts a TypeScript fence out of typechecking. */
const FRAGMENT = "fragment";

/** URLs are never fetched, and `/paths` belong to Nuxt/MDC, not the filesystem. */
const UNCHECKED_LINK = /^(?:[a-z][a-z\d+.-]*:|\/)/i;

function attributes(html, attribute) {
  const pattern = new RegExp(
    `\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "gi",
  );
  return [...html.matchAll(pattern)].map((match) =>
    decodeHTML(match[1] ?? match[2] ?? match[3]),
  );
}

/**
 * Splits a fence info string into its language and flags. MDC filename labels
 * (`ts [src/x.ts]`) and attribute or highlight groups (`ts {1,3}`) are not flags.
 */
function fenceInfo(info) {
  const language = (info.match(/^[^\s[{]*/)?.[0] ?? "").toLowerCase();
  const flags = info
    .slice(language.length)
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return { language, flags };
}

/**
 * Finds the 1-based line of each code block's opening fence, scanning forward so
 * fences quoted inside an outer fence or repeated verbatim stay in order.
 */
function fenceLocator(text, firstLine) {
  const lines = text.split(/\r?\n/);
  const strip = (line) => line.replace(/^[\s>]*/, "");
  let cursor = 0;
  return (token) => {
    const raw = token.raw.replace(/\s+$/, "").split(/\r?\n/);
    for (let index = cursor; index < lines.length; index += 1) {
      if (strip(lines[index]) === strip(raw[0])) {
        cursor = index + raw.length;
        return firstLine + index;
      }
    }
    return firstLine;
  };
}

/** Records a TypeScript fence as an example unless it is marked `fragment`. */
function collectExample(doc, token, fenceLine) {
  const { language, flags } = fenceInfo(token.lang ?? "");
  const extension = TYPESCRIPT_FENCES.get(language);
  if (flags.includes("docs-check") && !extension) {
    throw new Error(`${doc.path}: docs-check requires a TypeScript fence`);
  }
  if (extension && !flags.includes(FRAGMENT)) {
    doc.examples.push({ text: token.text, extension, line: fenceLine + 1 });
  }
}

function document(path) {
  const source = readFileSync(path, "utf8");
  const frontmatter = source.match(FRONTMATTER)?.[0] ?? "";
  const text = source.slice(frontmatter.length);
  const firstLine = frontmatter.split("\n").length;
  const tokens = marked.lexer(text);
  const locate = fenceLocator(text, firstLine);
  const doc = {
    path,
    frontmatter,
    text,
    firstLine,
    tokens,
    links: [],
    anchors: new Set(),
    examples: [],
    code: [],
    api: [],
    exports: new Set(),
    compatibility: [],
  };
  const slugger = new GithubSlugger();
  marked.walkTokens(tokens, (token) => {
    if (token.type === "link" || token.type === "image") {
      doc.links.push(token.href);
    }
    if (token.type === "heading") {
      const title = plain(token.tokens);
      const custom = title.match(/\s*\{#([^}]+)\}$/);
      doc.anchors.add(custom ? custom[1] : slugger.slug(title));
      if (token.tokens.length === 1 && token.tokens[0].type === "codespan") {
        doc.exports.add(token.tokens[0].text);
      }
    }
    if (token.type === "code") {
      const line = locate(token);
      collectExample(doc, token, line);
      doc.code.push([
        line,
        line + token.raw.trimEnd().split(/\r?\n/).length - 1,
      ]);
    }
    if (token.type !== "html") return;
    const html = token.text.replace(HTML_COMMENT, "");
    for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
      for (const id of attributes(tag[0], "id")) doc.anchors.add(id);
      if (/^<a\b/i.test(tag[0])) {
        for (const name of attributes(tag[0], "name")) doc.anchors.add(name);
        doc.links.push(...attributes(tag[0], "href"));
      }
      if (/^<img\b/i.test(tag[0])) {
        doc.links.push(...attributes(tag[0], "src"));
      }
    }
    for (const match of token.text.matchAll(
      /<!--\s*docs-api:\s*(.*?)\s*-->/g,
    )) {
      doc.api.push(match[1]);
    }
    for (const match of token.text.matchAll(
      /<!--\s*docs-compat:\s*(.*?)\s*-->/g,
    )) {
      const index = tokens.indexOf(token);
      doc.compatibility.push({
        declaration: match[1],
        table: tokens.slice(index + 1).find((next) => next.type !== "space"),
      });
    }
  });
  if (doc.api.length > 1) {
    throw new Error(`${path}: use one docs-api entry per reference page`);
  }
  return doc;
}

function checkCompatibility(doc, localPath, fail) {
  for (const { declaration, table } of doc.compatibility) {
    const [file, field, extra] = declaration.split("#");
    if (!file || !fields.has(field) || extra || table?.type !== "table") {
      fail(
        `${doc.path}: docs-compat needs manifest#dependencyField and a table`,
      );
      continue;
    }
    const manifest = JSON.parse(
      readFileSync(localPath(resolve(dirname(doc.path), file)), "utf8"),
    );
    const headings = table.header.map((cell) =>
      plain(cell.tokens).toLowerCase(),
    );
    const packageColumn = headings.indexOf("package");
    const rangeColumn = headings.indexOf("range");
    if (packageColumn < 0 || rangeColumn < 0 || table.rows.length === 0) {
      fail(
        `${doc.path}: docs-compat table needs Package and Range columns and rows`,
      );
      continue;
    }
    for (const row of table.rows) {
      const name = plain(row[packageColumn].tokens).trim();
      const documented = plain(row[rangeColumn].tokens).trim();
      if (!sameRange(documented, manifest[field]?.[name])) {
        fail(
          `${doc.path}: compatibility drift for ${name} in ${file}#${field}`,
        );
      }
    }
  }
}

function checkLinks(doc, { load, localPath, fail }) {
  let links = 0;
  for (const href of doc.links) {
    if (!href || UNCHECKED_LINK.test(href)) continue;
    links += 1;
    try {
      const hash = href.indexOf("#");
      const urlPath = (hash < 0 ? href : href.slice(0, hash)).split("?")[0];
      const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
      const target = urlPath
        ? resolve(dirname(doc.path), decodeURIComponent(urlPath))
        : doc.path;
      localPath(target);
      if (
        fragment &&
        markdown.test(target) &&
        !load(target).anchors.has(fragment)
      ) {
        fail(`${doc.path}: missing anchor #${fragment} in ${target}`);
      }
    } catch (error) {
      fail(`${doc.path}: broken local link ${href}: ${error.message}`);
    }
  }
  return links;
}

/**
 * The tsconfig for TypeScript fences and docs-api pages: the input when set,
 * else the checkout's root tsconfig.json. Undefined when neither exists.
 */
function typescriptProject(root, project, localPath) {
  if (project) return localPath(resolve(root, project));
  const fallback = resolve(root, "tsconfig.json");
  return existsSync(fallback) ? localPath(fallback) : undefined;
}

export function checkDocs({
  root = process.cwd(),
  files,
  project = "",
  standard,
  valeBin,
}) {
  root = realpathSync(root);
  const failures = [];
  const fail = (message) => failures.push(message);
  const localPath = (path) => {
    const real = realpathSync(path);
    const fromRoot = relative(root, real);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(`path escapes consumer checkout: ${path}`);
    }
    return path;
  };
  const selected = new Set();
  const collect = (path) => {
    localPath(path);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() || markdown.test(entry.name)) {
          collect(resolve(path, entry.name));
        }
      }
    } else if (markdown.test(path)) {
      selected.add(path);
    } else {
      throw new Error(`expected a Markdown file or directory: ${path}`);
    }
  };
  for (const file of files) collect(resolve(root, file));
  if (selected.size === 0) throw new Error("no Markdown files selected");
  const cache = new Map();
  const load = (path) => {
    if (!cache.has(path)) cache.set(path, document(localPath(path)));
    return cache.get(path);
  };
  const documents = [...selected].map(load);
  const context = { root, load, localPath, fail };
  let links = 0;
  let blocks = 0;
  for (const doc of documents) {
    links += checkLinks(doc, context);
    checkCompatibility(doc, localPath, fail);
    blocks += checkVersionClaims(doc, context);
    for (const entry of doc.api) localPath(resolve(dirname(doc.path), entry));
  }
  if (standard ?? readStandard(root)) {
    checkStandard({
      root,
      documents,
      fail,
      valeBin: valeBin ?? process.env.VALE_BIN ?? "vale",
    });
  }
  const typed = documents.some((doc) => doc.api.length || doc.examples.length);
  const tsconfig = typescriptProject(root, project, localPath);
  let examples = 0;
  if (typed && !tsconfig) {
    fail(
      "TypeScript fences and docs-api pages need a tsconfig: set the typescript-project input (docs-typescript-project in ci-node.yml), add a root tsconfig.json, or mark illustrative fences `fragment`",
    );
  } else if (typed || project) {
    examples = checkTypescript({ root, project: tsconfig, documents, fail });
  }
  return {
    failures,
    files: documents.length,
    links,
    examples,
    apis: documents.filter((doc) => doc.api.length).length,
    compatibility: documents.reduce(
      (total, doc) => total + doc.compatibility.length,
      blocks,
    ),
  };
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      files: { type: "string" },
      "typescript-project": { type: "string", default: "" },
      "print-standard": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values["print-standard"]) {
    console.log(readStandard(process.cwd()));
    return 0;
  }
  const files = [
    ...positionals,
    ...(values.files ?? "")
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean),
  ];
  if (!files.length)
    throw new Error("pass Markdown files or directories to check");
  const result = checkDocs({ files, project: values["typescript-project"] });
  for (const failure of result.failures) console.error(failure);
  console.log(
    `Docs: ${result.files} files, ${result.links} local links, ${result.compatibility} compatibility tables, ${result.examples} checked examples, ${result.apis} API pages; ${result.failures.length} failures.`,
  );
  return result.failures.length ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Docs: ${error.message}`);
    process.exitCode = 1;
  }
}
