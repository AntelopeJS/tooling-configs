import assert from "node:assert/strict";
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

/** The rejection-reason sites mongodb#66 left under the ratchet at 0871c38, reduced to one line each at their real line. */
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
      170: "export const teardown = destroy().catch((error: unknown) => error);",
    }),
  );
  put(
    root,
    "src/test/schema-initialization-helpers.ts",
    placed({
      9: "export type Reject = (error: unknown) => void;",
      21: "export let reject!: (error: unknown) => void;",
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
