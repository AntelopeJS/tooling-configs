import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { checkBody } from "./body-check.ts";
import {
  bin,
  commit,
  linkOxlint,
  PACKAGE_ROOT,
  put,
  read,
  testRepo,
} from "./helpers/test-repo.ts";
import { stampProof } from "./proof-stamp.ts";

const FIXTURES = "src/guardrails/fixtures";

function lintRepo(t: TestContext): string {
  const root = testRepo(t);
  linkOxlint(root);
  put(
    root,
    ".oxlintrc.json",
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["typescript"],
      jsPlugins: [
        {
          name: "anti-slop",
          specifier: join(PACKAGE_ROOT, "src/oxc/anti-slop/index.ts"),
        },
      ],
      rules: {
        "anti-slop/no-unknown-parameters": "error",
        "anti-slop/no-unknown-returns": "error",
        "anti-slop/require-safety-comment-for-type-assertion": "error",
      },
    }),
  );
  return root;
}

function placed(sites: Record<number, string>): string {
  const last = Math.max(...Object.keys(sites).map(Number));
  return `${Array.from({ length: last }, (_, index) => sites[index + 1] ?? "").join("\n")}\n`;
}

/** The rejection-reason sites mongodb#66 left under the ratchet at 0871c38, reduced to one line each at their real line. The `.catch` callback at schema-initialization.test.ts:170 and the `reject` declaration at schema-initialization-helpers.ts:21 are exempt since #81, so those two lines are plain parameter sites. */
function mongodbRejectionReasons(root: string): void {
  put(
    root,
    "src/implementations/database/atomic.ts",
    placed({
      90: "export const atomicFailure = (error: unknown) => TypedWriteError(error);",
    }),
  );
  put(
    root,
    "src/implementations/database/selection.ts",
    placed({
      259: "export const runnerFailure = (error: unknown) => TypedWriteError(error);",
    }),
  );
  put(
    root,
    "src/schema-initialization.ts",
    placed({
      171: "export const rejected = (error: unknown) => handleFailure(error);",
      199: "export function handleFailure(error: unknown) { return error; }",
      223: "export function isInterruption(error: unknown, signal: AbortSignal): boolean { return signal.aborted; }",
    }),
  );
  put(
    root,
    "src/test/schema-initialization.test.ts",
    placed({
      170: "export const teardown = (error: unknown) => error;",
    }),
  );
  put(
    root,
    "src/test/schema-initialization-helpers.ts",
    placed({
      9: "export type Reject = (error: unknown) => void;",
      21: "export const reject = (error: unknown) => error;",
    }),
  );
  put(
    root,
    "src/test/duplicate-keys.test.ts",
    placed({
      76: "export async function refusal(write: PromiseLike<number>): Promise<unknown> { return write; }",
    }),
  );
  commit(root);
}

function rejectionReasonsBody(claimed: number): string {
  return [
    "## Left under the ratchet",
    "",
    "<!-- antelopejs-findings begin -->",
    `- **Promise rejection reasons (${claimed} \`no-unknown-parameters\`, 1 \`no-unknown-returns\`).** A rejection reason is \`any\` in the promise contract.`,
    "- `src/implementations/database/atomic.ts:90` `anti-slop/no-unknown-parameters`: `.catch` into `TypedWriteError`",
    "- `src/implementations/database/selection.ts:259` `anti-slop/no-unknown-parameters`: `.catch` into `TypedWriteError`",
    "- `src/schema-initialization.ts:171` `anti-slop/no-unknown-parameters`: `.then` rejection callback",
    "- `src/schema-initialization.ts:199` `anti-slop/no-unknown-parameters`: `handleFailure`",
    "- `src/schema-initialization.ts:223` `anti-slop/no-unknown-parameters`: `isInterruption`",
    "- `src/test/schema-initialization.test.ts:170` `anti-slop/no-unknown-parameters`: `destroy().catch`",
    "- `src/test/schema-initialization-helpers.ts:9` `anti-slop/no-unknown-parameters`: `Deferred.reject`",
    "- `src/test/schema-initialization-helpers.ts:21` `anti-slop/no-unknown-parameters`: `Deferred.reject`",
    "- `src/test/duplicate-keys.test.ts:76` `anti-slop/no-unknown-returns`: `refusal` returns the caught reason",
    "<!-- antelopejs-findings end -->",
    "",
  ].join("\n");
}

