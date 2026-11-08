import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { probeTarget, registryFault, type Target } from "./registry.ts";
import type { StepRecord } from "./results.ts";

interface StepFiles {
  name: string;
  command: string;
  exit: string;
  stdout?: string;
  stderr?: string;
  pass?: boolean;
}

const NPM_ENOTFOUND = [
  "npm error code ENOTFOUND",
  "npm error syscall getaddrinfo",
  "npm error network request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
].join("\n");

const BUILDKIT_DNS =
  'ERROR: failed to solve: node:20: failed to do request: Head "https://registry-1.docker.io/v2/library/node/manifests/20": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: no such host';

function evidenceOf(t: TestContext, steps: StepFiles[]) {
  const root = mkdtempSync(join(tmpdir(), "verify-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records: StepRecord[] = steps.map((step, index) => {
    const folder = `feature/journey/0${index + 1}-${step.name}`;
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(
      join(root, folder, "command.txt"),
      `cd /work\n${step.command}\n`,
    );
    writeFileSync(join(root, folder, "exit-code.txt"), `${step.exit}\n`);
    writeFileSync(join(root, folder, "stdout.txt"), step.stdout ?? "");
    writeFileSync(join(root, folder, "stderr.txt"), step.stderr ?? "");
    return {
      name: step.name,
      folder,
      checks: [{ name: "it succeeds", pass: step.pass ?? false, detail: "" }],
    };
  });
  return { root, records };
}

/** A probe that answers for the hosts in `up` and records every target it was asked about. */
function fakeProbe(up: string[] = []) {
  const asked: Target[] = [];
  const probe = (target: Target) => {
    asked.push(target);
    return Promise.resolve(
      up.includes(target.host)
        ? null
        : `DNS lookup of ${target.host} failed: ENOTFOUND`,
    );
  };
  return { asked, probe };
}

async function faultOf(t: TestContext, steps: StepFiles[], up: string[] = []) {
  const { root, records } = evidenceOf(t, steps);
  const { asked, probe } = fakeProbe(up);
  return { fault: await registryFault(root, records, probe), asked };
}

test("an install whose failed request went to a registry that also fails the probe is NOT VERIFIED and names the step and the probe failure (catches a harness that never softens an outage)", async (t) => {
  const { fault } = await faultOf(t, [
    {
      name: "install",
      command: "pnpm install",
      exit: "1",
      stderr: NPM_ENOTFOUND,
    },
  ]);
  assert.equal(
    fault,
    "step install could not reach a container or package registry, which also fails a fresh probe now, an outage outside the code under test: DNS lookup of registry.npmjs.org failed: ENOTFOUND",
  );
});

test("the same outage output is FAIL when the registry answers the probe (catches deciding the outage from the output text alone)", async (t) => {
  const { fault, asked } = await faultOf(
    t,
    [
      {
        name: "install",
        command: "pnpm install",
        exit: "1",
        stderr: NPM_ENOTFOUND,
      },
    ],
    ["registry.npmjs.org"],
  );
  assert.equal(fault, null);
  assert.deepEqual(asked, [{ host: "registry.npmjs.org", port: 443 }]);
});

test("the probe asks every registry host the failing requests named, once each, on the named port (catches probing a fixed host or only the first target)", async (t) => {
  const { fault, asked } = await faultOf(t, [
    {
      name: "image",
      command: "docker buildx build -t demo .",
      exit: "1",
      stderr: `${BUILDKIT_DNS}\nERROR: dial tcp ghcr.io:80: i/o timeout`,
    },
  ]);
  assert.match(fault ?? "", /^step image could not reach/);
  assert.deepEqual(asked, [
    { host: "registry-1.docker.io", port: 443 },
    { host: "ghcr.io", port: 80 },
  ]);
});

test("one named registry that answers the probe keeps the journey FAIL (catches NOT VERIFIED when only some targets fail)", async (t) => {
  const { fault } = await faultOf(
    t,
    [
      {
        name: "image",
        command: "docker pull node:20",
        exit: "1",
        stderr: `${BUILDKIT_DNS}\nError response from daemon: Get "https://ghcr.io/v2/": net/http: TLS handshake timeout`,
      },
    ],
    ["ghcr.io"],
  );
  assert.equal(fault, null);
});

