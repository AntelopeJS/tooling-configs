import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

import { checkDocs } from "./check.mjs";
import { fixture } from "./fixtures.mjs";

const VALE = process.env.VALE_BIN ?? "vale";
const hasVale = spawnSync(VALE, ["--version"]).status === 0;
if (!hasVale && process.env.CI)
  throw new Error("Vale is not installed: run actions/docs/install-vale.sh");
const vale = { skip: hasVale ? false : "Vale is not installed" };

const PAGE = (body, front = {}) => {
  const fields = {
    title: "Configure the module",
    description: "Set the options the module reads at start.",
    mode: "how-to",
    ...front,
  };
  const head = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${head}\n---\n\n${body}\n`;
};

const OPT_IN = '{"type":"module","antelopeJs":{"docs":{"standard":true}}}';

function run(t, files, { standard = true, vale: withVale = false } = {}) {
  const { root } = fixture(t, {
    "package.json": standard ? OPT_IN : '{"type":"module"}',
    ...files,
  });
  return checkDocs({
    root,
    files: ["README.md", "docs"],
    valeBin: withVale ? VALE : false,
  });
}

const README = "# Package\n\nA package for the server.\n";
const words = (count) => Array.from({ length: count }, () => "word").join(" ");

it("does nothing unless the repository opts in", (t) => {
  const { failures } = run(
    t,
    {
      "README.md": README,
      "docs/page.md": "# Title\n\nPlease simply run it.\n",
    },
    { standard: false },
  );
  assert.deepEqual(failures, []);
});

it("requires title, description and mode in a page, and one of the four modes", (t) => {
  const { failures } = run(t, {
    "README.md": README,
    "docs/none.md": "Body text for the page.\n",
    "docs/some.md":
      "---\ntitle: Only a title\n---\n\nBody text for the page.\n",
    "docs/bad.md": PAGE("Body text for the page.", { mode: "guide" }),
  });
  assert.deepEqual(failures.toSorted(), [
    "docs/bad.md: frontmatter mode must be tutorial, how-to, reference or explanation, not guide",
    "docs/none.md: frontmatter needs description",
    "docs/none.md: frontmatter needs mode",
    "docs/none.md: frontmatter needs title",
    "docs/some.md: frontmatter needs description",
    "docs/some.md: frontmatter needs mode",
  ]);
});

it("accepts a page that has all three fields in each mode", (t) => {
  const files = { "README.md": README };
  for (const mode of ["tutorial", "how-to", "reference", "explanation"])
    files[`docs/${mode}.md`] = PAGE("Body text for the page.", { mode });
  assert.deepEqual(run(t, files).failures, []);
});

it("fails a body H1 in a page but not in the README", (t) => {
  const { failures } = run(t, {
    "README.md": README,
    "docs/page.md": PAGE("# Duplicate title\n\nBody text for the page."),
  });
  assert.deepEqual(failures, [
    "docs/page.md:7: the title comes from frontmatter, remove the body H1",
  ]);
});

it("fails a page above 3000 words and counts neither fences nor frontmatter", (t) => {
  const { failures } = run(t, {
    "README.md": README,
    "docs/long.md": PAGE(`${words(3001)}`),
    "docs/limit.md": PAGE(
      `${words(3000)}\n\n\`\`\`text\n${words(500)}\n\`\`\``,
    ),
  });
  assert.deepEqual(failures, [
    "docs/long.md: 3001 words, split the page at 3000",
  ]);
});

it("fails a Node version range in prose and allows it in code and in the generated block", (t) => {
  const { failures } = run(t, {
    "README.md": README,
    "docs/bad.md": PAGE(
      [
        "It needs Node.js >= 22.",
        "",
        "It runs on Node 20 or later.",
        "",
        "It needs node 22.18+ today.",
      ].join("\n"),
    ),
    "docs/good.md": PAGE(
      [
        "Node.js is single-threaded.",
        "",
        "Run `node >=22` in a shell.",
        "",
        "<!-- antelopejs-docs-node:start -->",
        "This package requires Node.js `>=22.18.0`.",
        "<!-- antelopejs-docs-node:end -->",
      ].join("\n"),
    ),
  });
  assert.deepEqual(failures, [
    "docs/bad.md:7: Node version range in prose, state it once in package.json engines",
    "docs/bad.md:9: Node version range in prose, state it once in package.json engines",
    "docs/bad.md:11: Node version range in prose, state it once in package.json engines",
  ]);
});

