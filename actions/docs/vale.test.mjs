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
