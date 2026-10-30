import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { decodeHTML } from "entities";
import { marked } from "marked";
import semver from "semver";

const SCOPE = "@antelopejs/";
const START = "<!-- antelopejs-docs-compat:start -->";
const END = "<!-- antelopejs-docs-compat:end -->";
const SYNC = "run antelopejs-sync";
const FIX = `${SYNC} and delete the prose`;

/** Dependency fields that feed the Supported column, lowest precedence first: peer wins over runtime. */
const SUPPORTED_FIELDS = [
  "optionalDependencies",
  "dependencies",
  "peerDependencies",
];

/** Files whose version history is their purpose, not a compatibility claim. */
const CHANGELOG = /^changelog\.mdc?$/i;

const NAME =
  "(?<![\\w@/.-])@antelopejs/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*";
const PART = "(?:\\d+|[x*])";
const VERSION = `(?:(?:[\\^~]|[<>]=?|=)\\s*v?\\d+(?:\\.${PART})*|v?\\d+(?:\\.${PART}){1,2}|v\\d+(?!\\w|\\.\\d))(?:-[0-9a-z.-]*[0-9a-z])?`;
const COMPARATORS = `(?:[ \\t]+(?:\\|\\|[ \\t]+)?(?:[<>]=?|[\\^~])[ \\t]*v?\\d+(?:\\.${PART})*)*`;
const RANGE = `${VERSION}${COMPARATORS}`;

/**
 * An `@antelopejs/*` name followed by a version or range, across codespans,
 * emphasis, parentheses, quotes, dashes, and a connector word. Sizes, durations,
 * multipliers, and IP addresses are not versions.
 */
const PACKAGE_VERSION = new RegExp(
  `(${NAME})(?:@(?=[\\^~<>=v\\d])|[\\s\`*_:("'—–]+(?:(?:version|as|to|from|at)[\\s\`*_("']+)?)((?:${VERSION}|(?<=@)\\d+)${COMPARATORS})(?!\\.\\d|[ \\t]*(?:[kmgt]i?b|bytes?|%|m?s|secs?|seconds?|min|minutes?|x|times)(?![a-z]))`,
  "gi",
);

/**
 * "requires/needs AntelopeJS <word>" followed by any version or range, or
 * "requires/needs <phrase> >= x" / "<phrase> x.y or later" where the phrase
 * (group 1) must name AntelopeJS.
 */
const REQUIRES = new RegExp(
  `\\b(?:requires?|needs?)\\s+(?:at\\s+least\\s+)?(?:(?:the\\s+)?AntelopeJS(?:\\s+[\\w-]+)?[\\s\`*_("']*,?[\\s\`*_("']*(?:${RANGE})(?:[\`*_)]*\\s+or\\s+(?:later|newer|higher|above))?|([^\\n.,;:!?()]{1,60}?)[\\s\`*_("']*,?[\\s\`*_("']*(?:(?:version|at)\\s+)?(?:>=\\s*v?\\d+(?:\\.\\d+)*|v?\\d+(?:\\.\\d+)*[\`*_)]*\\s+or\\s+(?:later|newer|higher|above)))`,
  "gi",
);

/** A phrase naming AntelopeJS last, not joined to another requirement with "and", "or", "with", "plus" or "on". */
const REQUIRED_ANTELOPEJS = /antelopejs(?!.*\b(?:and|or|with|plus|on)\b)/i;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const LEGACY_TABLE =
  /<!--\s*docs-compat:[^>]*?-->[ \t]*\r?\n(?:[ \t]*\r?\n)*(?:[ \t]*\|.*(?:\r?\n|$))+/g;

/** Rendered text of inline tokens, without markup. */
export function plain(tokens) {
  return tokens
    .map((token) => {
      if (token.type === "html") return "";
      return token.tokens ? plain(token.tokens) : decodeHTML(token.text ?? "");
    })
    .join("");
}

/**
 * npm excludes prereleases unless a comparator explicitly admits that tuple;
 * subset() otherwise treats <2.0.0 as wider than the caret bound <2.0.0-0.
 */