/** cloud#381 cited trust.ts at the lines of 43df3c1; 4806a8a, merged before the head, moved them down two lines. */
function cloudTrust(root: string): void {
  const path = "src/infra/apiserver/trust.ts";
  put(
    root,
    path,
    read(PACKAGE_ROOT, `${FIXTURES}/cloud-381-trust-43df3c1.txt`),
  );
  commit(root);
  put(
    root,
    path,
    read(PACKAGE_ROOT, `${FIXTURES}/cloud-381-trust-4806a8a.txt`),
  );
  commit(root);
}

function trustBody(lines: number[]): string {
  return [
    "## Findings left under the ratchet",
    "",
    "<!-- antelopejs-findings begin -->",
    ...lines.map(
      (line) =>
        `- \`src/infra/apiserver/trust.ts:${line}\` \`anti-slop/require-safety-comment-for-type-assertion\`: undici's own \`RequestInit\`/\`Response\` types differ from the DOM ones`,
    ),
    "<!-- antelopejs-findings end -->",
    "",
  ].join("\n");
}

function commentProofRepo(t: TestContext): string {
  const root = testRepo(t);
  symlinkSync(
    join(PACKAGE_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  put(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  put(
    root,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        rootDir: "src",
        outDir: "dist",
        types: [],
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  put(
    root,
    "src/index.ts",
    "// oxlint-disable-next-line import/no-cycle -- fixture cycle\nexport const value = 1;\n",
  );
  commit(root);
  put(
    root,
    "src/index.ts",
    "// oxlint-disable-next-line import/no-cycle -- fixture cycle\n/** The value. */\nexport const value = 1;\n",
  );
  commit(root);
  return root;
}

test("mongodb#66: a findings-left section written as prose outside an antelopejs-findings block fails", () => {
  const body = read(PACKAGE_ROOT, `${FIXTURES}/mongodb-66-left.txt`);
  const failures = checkBody(PACKAGE_ROOT, body).join("\n");
  assert.match(failures, /expression\.ts:69/);
  assert.match(failures, /antelopejs-body-check --findings/);
});

function referencesIn(failures: string[]): string[] {
  return failures.flatMap((failure) => {
    const found = /`([^`]+)` sits in a findings-left section/u.exec(failure);
    return found ? [found[1]] : [];
  });
}

test("api#81: a table under the plain line `Findings left under the ratchet:` fails, and moving a line number does not hide it", () => {
  const body = read(PACKAGE_ROOT, `${FIXTURES}/api-81-findings-left.txt`);
  assert.deepEqual(referencesIn(checkBody(PACKAGE_ROOT, body)), [
    "src/test/listen.test.ts:35",
    "src/implementations/api/index.ts:240",
    "playground/src/index.ts:25",
  ]);
  const moved = body.replace("listen.test.ts:35", "listen.test.ts:99");
  assert.match(
    checkBody(PACKAGE_ROOT, moved).join("\n"),
    /listen\.test\.ts:99/,
  );
});

test("dms-database#71: findings written as a file and a line range under a proper heading fail", () => {
  const body = read(
    PACKAGE_ROOT,
    `${FIXTURES}/dms-database-71-findings-left.txt`,
  );
  assert.deepEqual(referencesIn(checkBody(PACKAGE_ROOT, body)), [
    "src/routes/data.ts",
    "src/routes/query.ts",
    "src/service/browse.ts",
    "src/service/fieldDescriptor.ts",
  ]);
});

test("a bold line, `## Kept under the ratchet` and `## Not fixed` each open a findings section", () => {
  for (const title of [
    "**Left under the ratchet**",
    "**Findings left under the ratchet:**",
    "## Kept under the ratchet",
    "## Not fixed",
  ])
    assert.deepEqual(
      referencesIn(
        checkBody(PACKAGE_ROOT, `${title}\n\n- \`src/routes/data.ts\` 57-64\n`),
      ),
      ["src/routes/data.ts"],
      title,
    );
});

test("a code file named outside a findings-left section, or as a bare .d.ts, passes", () => {
  const bodies = [
    "## What changed\n\n- `src/test/listen.test.ts:35` now calls `configureFromJson`; `src/routes/data.ts` 57-64 is split.\n",
    "Findings left under the ratchet:\n\n- the `.d.ts` of the controllers\n\n## Attention\n\n- `src/routes/data.ts:57` is unchanged.\n",
    "The findings left under the ratchet are in `src/routes/data.ts`.\n",
    "## Left over\n\n- `src/routes/data.ts` keeps its name.\n",
  ];
  for (const body of bodies)
    assert.deepEqual(checkBody(PACKAGE_ROOT, body), [], body);
});

test("mongodb#66: a typed count of 9 `no-unknown-parameters` over the 8 findings listed under it fails", (t) => {
  const root = lintRepo(t);
  mongodbRejectionReasons(root);
  assert.match(
    checkBody(root, rejectionReasonsBody(9)).join("\n"),
    /claims 9 `no-unknown-parameters`.*8 listed/,
  );
  assert.deepEqual(checkBody(root, rejectionReasonsBody(8)), []);
});

test("cloud#381: trust.ts lines not recopied after a later commit fail and name the live lines", (t) => {
  const root = lintRepo(t);
  cloudTrust(root);
  const stale = checkBody(root, trustBody([35, 37, 37])).join("\n");
  assert.match(
    stale,
    /trust\.ts:35.*no live `anti-slop\/require-safety-comment-for-type-assertion`/,
  );
  assert.match(stale, /live at 37, 39, 39/);
  assert.deepEqual(checkBody(root, trustBody([37, 39, 39])), []);
});

test("cloud#381: a finding left out of a rule the list covers fails", (t) => {
  const root = lintRepo(t);
  cloudTrust(root);
  assert.match(
    checkBody(root, trustBody([37, 39])).join("\n"),
    /trust\.ts:39 `anti-slop\/require-safety-comment-for-type-assertion` is live at HEAD but not listed/,
  );
});

test("a finding listed without a reason fails", (t) => {
  const root = lintRepo(t);
  cloudTrust(root);
  const body = trustBody([37, 39, 39]).replace(/: undici[^\n]*\n/, ": <why>\n");
  assert.match(
    checkBody(root, body).join("\n"),
    /trust\.ts:37.*give the reason/,
  );
});

test("mongodb#66: a suppression table typed outside a stamped proof block fails", () => {
  const body = read(PACKAGE_ROOT, `${FIXTURES}/mongodb-66-suppressions.txt`);
  assert.match(
    checkBody(PACKAGE_ROOT, body).join("\n"),
    /suppression table.*antelopejs-api-diff <base-ref>.*antelopejs-comment-proof <base-ref>/,
  );
});

test("a stamped comment-proof block passes as printed and fails once edited by hand or left stale by a later commit", (t) => {
  const root = commentProofRepo(t);
  const proof = bin(root, "comment-proof", ["HEAD~1"]);
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);
  const body = `## Proofs\n\n${proof.stdout}\n`;
  assert.deepEqual(checkBody(root, body), []);
  const indented = proof.stdout.replaceAll(/^(?=.)/gmu, "\t");
  assert.deepEqual(
    checkBody(root, `- Output:\n\n\t\`\`\`\n${indented}\t\`\`\`\n`),
    [],
  );
  const edited = body.replace(
    "| Lint suppressions, all rules | 1 | 1 |",
    "| Lint suppressions, all rules | 1 | 0 |",
  );
  assert.notEqual(edited, body);
  assert.match(
    checkBody(root, edited).join("\n"),
    /edited after `antelopejs-comment-proof HEAD~1` printed it/,
  );
  put(
    root,
    "src/extra.ts",
    "// SAFETY: a later boundary\nexport const extra = 2;\n",
  );
  commit(root);
  assert.match(
    checkBody(root, body).join("\n"),
    /`SAFETY:` comments.*no longer matches HEAD.*antelopejs-comment-proof HEAD~1/,
  );
});

test("an api-diff block stamped before a later commit fails, and one stamped at HEAD passes", (t) => {
  const root = testRepo(t);
  const output =
    "API: 1 packages, 1 entries unchanged against HEAD~1 (committed HEAD).\n";
  const early = stampProof(root, "antelopejs-api-diff HEAD", "HEAD", output);
  put(root, "src/later.ts", "export const later = 1;\n");
  commit(root);
  assert.match(
    checkBody(root, early).join("\n"),
    /stamped at [0-9a-f]{12}, but HEAD is [0-9a-f]{12}.*antelopejs-api-diff HEAD/,
  );
  const current = stampProof(root, "antelopejs-api-diff HEAD", "HEAD", output);
  assert.deepEqual(checkBody(root, current), []);
  assert.match(
    checkBody(root, `Printed ${output}`).join("\n"),
    /outside a stamped proof block/,
  );
});

test("an api-diff stamp whose base is HEAD itself fails against the pull request base, and one stamped against that base passes", (t) => {
  const root = testRepo(t);
  const prBase = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  put(root, "src/change.ts", "export const change = 1;\n");
  commit(root);
  const output =
    "API: 1 packages, 1 entries unchanged against HEAD (committed HEAD).\n";
  const selfBase = stampProof(root, "antelopejs-api-diff HEAD", "HEAD", output);
  assert.deepEqual(checkBody(root, selfBase), []);
  assert.match(
    checkBody(root, selfBase, { base: prBase }).join("\n"),
    /base is not the pull request base.*antelopejs-api-diff <pull request base>/,
  );
  const honest = stampProof(
    root,
    `antelopejs-api-diff ${prBase}`,
    prBase,
    output,
  );
  assert.deepEqual(checkBody(root, honest, { base: prBase }), []);
  const proof = stampProof(
    root,
    "antelopejs-comment-proof HEAD",
    "HEAD",
    output,
  );
  assert.deepEqual(checkBody(root, proof, { base: prBase }), []);
});

test("body-check --base reaches the check", (t) => {
  const root = testRepo(t);
  const prBase = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  put(root, "src/change.ts", "export const change = 1;\n");
  commit(root);
  put(
    root,
    "body.md",
    stampProof(
      root,
      "antelopejs-api-diff HEAD",
      "HEAD",
      "API: 1 packages, 1 entries unchanged against HEAD (committed HEAD).\n",
    ),
  );
  assert.equal(bin(root, "body-check", ["body.md"]).status, 0);
  const pinned = bin(root, "body-check", ["body.md", "--base", prBase]);
  assert.equal(pinned.status, 1);
  assert.match(pinned.stderr, /base is not the pull request base/);
});

test("body-check --findings prints a block that passes once each reason is given, and --head refuses another checkout", (t) => {
  const root = lintRepo(t);
  cloudTrust(root);
  const printed = bin(root, "body-check", ["--findings"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(
    printed.stdout,
    /`anti-slop\/require-safety-comment-for-type-assertion` \(3\):/,
  );
  put(root, "body.md", printed.stdout);
  const placeholder = bin(root, "body-check", ["body.md"]);
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /give the reason/);
  put(root, "body.md", printed.stdout.replaceAll("<why>", "undici types"));
  assert.equal(bin(root, "body-check", ["body.md"]).status, 0);
  const other = bin(root, "body-check", ["body.md", "--head", "0".repeat(40)]);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /check out the pull request head/);
});
