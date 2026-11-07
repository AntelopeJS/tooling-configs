/** What a journey's one failing command prints and how it exits; `<fill>` in `stderr` becomes `fill` repetitions of `a.`. */
interface RegistryCase {
  step: string;
  stdout?: string;
  stderr?: string;
  exit?: number;
  fill?: number;
}

const NPM_ENOTFOUND =
  "npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\nnpm error network This is a problem related to network connectivity.";

const BUILDKIT_DNS =
  'ERROR: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22-alpine": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving';

const ECR = "123456789012.dkr.ecr.eu-west-1.amazonaws.com";

/** Each journey id with the failing command it runs. */
const REGISTRY_CASES = {
  "docker-dns": { step: "docker build", stderr: BUILDKIT_DNS },
  "docker-deadline": {
    step: "docker build",
    stderr:
      'ERROR: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22-alpine": context deadline exceeded',
  },
  "ecr-no-such-host": {
    step: "docker build",
    stderr: `ERROR: failed to solve: ${ECR}/app:1: failed to do request: Head "https://${ECR}/v2/app/manifests/1": dial tcp: lookup ${ECR}: no such host`,
  },
  "docker-toomanyrequests": {
    step: "docker build",
    stderr:
      "ERROR: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: toomanyrequests: too many requests",
  },
  "docker-pull-rate-limit": {
    step: "docker pull",
    stderr:
      "docker: Error response from daemon: You have reached your unauthenticated pull rate limit.",
  },
  "docker-5xx-no-host": {
    step: "docker pull",
    stderr:
      "docker: error pulling image configuration: received unexpected HTTP status: 503 Service Unavailable",
  },
  "npm-enotfound": { step: "pnpm install", stderr: NPM_ENOTFOUND },
  "npm-503": {
    step: "pnpm install",
    stderr:
      "npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/left-pad",
  },
  "pnpm-502": {
    step: "pnpm install",
    stdout:
      " ERR_PNPM_FETCH_502  GET https://registry.npmjs.org/left-pad: Bad Gateway - 502",
  },
  "pnpm-503-no-host": {
    step: "pnpm install",
    stdout: " ERR_PNPM_FETCH_503  The registry answered 503",
  },
  "pnpm-socket-hang-up": {
    step: "pnpm install",
    stdout:
      " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/typescript: request to https://registry.npmjs.org/typescript failed, reason: socket hang up",
  },
  "ansi-colored": {
    step: "pnpm install",
    stderr:
      "\u001b[1m\u001b[31mnpm error\u001b[39m\u001b[22m network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo \u001b[1mENOTFOUND\u001b[22m registry.npmjs.org",
  },
  "product-error-before-outage": {
    step: "pnpm install",
    stderr: `npm error code ELIFECYCLE\n${NPM_ENOTFOUND}`,
  },
  "missing-tag": {
    step: "docker build",
    stderr:
      "ERROR: failed to solve: docker.io/acme/missing:1.0: failed to resolve source metadata for docker.io/acme/missing:1.0: docker.io/acme/missing:1.0: not found\nError response from daemon: manifest for acme/missing:1.0 not found: manifest unknown: manifest unknown",
  },
  "product-timeout": {
    step: "start",
    stderr:
      "Error: i/o timeout while reading the cache at 127.0.0.1:6379; the request timeout of 30000 ms elapsed",
  },
  "recovered-retry-then-ts-error": {
    step: "pnpm run build",
    stderr:
      "WARN GET https://registry.npmjs.org/typescript error (ECONNRESET). Will retry in 10 seconds. 2 retries left.\nsrc/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  },
  "mirror-test-name": {
    step: "pnpm test",
    stdout:
      "✖ falls back to the mirror when registry.npmjs.org answers 503 Service Unavailable",
  },
  "product-rate-limiter": {
    step: "pnpm test",
    stderr: "TooManyRequests: the limiter rejected 11 requests in 1 s",
  },
  "typo-host": {
    step: "pnpm install",
    stderr:
      "npm error network request to https://registry.npmjs.ogr/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.ogr",
  },
  "private-registry": {
    step: "pnpm install",
    stderr:
      "npm error network request to http://registry.acme.internal:8081/left-pad failed, reason: connect ECONNREFUSED registry.acme.internal:8081",
  },
  "source-file-name": {
    step: "pnpm test",
    stderr: "npm error code ETIMEDOUT while reading src/registry.service.ts",
  },
  "pino-url-field": {
    step: "pnpm test",
    stdout:
      '{"level":50,"msg":"npm error code ECONNRESET","url":"https://registry.npmjs.org/left-pad","err":"ECONNRESET"}',
  },
  "pnpm-get-host-unknown": {
    step: "pnpm install",
    stdout:
      " ERR_PNPM_META_FETCH_FAIL  GET https://registry.acme.internal/left-pad: request failed through registry.npmjs.org, reason: ECONNREFUSED",
  },
  "docker-host-on-npm-line": {
    step: "pnpm install",
    stderr:
      "npm error network request to https://registry-1.docker.io/v2/ failed, reason: getaddrinfo ENOTFOUND registry-1.docker.io",
  },
  "scaffold-checks-output": {
    step: "pnpm run checks",
    stdout:
      "src/registry.service.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\n✖ falls back to the mirror when registry.npmjs.org answers 503 Service Unavailable\n  Error: getaddrinfo ENOTFOUND registry.npmjs.org\n ELIFECYCLE  Command failed with exit code 1.",
  },
  "exit-zero": { step: "pnpm install", stderr: NPM_ENOTFOUND, exit: 0 },
  "product-error-after-outage": {
    step: "pnpm install",
    stderr: `${NPM_ENOTFOUND}\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  demo@1.0.0 test: node --test`,
  },
  "streams-disagree": {
    step: "docker build",
    stdout:
      'ERROR: failed to solve: process "/bin/sh -c make" did not complete successfully: exit code: 2',
    stderr: BUILDKIT_DNS,
  },
  "oversized-line": {
    step: "pnpm install",
    stderr:
      "npm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org <fill>",
    fill: 2_500_000,
  },
} satisfies Record<string, RegistryCase>;

/** Journeys that need more than one command. */
const EXTRA_IDS = ["expected-failure", "product-fails-first"];

/** Every journey id of the registry feature. */
export const REGISTRY_IDS = [...Object.keys(REGISTRY_CASES), ...EXTRA_IDS];

const AFTER =
  "npm error network request to https://registry.npmjs.org/left-pad failed, reason: read ECONNRESET";

/** Config source defining `failing(context, name, case)`, which runs one command that prints and exits as the case says and then fails a check. */
export const REGISTRY_HELPERS = String.raw`
const PRINT = "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2].replace('<fill>', 'a.'.repeat(Number(process.argv[4])))); process.exitCode = Number(process.argv[3]);";
async function failing(context, name, spec) {
  const run = await context.command(name, process.execPath, ["-e", PRINT, spec.stdout ?? "", spec.stderr ?? "", String(spec.exit ?? 1), String(spec.fill ?? 0)]);
  context.expect(run.folder, [{ name: "the product is right", pass: false, detail: run.stdout.slice(0, 200) }]);
}
`;

/** The journeys source of the registry feature, one entry per case. */
export function registryJourneys(): string {
  const cases = Object.entries(REGISTRY_CASES)
    .map(
      ([id, spec]) => `
    ${JSON.stringify(id)}: {
      title: ${JSON.stringify(id)},
      entryPoint: "node",
      async run(context) { await failing(context, ${JSON.stringify(spec.step)}, ${JSON.stringify(spec)}); },
    },`,
    )
    .join("");
  return `${cases}
    "expected-failure": {
      title: "a command that must fail does, then the product is wrong",
      entryPoint: "pnpm install",
      async run(context) {
        const run = await context.command("expected failure", process.execPath, ["-e", "console.error(process.argv[1]); process.exit(1)", ${JSON.stringify(AFTER)}]);
        context.expect(run.folder, [{ name: "the command fails", pass: run.exitCode === 1, detail: run.stderr }]);
        const wrong = await context.command("wrong answer", process.execPath, ["-e", "0"]);
        context.expect(wrong.folder, [{ name: "the product is right", pass: false, detail: "wrong" }]);
      },
    },
    "product-fails-first": {
      title: "the product is wrong, then a later install hits an outage",
      entryPoint: "pnpm install",
      async run(context) {
        const wrong = await context.command("wrong answer", process.execPath, ["-e", "0"]);
        context.expect(wrong.folder, [{ name: "the product is right", pass: false, detail: "wrong" }]);
        await failing(context, "pnpm install", { stderr: ${JSON.stringify(AFTER)} });
      },
    },`;
}