function comparableRange(spec) {
  if (!semver.validRange(spec)) return null;
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

/** Whether a documented spec admits exactly the declared one: identical, or semver ranges containing each other. */
export function sameRange(documented, declared) {
  if (declared === undefined || !documented) return false;
  if (documented === declared) return true;
  const documentedRange = comparableRange(documented);
  const declaredRange = comparableRange(declared);
  return (
    documentedRange !== null &&
    declaredRange !== null &&
    semver.subset(documentedRange, declaredRange) &&
    semver.subset(declaredRange, documentedRange)
  );
}

/** Replaces a span with spaces, keeping newlines so offsets and lines stay put. */
const blank = (text) => text.replace(/[^\r\n]/g, " ");

function maskCode(text, firstLine, code) {
  const lines = text.split("\n");
  for (const [from, to] of code) {
    for (let line = from; line <= to; line += 1) {
      const index = line - firstLine;
      if (index >= 0 && index < lines.length) lines[index] = "";
    }
  }
  return lines.join("\n");
}

const lineAt = (text, offset) => text.slice(0, offset).split("\n").length - 1;

function supportedRanges(manifest) {
  const ranges = new Map();
  for (const field of SUPPORTED_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith(SCOPE)) ranges.set(name, range);
    }
  }
  return ranges;
}

