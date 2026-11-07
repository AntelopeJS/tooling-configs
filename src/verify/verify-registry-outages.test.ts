import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { put } from "../guardrails/helpers/test-repo.ts";
import {
  FAKE_TOOL,
  FAKE_TOOLS,
  PRINT_FILE,
  REGISTRY_IDS,
  registryHelpers,
  registryJourneys,
} from "./helpers/registry-journeys.ts";
import {
  feature,
  journeyStatuses,
  PUBLISH_DOORS,
  verifyRepo,
} from "./helpers/verify-repo.ts";

const SKILL = ".agents/skills/verify-module";

const LOCK =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";

function config(bin: string): string {
  return `import { join } from "node:path";
${registryHelpers(bin)}
export default {
  doors: ${PUBLISH_DOORS},
  setup: [["node", "-e", "0"]],
  journeys: {${registryJourneys()}
  },
};
`;
}

/** A module repository whose journeys run fake `pnpm`, `npm`, `docker` and `ajs` tools that print what the case says. */
function registryRepo(t: TestContext) {
  const tmp = mkdtempSync(join(tmpdir(), "verify-registry-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const bin = join(tmp, "bin");
  const root = verifyRepo(t, {
    "README.md": "# Demo\n",
    "package.json": '{"name":"demo","type":"module","version":"1.0.0"}\n',
    "pnpm-lock.yaml": LOCK,
    "src/store.ts": "export const store = 1;\n",
    [`${SKILL}/verify.config.ts`]: config(bin),
    [`${SKILL}/features/registry.md`]: feature(["src/**"], REGISTRY_IDS),
  });
  put(bin, "print.cjs", PRINT_FILE);
  for (const name of FAKE_TOOLS) {
    put(bin, name, FAKE_TOOL);
    chmodSync(join(bin, name), 0o755);
  }
  return { root, tmp, env: { PATH: `${bin}:${process.env.PATH}` } };
}

let finished: ReturnType<typeof journeyStatuses> | undefined;

/** Runs the feature once for the whole file, so each test reads its journeys from one run. */
function registryRun(t: TestContext) {
  if (finished !== undefined) return finished.statuses;
  const { root, tmp, env } = registryRepo(t);
  finished = journeyStatuses(root, tmp, env, "registry");
  return finished.statuses;
}

function assertFail(t: TestContext, ids: string[]) {
  const statuses = registryRun(t);
  for (const id of ids) assert.equal(statuses[id], "FAIL", id);
}

function assertOutage(t: TestContext, cases: [string, string, RegExp][]) {
  const statuses = registryRun(t);
  for (const [id, step, cause] of cases)
    assert.match(
      statuses[id] ?? "",
      new RegExp(
        `^NOT VERIFIED: step 01-${step} could not reach a container or package registry, an outage outside the code under test: ${cause.source}`,
      ),
      id,
    );
}

test("a failed pull or install whose every error line is a network cause at a registry request target is NOT VERIFIED and names the step and the cause (catches a classifier that needs more than the error lines)", (t) => {
  assertOutage(t, [
    [
      "docker-dns",
      "docker-build",
      /.*lookup registry-1\.docker\.io.*server misbehaving/,
    ],
    [
      "docker-deadline",
      "docker-build",
      /.*registry-1\.docker\.io.*context deadline exceeded/,
    ],
    [
      "ecr-no-such-host",
      "docker-build",
      /.*dkr\.ecr\.eu-west-1\.amazonaws\.com.*no such host/,
    ],
    [
      "npm-enotfound",
      "pnpm-install",
      /npm error network request .*ENOTFOUND registry\.npmjs\.org/,
    ],
    [
      "pnpm-socket-hang-up",
      "pnpm-install",
      /ERR_PNPM_META_FETCH_FAIL .*socket hang up/,
    ],
    ["ansi-colored", "pnpm-install", /npm error network request .*ENOTFOUND/],
  ]);
});

test("a 5xx or 429 answer with a registry host is NOT VERIFIED (catches dropping the E5xx, ERR_PNPM_FETCH_5xx, toomanyrequests and Docker status forms)", (t) => {
  assertOutage(t, [
    ["npm-503", "pnpm-install", /npm error code E503/],
    ["pnpm-502", "pnpm-install", /ERR_PNPM_FETCH_502 /],
    [
      "docker-5xx-with-url",
      "docker-pull",
      /docker: .*unexpected HTTP status: 503/,
    ],
    ["docker-toomanyrequests", "docker-build", /.*toomanyrequests/],
    ["docker-pull-rate-limit", "docker-pull", /docker: .*pull rate limit/],
  ]);
});

test("the Docker network causes, a newer buildx error, a pnpm ECONNRESET code, a gcr subdomain and a cause in capitals are NOT VERIFIED (catches a cause list without them)", (t) => {
  assertOutage(t, [
    [
      "docker-name-resolution",
      "docker-pull",
      /docker: .*Temporary failure in name resolution/,
    ],
    [
      "docker-client-timeout",
      "docker-pull",
      /docker: .*Client\.Timeout exceeded while awaiting headers/,
    ],
    [
      "docker-connection-refused",
      "docker-pull",
      /docker: .*104\.18\.122\.25:443: connect: connection refused/,
    ],
    [
      "docker-network-unreachable",
      "docker-run",
      /docker: .*ghcr\.io.*network is unreachable/,
    ],
    ["gcr-subdomain", "docker-pull", /docker: .*eu\.gcr\.io.*no such host/],
    [
      "buildx-failed-to-build",
      "docker-buildx-build",
      /ERROR: failed to build: failed to solve/,
    ],
    ["pnpm-econnreset", "pnpm-install", /ERR_PNPM_ECONNRESET /],
    [
      "cause-in-capitals",
      "pnpm-install",
      /ERR_PNPM_META_FETCH_FAIL .*Socket Hang Up/,
    ],
  ]);
});

test("each fetching command is NOT VERIFIED, by its program on the path or by an absolute path (catches a gate that knows fewer commands or compares the whole program path)", (t) => {
  assertOutage(t, [
    ["compose-up", "docker-compose-up", /.*server misbehaving/],
    ["npm-ci", "npm-ci", /npm error network request .*ENOTFOUND/],
    ["pnpm-add", "pnpm-add-left-pad", /npm error network request .*ENOTFOUND/],
    [
      "ajs-module-install",
      "ajs-module-install",
      /npm error network request .*ENOTFOUND/,
    ],
    [
      "absolute-program",
      "pnpm-install",
      /npm error network request .*ENOTFOUND/,
    ],
  ]);
});

test("a step that does not fetch stays FAIL even when its output is a perfect outage (catches a classifier with no program gate, and a gate that matches any command word)", (t) => {
  assertFail(t, [
    "step-pnpm-test",
    "step-pnpm-run-build",
    "step-pnpm-run-install",
    "step-npm-test",
    "step-docker-exec",
    "step-node",
  ]);
});

test("a 5xx or 429 without a registry host, or against a host that is not one, stays FAIL (catches a status that counts from any host)", (t) => {
  assertFail(t, [
    "status-without-host-pnpm",
    "status-without-host-npm",
    "status-without-url-docker",
    "rate-limit-without-url-docker",
    "status-500-pnpm-localhost",
    "status-500-npm-localhost",
    "status-500-docker-localhost",
  ]);
});

test("npm output quoted by a product test, or any other product failure in the step, stays FAIL (catches trimming every line, and a veto only for error-form lines)", (t) => {
  assertFail(t, [
    "indented-npm-under-test-name",
    "indented-npm-quoted",
    "ts-error-on-other-stream",
    "build-failure-before-outage",
    "scaffold-checks-output",
    "recovered-retry-then-ts-error",
  ]);
});

test("a product error line before the outage, after it, or on the other stream stays FAIL (catches letting only the last error-form line decide)", (t) => {
  assertFail(t, [
    "product-error-before-outage",
    "pnpm-product-error-before-outage",
    "docker-process-error-before-outage",
    "product-error-after-outage",
    "streams-disagree",
  ]);
});

test("a cause that is not about the registry request stays FAIL (catches finding the host anywhere on the line, and a cause that needs no address check)", (t) => {
  assertFail(t, [
    "proxy-refuses-registry-request",
    "docker-dial-loopback",
    "request-target-is-not-registry",
    "pnpm-get-host-unknown",
    "docker-host-on-npm-line",
  ]);
});

test("a test named after an outage, a rate limiter, a product log line, a missing tag, a product timeout and a source file name stay FAIL (catches deciding on any line that mentions a registry)", (t) => {
  assertFail(t, [
    "mirror-test-name",
    "product-rate-limiter",
    "pino-url-field",
    "missing-tag",
    "product-timeout",
    "source-file-name",
  ]);
});

test("a typo host and a private registry stay FAIL (catches a generic registry.<domain> host pattern)", (t) => {
  assertFail(t, ["typo-host", "private-registry"]);
});

test("a registry error in a step whose command exits 0 but whose check fails stays FAIL (catches deciding without the exit code)", (t) => {
  assertFail(t, ["exit-zero"]);
});

test("a registry error in a step whose checks passed, or after a product failure, does not hide the failure (catches reading any step instead of the first failing one)", (t) => {
  assertFail(t, ["expected-failure", "product-fails-first"]);
});

test("a line over 8 KiB in bytes, even a multibyte outage line under 8 KiB in characters, or one after an outage, stays FAIL (catches skipping long lines, counting characters, and unbounded matching)", (t) => {
  assertFail(t, [
    "oversized-line",
    "oversized-product-error-after-outage",
    "multibyte-outage-line",
  ]);
});