test("a failing request to anything but a known public registry on port 80 or 443 is FAIL without a probe (catches dropping the registry allowlist)", async (t) => {
  for (const line of [
    "request to https://registry.npmjs.org/x failed, reason: connect ECONNREFUSED 127.0.0.1:9",
    " ERR_PNPM_META_FETCH_FAIL  GET http://localhost:4873/left-pad: request to http://localhost:4873/left-pad failed, reason: connect ECONNREFUSED",
    "npm error network request to https://npm.internal.example/x failed, reason: getaddrinfo ENOTFOUND npm.internal.example",
    "npm error network request to https://registry.npmjs.org:4873/x failed, reason: socket hang up",
    "ERROR: dial tcp 203.0.113.7:443: connect: connection refused",
  ]) {
    const { fault, asked } = await faultOf(t, [
      {
        name: "install",
        command: "pnpm install",
        exit: "1",
        stderr: `${NPM_ENOTFOUND}\n${line}`,
      },
    ]);
    assert.equal(fault, null, line);
    assert.deepEqual(asked, [], line);
  }
});

test("a step that does not fetch dependencies or images is FAIL without a probe, whatever its output (catches dropping the program gate)", async (t) => {
  for (const command of [
    "pnpm test",
    "pnpm run install",
    "docker run demo",
    "docker exec demo npm install",
    "sh -c 'pnpm install'",
    "pnpm -r install",
  ]) {
    const { fault, asked } = await faultOf(t, [
      { name: "step", command, exit: "1", stderr: NPM_ENOTFOUND },
    ]);
    assert.equal(fault, null, command);
    assert.deepEqual(asked, [], command);
  }
});

test("each fetching command, behind an env prefix or an absolute path or run as node on the core entry, reaches the probe (catches a gate that misses a fetching program)", async (t) => {
  for (const command of [
    "CI=1 /usr/bin/pnpm install --frozen-lockfile",
    "npm ci",
    "docker compose pull",
    "node /work/node_modules/@antelopejs/core/dist/cli.js module install",
    "'/opt/ajs bin/ajs' project init demo",
  ]) {
    const { fault } = await faultOf(t, [
      { name: "fetch", command, exit: "1", stdout: NPM_ENOTFOUND },
    ]);
    assert.match(fault ?? "", /^step fetch could not reach/, command);
  }
});

test("a fetch that exited 0, an earlier failing step, or output that names no target is FAIL without a probe (catches reading any step or any cause)", async (t) => {
  const cases: StepFiles[][] = [
    [
      {
        name: "install",
        command: "pnpm install",
        exit: "0",
        stderr: NPM_ENOTFOUND,
      },
    ],
    [
      {
        name: "build",
        command: "pnpm run build",
        exit: "1",
        stderr: "error TS2322",
      },
      {
        name: "install",
        command: "pnpm install",
        exit: "1",
        stderr: NPM_ENOTFOUND,
      },
    ],
    [
      {
        name: "install",
        command: "pnpm install",
        exit: "1",
        stderr: "npm error code ENOTFOUND",
      },
    ],
    [
      {
        name: "install",
        command: "pnpm install",
        exit: "1",
        stderr:
          "npm error code E503\nnpm error 503 Service Unavailable - GET https://registry.npmjs.org/x",
      },
    ],
  ];
  for (const steps of cases) {
    const { fault, asked } = await faultOf(t, steps);
    assert.equal(fault, null, steps.at(-1)?.stderr);
    assert.deepEqual(asked, [], steps.at(-1)?.stderr);
  }
});

test("the probe reports a listening port as reachable, and a refused port or an unresolvable host as a failure (catches a probe that always fails and so softens every failure)", async (t) => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address !== null && address instanceof Object);
  assert.equal(
    await probeTarget({ host: "localhost", port: address.port }),
    null,
  );
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedAddress = closed.address();
  assert.ok(closedAddress !== null && closedAddress instanceof Object);
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  assert.match(
    (await probeTarget({ host: "127.0.0.1", port: closedAddress.port })) ?? "",
    /^TCP connect to 127\.0\.0\.1 port \d+ failed on all 1 addresses: ECONNREFUSED$/,
  );
  assert.match(
    (await probeTarget({ host: "registry.invalid", port: 443 })) ?? "",
    /^DNS lookup of registry\.invalid failed: /,
  );
});