function checkBlock(inner, at, { file, manifestPath, fail }) {
  if (!existsSync(manifestPath)) {
    fail(
      `${file}:${at}: the antelopejs-docs-compat block has no package.json beside it; ${SYNC} on the package README and delete this block`,
    );
    return;
  }
  const expected = supportedRanges(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const table = marked.lexer(inner).find((token) => token.type === "table");
  const headings =
    table?.header.map((cell) => plain(cell.tokens).trim().toLowerCase()) ?? [];
  const packageColumn = headings.indexOf("package");
  const supportedColumn = headings.indexOf("supported");
  if (packageColumn < 0 || supportedColumn < 0) {
    fail(
      `${file}:${at}: the antelopejs-docs-compat block needs a Package and Supported table; ${SYNC}`,
    );
    return;
  }
  const tableLine = at + lineAt(inner, inner.indexOf(table.raw.split("\n")[0]));
  table.rows.forEach((row, index) => {
    const name = plain(row[packageColumn].tokens).trim();
    const documented = plain(row[supportedColumn].tokens).trim();
    const line = tableLine + 2 + index;
    if (!expected.has(name)) {
      fail(
        `${file}:${line}: ${name} is not declared as an @antelopejs dependency in package.json; ${SYNC}`,
      );
    } else if (!sameRange(documented, expected.get(name))) {
      fail(
        `${file}:${line}: Supported ${documented || "(empty)"} for ${name} differs from package.json ${expected.get(name)}; ${SYNC}`,
      );
    }
    expected.delete(name);
  });
  for (const name of expected.keys()) {
    fail(
      `${file}:${at}: ${name} is missing from the antelopejs-docs-compat block; ${SYNC}`,
    );
  }
}

/** Blanks each generated block after checking it, and fails unpaired markers. */
function generatedBlocks(text, firstLine, context) {
  let masked = text;
  let blocks = 0;
  let cursor = 0;
  for (;;) {
    const start = masked.indexOf(START, cursor);
    const end = masked.indexOf(END, cursor);
    if (start < 0 && end < 0) break;
    if (start < 0 || (end >= 0 && end < start)) {
      context.fail(
        `${context.file}:${firstLine + lineAt(masked, end)}: antelopejs-docs-compat:end has no start marker; ${SYNC}`,
      );
      break;
    }
    const at = firstLine + lineAt(masked, start);
    if (end < 0) {
      context.fail(
        `${context.file}:${at}: antelopejs-docs-compat:start has no end marker; ${SYNC}`,
      );
      break;
    }
    checkBlock(masked.slice(start, end), at, context);
    blocks += 1;
    const stop = end + END.length;
    masked =
      masked.slice(0, start) +
      blank(masked.slice(start, stop)) +
      masked.slice(stop);
    cursor = stop;
  }
  return { masked, blocks };
}

const PACKAGE_CELL = new RegExp(NAME, "i");
const RANGE_CELL = new RegExp(`^(?:${RANGE})(?!\\s*[a-z%]|\\.\\d)`, "i");

/** Column headings for runtimes and tools, whose versions are not package claims. */
const TOOL_COLUMN = /^(?:node(?:\.js)?|pnpm|npm|yarn|bun|deno|typescript)\b/i;
const TABLE_ROW = /^\s*\|/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(line) {
  return line
    .trim()
    .replace(/^\||(?<!\\)\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/[`*_]/g, "").replace(/\\\|/g, "|").trim());
}

const packageIn = (cell) => cell?.match(PACKAGE_CELL)?.[0];
const rangeIn = (cell) => cell.match(RANGE_CELL)?.[0];

/** Table rows pairing a package (in the row or its column heading) with a range in another cell. */
function* tableClaims(lines) {
  let header;
  for (const [index, line] of lines.entries()) {
    if (!TABLE_ROW.test(line)) {
      header = undefined;
      continue;
    }
    if (TABLE_DELIMITER.test(line)) continue;
    if (!header && TABLE_DELIMITER.test(lines[index + 1] ?? "")) {
      header = cells(line);
      continue;
    }
    const row = cells(line);
    const named = row.map(packageIn).find(Boolean);
    for (const [column, cell] of row.entries()) {
      if (TOOL_COLUMN.test(header?.[column] ?? "")) continue;
      const name = packageIn(header?.[column]) ?? named;
      const range = rangeIn(cell);
      if (name && range) yield [index, `${name} ${range}`];
    }
  }
}

/** Each line holding a version claim, 0-based, with its claims. */
function proseClaims(prose) {
  const claims = new Map();
  const lineOf = (offset) => lineAt(prose, offset);
  const claim = (line, text) => {
    const found = claims.get(line) ?? new Set();
    claims.set(line, found.add(text.replace(/\s+/g, " ").trim()));
  };
  for (const match of prose.matchAll(PACKAGE_VERSION)) {
    claim(lineOf(match.index), `${match[1]} ${match[2]}`);
  }
  for (const [line, text] of tableClaims(prose.split("\n"))) claim(line, text);
  for (const match of prose.matchAll(REQUIRES)) {
    const line = lineOf(match.index);
    const phrase = match[1];
    if (
      !claims.has(line) &&
      (phrase === undefined || REQUIRED_ANTELOPEJS.test(phrase))
    ) {
      claim(line, match[0].replace(/[`*_]/g, ""));
    }
  }
  return [...claims].sort(([a], [b]) => a - b);
}

/**
 * Fails `@antelopejs/*` version claims in prose outside the generated
 * compatibility block, and checks each block's Supported column against the
 * package.json beside the document. Frontmatter counts as prose; fenced code,
 * HTML comments, and legacy
 * `docs-compat` tables (manifest-checked) are not prose. Returns the number of
 * generated blocks.
 */
export function checkVersionClaims(doc, { root, fail }) {
  const file = relative(root, doc.path);
  const context = {
    file,
    manifestPath: join(dirname(doc.path), "package.json"),
    fail,
  };
  const { masked, blocks } = generatedBlocks(
    maskCode(doc.text, doc.firstLine, doc.code),
    doc.firstLine,
    context,
  );
  if (CHANGELOG.test(basename(doc.path))) return blocks;
  const prose = `${doc.frontmatter}${masked}`
    .replace(LEGACY_TABLE, blank)
    .replace(HTML_COMMENT, blank);
  for (const [line, claims] of proseClaims(prose)) {
    const quoted = [...claims].map((claim) => `"${claim}"`).join(", ");
    fail(
      `${file}:${line + 1}: version claim ${quoted} outside the antelopejs-docs-compat block; ${FIX}`,
    );
  }
  return blocks;
}
