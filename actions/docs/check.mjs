#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { decodeHTML } from "entities";
import GithubSlugger from "github-slugger";
import { marked } from "marked";
import semver from "semver";

import { checkTypescript } from "./typescript.mjs";

const markdown = /\.(md|mdc)$/i;
const fields = new Set([
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
]);

function plain(tokens) {
  return tokens
    .map((token) => {
      if (token.type === "html") return "";
      return token.tokens ? plain(token.tokens) : decodeHTML(token.text ?? "");
    })
    .join("");
}

function attributes(html, attribute) {
  const pattern = new RegExp(
    `\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "gi",
  );
  return [...html.matchAll(pattern)].map((match) =>
    decodeHTML(match[1] ?? match[2] ?? match[3]),
  );
}

function document(path) {
  const text = readFileSync(path, "utf8").replace(
    /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    "",
  );
  const tokens = marked.lexer(text);
  const doc = {
    path,
    tokens,
    links: [],
    anchors: new Set(),
    examples: [],
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
      const [language, ...flags] = (token.lang ?? "").split(/\s+/);
      if (flags.includes("docs-check")) {
        if (!["ts", "typescript", "tsx"].includes(language)) {
          throw new Error(`${path}: docs-check requires a ts or tsx fence`);
        }
        doc.examples.push({
          text: token.text,
          extension: language === "tsx" ? "tsx" : "ts",
        });
      }
    }
    if (token.type !== "html") return;
    // Comments are declarations, never rendered anchors or HTML navigation.
    const html = token.text.replace(/<!--[\s\S]*?-->/g, "");
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

function comparableRange(spec) {
  if (!semver.validRange(spec)) return null;
  // npm excludes prereleases unless a comparator explicitly admits that tuple.
  // subset() otherwise treats <2.0.0 as wider than the caret bound <2.0.0-0.
  return new semver.Range(spec).set
    .map((comparators) =>
      comparators
        .map((comparator) => {
          const version = comparator.semver;
          const admitsPrerelease = comparators.some(
            (other) =>
              other.semver.prerelease?.length &&
              other.semver.major === version.major &&
              other.semver.minor === version.minor &&
              other.semver.patch === version.patch,
          );
          return comparator.operator === "<" &&
            !version.prerelease.length &&
            !admitsPrerelease
            ? `<${version.version}-0`
            : comparator.value;
        })
        .join(" "),
    )
    .join(" || ");
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
      const declared = manifest[field]?.[name];
      const documentedRange = comparableRange(documented);
      const declaredRange = comparableRange(declared);
      const equivalent =
        typeof declared === "string" &&
        (documented === declared ||
          (documentedRange !== null &&
            declaredRange !== null &&
            semver.subset(documentedRange, declaredRange) &&
            semver.subset(declaredRange, documentedRange)));
      if (!documented || !equivalent) {
        fail(
          `${doc.path}: compatibility drift for ${name} in ${file}#${field}`,
        );
      }
    }
  }
}

export function checkDocs({ root = process.cwd(), files, project = "" }) {
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
  let links = 0;
  for (const doc of documents) {
    for (const href of doc.links) {
      // /paths belong to Nuxt/MDC, not the filesystem. Never fetch URLs.
      if (!href || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(href)) continue;
      links += 1;
      try {
        const hash = href.indexOf("#");
        const urlPath = (hash < 0 ? href : href.slice(0, hash)).split("?")[0];
        const fragment =
          hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
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
    checkCompatibility(doc, localPath, fail);
    for (const entry of doc.api) localPath(resolve(dirname(doc.path), entry));
  }
  const annotated = documents.some(
    (doc) => doc.api.length || doc.examples.length,
  );
  let examples = 0;
  if (annotated && !project) {
    fail("docs-check/docs-api declarations require --typescript-project");
  } else if (project) {
    examples = checkTypescript(
      localPath(resolve(root, project)),
      documents,
      fail,
    );
  }
  return {
    failures,
    files: documents.length,
    links,
    examples,
    apis: documents.filter((doc) => doc.api.length).length,
    compatibility: documents.reduce(
      (total, doc) => total + doc.compatibility.length,
      0,
    ),
  };
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      files: { type: "string" },
      "typescript-project": { type: "string", default: "" },
    },
    allowPositionals: true,
  });
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
