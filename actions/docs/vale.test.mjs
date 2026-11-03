import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const INI = fileURLToPath(new URL("vale/vale.ini", import.meta.url));
const VALE = process.env.VALE_BIN ?? "vale";

const available = spawnSync(VALE, ["--version"]).status === 0;
if (!available && process.env.CI)
  throw new Error(
    "Vale is not installed: run actions/docs/install-vale.sh and set VALE_BIN",
  );
const vale = { skip: available ? false : "Vale is not installed" };

function alerts(t, text) {
  const root = mkdtempSync(join(tmpdir(), "docs-vale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "page.md"), text);
  const run = spawnSync(
    VALE,
    ["--config", INI, "--output=JSON", join(root, "page.md")],
    {
      encoding: "utf8",
    },
  );
  const parsed = JSON.parse(run.stdout || "{}");
  return Object.values(parsed)
    .flat()
    .map(({ Check, Match, Line }) => [
      Check.replace("AntelopeJS.", ""),
      Match,
      Line,
    ]);
}

const SEEDED = [
  ["Unslop07", "This crucial step matters.", "crucial"],
  ["Unslop08", "The module serves as the entry point.", "serves as"],
  ["Unslop13", "The run stops — the lock is held.", "—"],
  ["Unslop13", "Pages 2–3 cover it.", "–"],
  ["Unslop17", "## Install The Package", "Install The Package"],
  ["Unslop18", "Ship it 🚀 today.", "🚀"],
  ["Unslop19", "Use “straight” quotes.", "“"],
  ["Unslop20", "I hope this helps.", "I hope this helps"],
  ["Unslop22", "Great question about the lock.", "Great question"],
  ["Unslop23", "Run it in order to start.", "in order to"],
  ["Unslop26", "The bedrock of the design is the lock.", "bedrock"],
  ["Unslop31", "Utilize the lock.", "Utilize"],
  ["Names", "AntelopeJS runs on antelopejs hosts.", "antelopejs"],
  ["Names", "Install dms first.", "dms"],
  ["Procedure", "Simply run the command.", "Simply"],
  ["Procedure", "Please run the command.", "Please"],
];

for (const [check, text, match] of SEEDED) {
  it(
    `${check} flags ${JSON.stringify(match)} in ${JSON.stringify(text)}`,
    vale,
    (t) => {
      const found = alerts(t, `${text}\n`);
      assert.ok(
        found.some(([name, hit]) => name === check && hit === match),
        JSON.stringify(found),
      );
    },
  );
}

it(
  "reports nothing for plain prose, sentence-case headings, code spans and fences",
  vale,
  (t) => {
    const found = alerts(
      t,
      [
        "## Install the package",
        "",
        "Run `antelopejs` and `dms` in a terminal. The AntelopeJS CLI starts the DMS server.",
        "",
        "```bash",
        "# Please utilize the crucial flag — it serves as a test",
        "```",
        "",
        "The lock is held. Use a period, not a dash.",
        "",
      ].join("\n"),
    );
    assert.deepEqual(found, []);
  },
);

it("accepts the names listed as heading exceptions", vale, (t) => {
  assert.deepEqual(alerts(t, "## Configure the AntelopeJS DMS API\n"), []);
});

const PRODUCT_HEADINGS = [
  "# AntelopeJS DMS AdonisJS template",
  "## AI assistant",
  "## AI coding agents",
  "### Claude Code",
  "### Codex",
  "## Use Claude Code with the DMS CLI",
  "## Add an AI assistant to AdonisJS",
  "## Configure Claude in Codex",
];

it(
  "accepts sentence-case headings that contain AI, Claude, Claude Code, Codex or AdonisJS",
  vale,
  (t) => {
    assert.deepEqual(
      alerts(t, `${PRODUCT_HEADINGS.join("\n\nText.\n\n")}\n`),
      [],
    );
  },
);

for (const heading of [
  "## Install The Package",
  "## Claude Code Setup",
  "## Using AI Agents",
  "## Add An AI Assistant To AdonisJS",
  "## Configure Claude In Codex",
]) {
  it(
    `still flags the title-case heading ${JSON.stringify(heading)}`,
    vale,
    (t) => {
      assert.deepEqual(alerts(t, `${heading}\n`), [
        ["Unslop17", heading.replace(/^#+ /, ""), 1],
      ]);
    },
  );
}

const PLAYGROUND = [
  '::block-playground{type="Meter" height="160"}',
  "---",
  "options:",
  "  label: Seats",
  "---",
  "::",
];

it("ignores the YAML props block of an MDC component", vale, (t) => {
  assert.deepEqual(
    alerts(t, ["Intro text.", "", ...PLAYGROUND, ""].join("\n")),
    [],
  );
});

it(
  "ignores props blocks of nested components and several in a page",
  vale,
  (t) => {
    const found = alerts(
      t,
      [
        "Intro text.",
        "",
        ":::block-group",
        "---",
        "Props Title Case:",
        "  Label: Seats",
        "---",
        ...PLAYGROUND,
        ":::",
        "",
        ...PLAYGROUND,
        "",
      ].join("\n"),
    );
    assert.deepEqual(found, []);
  },
);

it("still checks a heading and a paragraph after a props block", vale, (t) => {
  const found = alerts(
    t,
    [
      ...PLAYGROUND,
      "",
      "## Install The Package",
      "",
      "Simply run the command.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(found, [
    ["Unslop17", "Install The Package", 8],
    ["Procedure", "Simply", 10],
  ]);
});

it(
  "still checks prose inside a component body and before the props",
  vale,
  (t) => {
    const found = alerts(
      t,
      [
        "Simply start here.",
        "",
        '::block-callout{type="note"}',
        "---",
        "title: Heads Up",
        "---",
        "Please read this crucial note.",
        "::",
        "",
      ].join("\n"),
    );
    assert.deepEqual(found, [
      ["Procedure", "Simply", 1],
      ["Procedure", "Please", 7],
      ["Unslop07", "crucial", 7],
    ]);
  },
);

it("keeps reading a component without a props block", vale, (t) => {
  const found = alerts(
    t,
    ["::block-callout", "Simply run the command.", "::", ""].join("\n"),
  );
  assert.deepEqual(found, [["Procedure", "Simply", 2]]);
});