it("fails a framework or tool version in prose and checks the description, and allows it in code at any depth, links, URLs, comments, and before a year, status, ratio, decimal comma or measure", (t) => {
  const { failures } = run(t, {
    "README.md": README,
    "docs/bad.md": PAGE(
      [
        "Only AdonisJS 6 is tested.",
        "",
        "The page builds on Vue 3.5 components.",
        "",
        "Install pnpm v10 first, then TypeScript >= 5.6.",
        "",
        "It also runs on Nuxt 4 and Vue.js 3.",
        "",
        "It is built on AdonisJS",
        "7 and Vue 3.6.0-beta.1, for Vue 3-based apps.",
        "",
        "It runs on **Vue** 3.5, Express.js 5 and TypeScript version 5.6.",
        "",
        "It is built on AdonisJS",
        "6. Install it next.",
      ].join("\n"),
      { description: "Set up the module on Nuxt 4." },
    ),
    "docs/stray.md": PAGE("Body text for the page.", {
      title: "Compare n<m",
      description: "Set up the module on Vue 3.",
      note: "a > b",
    }),
    "docs/crlf.md": PAGE("We use Vue\n3.5 here.").replaceAll("\n", "\r\n"),
    "docs/good.md": PAGE(
      [
        "AdonisJS apps load the module at start.",
        "",
        "Run `pnpm add vue@3.5` in a shell.",
        "",
        "Vue components render in 2 steps, and TypeScript checks 12 files.",
        "",
        "The MongoDB 2026-Q3 restore passed, Redis 3/173 failovers held, and MySQL 6,5 s stayed flat.",
        "",
        "Redis 99.9% uptime, Redis 100 ms latency, a React 12:30 standup and an Express 404 handler are not versions.",
        "",
        "Use ``pnpm v10`` in [the guide](https://example.com/?tool=Vite5) or https://example.com/#Vue3.",
        "",
        "<!-- Vue 3.5 -->",
        "",
        "1. Install the tools:",
        "",
        "   ```sh",
        "   pnpm v10",
        "   ```",
        "",
        "> ```sh",
        "> Vue 3.5",
        "> ```",
        "",
        "1. Install pnpm",
        "2. Run the build",
        "",
        "> 1. Install pnpm",
        "> 2. Run the build",
      ].join("\n"),
      { note: "use `Vue 3` carefully" },
    ),
  });
  assert.deepEqual(failures, [
    'docs/bad.md:3: "Nuxt 4" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:7: "AdonisJS 6" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:9: "Vue 3.5" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:11: "pnpm v10" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:11: "TypeScript >= 5.6" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:13: "Nuxt 4" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:13: "Vue.js 3" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:15: "AdonisJS 7" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:16: "Vue 3.6.0-beta.1" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:16: "Vue 3-based" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:18: "Vue 3.5" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:18: "Express.js 5" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:18: "TypeScript version 5.6" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/bad.md:20: "AdonisJS 6" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/crlf.md:7: "Vue 3.5" states a version in prose, point at the pin in package.json or .nvmrc',
    'docs/stray.md:3: "Vue 3" states a version in prose, point at the pin in package.json or .nvmrc',
  ]);
});

it("passes an image that is a capture output or marked illustration, and fails any other", (t) => {
  const { failures } = run(t, {
    "README.md": README,
    "docs/images/home.webp": "webp",
    "docs/images/flow.svg": "<svg/>",
    "docs/images/logo.svg": "<svg/>",
    "docs/images/hand.png": "png",
    "docs/captures.ts":
      'export default [{ id: "home", output: "docs/images/home.webp" }];\n',
    "docs/page.md": PAGE(
      [
        "![Home](./images/home.webp)",
        "",
        '![Diagram of the flow](./images/flow.svg "illustration")',
        "",
        '<img src="./images/logo.svg" alt="Logo" data-illustration>',
        "",
        "![Hand made](./images/hand.png)",
        "",
        "![Remote](https://example.com/shot.png)",
      ].join("\n"),
    ),
  });
  assert.deepEqual(failures, [
    "docs/page.md: image ./images/hand.png is neither a docs/captures.ts output nor marked illustration",
    "docs/page.md: image https://example.com/shot.png is neither a docs/captures.ts output nor marked illustration",
  ]);
});

it("fails prose that is not English, outside fences", (t) => {
  const { failures } = run(t, {
    "README.md": README,
    "docs/fr.md": PAGE(
      "Ce module lit la configuration dans le fichier que vous passez, et il échoue quand une clé est absente.",
    ),
  });
  assert.deepEqual(failures, ["docs/fr.md:7: prose is not English"]);
});

it(
  "fails every Vale warning with its rule, and nothing on clean prose",
  vale,
  (t) => {
    const { failures } = run(
      t,
      {
        "README.md": README,
        "docs/bad.md": PAGE("This crucial step matters. Simply run it."),
        "docs/good.md": PAGE("This step matters. Run it."),
      },
      { vale: true },
    );
    assert.deepEqual(failures, [
      "docs/bad.md:7: AntelopeJS.Unslop07 Replace the AI vocabulary word 'crucial' with a plain word (unslop rule 7).",
      "docs/bad.md:7: AntelopeJS.Procedure Cut 'Simply'. It has no place in a procedure.",
    ]);
  },
);

it("fails when the repository opts in and Vale is not installed", (t) => {
  const { root } = fixture(t, {
    "package.json": OPT_IN,
    "README.md": README,
  });
  const { failures } = checkDocs({
    root,
    files: ["README.md"],
    valeBin: "/nonexistent/vale",
  });
  assert.deepEqual(failures, [
    "standard mode needs Vale: run install-vale.sh and set VALE_BIN",
  ]);
});

it("leaves out what the site never publishes: design/ under a docs folder and grill logs", (t) => {
  const log = `# Decision log\n\nPlease simply read [gone](missing.md).\n\n${words(3500)}\n`;
  const { failures } = run(t, {
    "README.md": README,
    "docs/page.md": PAGE("Set the option."),
    "docs/design/log.md": log,
    "docs/design/deep/notes.md": log,
    "docs/guides/session-grill-me.md": log,
    "docs/session-grill.md": log,
  });
  assert.deepEqual(failures, []);
});

it("still checks a nested design folder, a page that merely mentions design, and a file named in docs-files", (t) => {
  const { root } = fixture(t, {
    "package.json": OPT_IN,
    "README.md": README,
    "docs/guides/design/page.md": "No frontmatter here.\n",
    "docs/design.md": "No frontmatter here either.\n",
    "docs/design/log.md": "No frontmatter in the named log.\n",
  });
  const { failures, files } = checkDocs({
    root,
    files: ["README.md", "docs", "docs/design/log.md"],
    valeBin: false,
  });
  assert.equal(files, 4);
  for (const path of [
    "docs/guides/design/page.md",
    "docs/design.md",
    "docs/design/log.md",
  ])
    assert.match(failures.join("\n"), new RegExp(path));
});
