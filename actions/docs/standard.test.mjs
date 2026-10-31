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
