/** What a journey's one failing command prints and how it exits; `<fill>` in `stderr` becomes `fill` repetitions of `unit`. `step` is the command: a `pnpm`, `npm`, `docker` or `ajs` step runs the fake tool of that name, any other runs `node`. */
interface RegistryCase {
  step: string;
  stdout?: string;
  stderr?: string;
  exit?: number;
  fill?: number;
  unit?: string;
  absolute?: boolean;
}

const NPM_ENOTFOUND =
  "npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\nnpm error network This is a problem related to network connectivity.";

const NPM_REQUEST =
  "npm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org";

const BUILDKIT_DNS =
  'ERROR: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22-alpine": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving';

const HUB =
  'docker: Error response from daemon: Get "https://registry-1.docker.io/v2/"';

const ECR = "123456789012.dkr.ecr.eu-west-1.amazonaws.com";

const PNPM_502 =
  " ERR_PNPM_FETCH_502  GET https://registry.npmjs.org/left-pad: Bad Gateway - 502";

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
      'ERROR: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22-alpine": toomanyrequests: too many requests',
  },
  "docker-pull-rate-limit": {
    step: "docker pull",
    stderr: `${HUB}: You have reached your unauthenticated pull rate limit.`,
  },
  "docker-5xx-with-url": {
    step: "docker pull",
    stderr: `${HUB}: received unexpected HTTP status: 503 Service Unavailable`,
  },
  "docker-name-resolution": {
    step: "docker pull",
    stderr: `${HUB}: dial tcp: lookup registry-1.docker.io: Temporary failure in name resolution`,
  },
  "docker-client-timeout": {
    step: "docker pull",
    stderr: `${HUB}: net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)`,
  },
  "docker-connection-refused": {
    step: "docker pull",
    stderr: `${HUB}: dial tcp 104.18.122.25:443: connect: connection refused`,
  },
  "docker-network-unreachable": {
    step: "docker run",
    stderr:
      'docker: Error response from daemon: Head "https://ghcr.io/v2/acme/app/manifests/1": dial tcp 140.82.112.34:443: connect: network is unreachable',
  },
  "gcr-subdomain": {
    step: "docker pull",
    stderr:
      'docker: Error response from daemon: Get "https://eu.gcr.io/v2/": dial tcp: lookup eu.gcr.io: no such host',
  },
  "buildx-failed-to-build": {
    step: "docker buildx build",
    stderr:
      'ERROR: failed to build: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/22-alpine": dial tcp: lookup registry-1.docker.io: Temporary failure in name resolution',
  },
  "compose-up": { step: "docker compose up", stderr: BUILDKIT_DNS },
  "npm-enotfound": { step: "pnpm install", stderr: NPM_ENOTFOUND },
  "npm-ci": { step: "npm ci", stderr: NPM_ENOTFOUND },
  "pnpm-add": { step: "pnpm add left-pad", stderr: NPM_ENOTFOUND },
  "ajs-module-install": {
    step: "ajs module install",
    stderr: NPM_ENOTFOUND,
  },
  "absolute-program": {
    step: "pnpm install",
    stderr: NPM_ENOTFOUND,
    absolute: true,
  },
  "npm-503": {
    step: "pnpm install",
    stderr:
      "npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/left-pad",
  },
  "pnpm-502": { step: "pnpm install", stdout: PNPM_502 },
  "pnpm-socket-hang-up": {
    step: "pnpm install",
    stdout:
      " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/typescript: request to https://registry.npmjs.org/typescript failed, reason: socket hang up",
  },
  "pnpm-econnreset": {
    step: "pnpm install",
    stdout:
      " ERR_PNPM_ECONNRESET  request to https://registry.npmjs.org/typescript failed, reason: read ECONNRESET",
  },
  "cause-in-capitals": {
    step: "pnpm install",
    stdout:
      " ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/typescript: request to https://registry.npmjs.org/typescript failed, reason: Socket Hang Up",
  },
  "ansi-colored": {
    step: "pnpm install",
    stderr:
      "\u001b[1m\u001b[31mnpm error\u001b[39m\u001b[22m network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo \u001b[1mENOTFOUND\u001b[22m registry.npmjs.org",
  },
  "status-without-host-pnpm": {
    step: "pnpm install",
    stdout: " ERR_PNPM_FETCH_503  The registry answered 503",
  },
  "status-without-host-npm": {
    step: "pnpm install",
    stderr: "npm error code E503",
  },
  "status-without-url-docker": {
    step: "docker pull",
    stderr:
      "docker: error pulling image configuration: received unexpected HTTP status: 503 Service Unavailable",
  },
  "rate-limit-without-url-docker": {
    step: "docker pull",
    stderr:
      "docker: Error response from daemon: You have reached your unauthenticated pull rate limit.",
  },
  "status-500-pnpm-localhost": {
    step: "pnpm install",
    stdout:
      " ERR_PNPM_FETCH_500  GET http://127.0.0.1:4873/left-pad: Internal Server Error - 500",
  },
  "status-500-npm-localhost": {
    step: "pnpm install",
    stderr:
      "npm error code E500\nnpm error 500 Internal Server Error - GET http://localhost:4873/left-pad",
  },
  "status-500-docker-localhost": {
    step: "docker pull",
    stderr:
      'docker: Error response from daemon: Get "http://localhost:5000/v2/": received unexpected HTTP status: 500 Internal Server Error',
  },
  "indented-npm-under-test-name": {
    step: "pnpm install",
    stdout:
      "✖ installs through the product mirror\n    npm error code E502\n    npm error 502 Bad Gateway - GET https://registry.npmjs.org/left-pad",
  },
  "indented-npm-quoted": {
    step: "pnpm install",
    stdout:
      "  npm error code E502\n  npm error 502 Bad Gateway - GET https://registry.npmjs.org/left-pad",
  },
  "ts-error-on-other-stream": {
    step: "pnpm install",
    stdout:
      "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    stderr: NPM_ENOTFOUND,
  },
  "build-failure-before-outage": {
    step: "pnpm install",
    stdout:
      "packages/app prepare: src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\npackages/app prepare: Failed\n ELIFECYCLE  Command failed with exit code 1.",
    stderr: PNPM_502,
  },
  "product-error-before-outage": {
    step: "pnpm install",
    stderr: `npm error code ELIFECYCLE\n${NPM_ENOTFOUND}`,
  },
  "pnpm-product-error-before-outage": {
    step: "pnpm install",
    stdout: ` ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  demo@1.0.0 build: tsc\n${PNPM_502}`,
  },
  "docker-process-error-before-outage": {
    step: "docker build",
    stderr: `ERROR: failed to solve: process "/bin/sh -c make" did not complete successfully: exit code: 2\n${BUILDKIT_DNS}`,
  },
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
  "missing-tag": {
    step: "docker build",
    stderr:
      "ERROR: failed to solve: docker.io/acme/missing:1.0: failed to resolve source metadata for docker.io/acme/missing:1.0: docker.io/acme/missing:1.0: not found\nError response from daemon: manifest for acme/missing:1.0 not found: manifest unknown: manifest unknown",
  },
  "product-timeout": {
    step: "npm install",
    stderr:
      "Error: i/o timeout while reading the cache at 127.0.0.1:6379; the request timeout of 30000 ms elapsed",
  },
  "recovered-retry-then-ts-error": {
    step: "pnpm install",
    stderr:
      "WARN GET https://registry.npmjs.org/typescript error (ECONNRESET). Will retry in 10 seconds. 2 retries left.\nsrc/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  },
  "mirror-test-name": {
    step: "pnpm install",
    stdout:
      "✖ falls back to the mirror when registry.npmjs.org answers 503 Service Unavailable",
  },
  "product-rate-limiter": {
    step: "npm install",
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
    step: "pnpm install",
    stderr: "npm error code ETIMEDOUT while reading src/registry.service.ts",
  },
  "pino-url-field": {
    step: "pnpm install",
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
  "proxy-refuses-registry-request": {
    step: "pnpm install",
    stderr:
      "npm error network request to https://registry.npmjs.org/left-pad failed, reason: connect ECONNREFUSED 127.0.0.1:9",
  },
  "docker-dial-loopback": {
    step: "docker pull",
    stderr: `${HUB}: dial tcp 127.0.0.1:5000: connect: connection refused`,
  },
  "request-target-is-not-registry": {
    step: "pnpm install",
    stderr:
      "npm error network request to http://proxy.acme.internal:3128/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
  },
  "scaffold-checks-output": {
    step: "pnpm install",
    stdout:
      "src/registry.service.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\n✖ falls back to the mirror when registry.npmjs.org answers 503 Service Unavailable\n  Error: getaddrinfo ENOTFOUND registry.npmjs.org\n ELIFECYCLE  Command failed with exit code 1.",
  },
  "exit-zero": { step: "pnpm install", stderr: NPM_ENOTFOUND, exit: 0 },
  "step-pnpm-test": { step: "pnpm test", stderr: NPM_ENOTFOUND },
  "step-pnpm-run-build": { step: "pnpm run build", stderr: NPM_ENOTFOUND },
  "step-pnpm-run-install": { step: "pnpm run install", stderr: NPM_ENOTFOUND },
  "step-npm-test": { step: "npm test", stderr: NPM_ENOTFOUND },
  "step-docker-exec": { step: "docker exec", stderr: BUILDKIT_DNS },
  "step-node": { step: "node build.js", stderr: NPM_ENOTFOUND },
  "oversized-line": {
    step: "pnpm install",
    stderr: `${NPM_REQUEST} <fill>`,
    fill: 2_500_000,
  },
  "oversized-product-error-after-outage": {
    step: "pnpm install",
    stderr: `${NPM_ENOTFOUND}\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL <fill>`,
    fill: 5000,
  },
  "multibyte-outage-line": {
    step: "pnpm install",
    stderr: `${NPM_REQUEST} <fill>`,
    fill: 5000,
    unit: "é",
  },
} satisfies Record<string, RegistryCase>;

/** Journeys that need more than one command. */
const EXTRA_IDS = ["expected-failure", "product-fails-first"];

/** Every journey id of the registry feature. */
export const REGISTRY_IDS = [...Object.keys(REGISTRY_CASES), ...EXTRA_IDS];

const AFTER =
  "npm error network request to https://registry.npmjs.org/left-pad failed, reason: read ECONNRESET";

/** What every fake tool and the `node` steps run: print the payload found after `skip` arguments of `process.argv`, and exit as it says. */
function printScript(skip: number): string {
  return `const [out, err, exit, fill, unit] = process.argv.slice(${skip});
process.stdout.write(out);
process.stderr.write(err.replace("<fill>", unit.repeat(Number(fill))));
process.exitCode = Number(exit);
`;
}

/** The file a fake tool runs. */
export const PRINT_FILE = printScript(2);

/** The names of the fake tools, each a script that skips its own arguments up to `--` and runs the print file on the payload after it. */
export const FAKE_TOOLS = ["pnpm", "npm", "docker", "ajs"];

export const FAKE_TOOL = `#!/bin/sh
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec node "$(dirname "$0")/print.cjs" "$@"
`;

/** Config source defining `failing(context, name, case)`, which runs one command that prints and exits as the case says and then fails a check. */
export function registryHelpers(bin: string): string {
  return String.raw`
const BIN = ${JSON.stringify(bin)};
const FAKES = ${JSON.stringify(FAKE_TOOLS)};
const PRINT = ${JSON.stringify(printScript(1))};
async function failing(context, name, spec) {
  const payload = [spec.stdout ?? "", spec.stderr ?? "", String(spec.exit ?? 1), String(spec.fill ?? 0), spec.unit ?? "a."];
  const [program, ...args] = name.split(" ");
  const run = FAKES.includes(program)
    ? await context.command(name, spec.absolute ? join(BIN, program) : program, [...args, "--", ...payload])
    : await context.command(name, process.execPath, ["-e", PRINT, ...payload]);
  context.expect(run.folder, [{ name: "the product is right", pass: false, detail: run.stdout.slice(0, 200) }]);
}
`;
}

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
