import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("install-vale.sh", import.meta.url));
const WINDOWS = process.platform === "win32";
const BINARY = WINDOWS ? "vale.exe" : "vale";

function runStub(path) {
  return WINDOWS
    ? execFileSync("bash", [path], { encoding: "utf8" })
    : execFileSync(path, { encoding: "utf8" });
}

function archive(t) {
  const root = mkdtempSync(join(tmpdir(), "install-vale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, BINARY), "#!/bin/sh\necho stub-vale\n");
  chmodSync(join(root, BINARY), 0o755);
  const body = execFileSync(
    "tar",
    ["--create", "--gzip", "--file", "-", BINARY],
    { cwd: root },
  );
  return {
    root,
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function serve(t, statuses, body) {
  const seen = [];
  const server = createServer((_request, response) => {
    const status = statuses[Math.min(seen.length, statuses.length - 1)];
    seen.push(status);
    response.writeHead(status);
    response.end(status === 200 ? body : "gateway timeout");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/vale.tar.gz`, seen };
}

async function install(root, url, sha256) {
  const target = join(root, "bin");
  try {
    const { stdout } = await promisify(execFile)("bash", [SCRIPT, target], {
      env: {
        ...process.env,
        VALE_DOWNLOAD_URL: url,
        VALE_DOWNLOAD_SHA256: sha256,
        VALE_RETRY_DELAY: "1",
      },
    });
    return { code: 0, stdout, target };
  } catch (error) {
    return { code: error.code, stderr: error.stderr, target };
  }
}

it("retries a 504 and installs Vale from the next 200", async (t) => {
  const { root, body, sha256 } = archive(t);
  const { url, seen } = await serve(t, [504, 200], body);
  const run = await install(root, url, sha256);
  assert.deepEqual(seen, [504, 200]);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `${run.target}/${BINARY}\n`);
  assert.equal(runStub(run.stdout.trim()), "stub-vale\n");
});

it("exits non-zero and names the HTTP status when every attempt fails", async (t) => {
  const { root, body, sha256 } = archive(t);
  const { url, seen } = await serve(t, [504], body);
  const run = await install(root, url, sha256);
  assert.equal(seen.length, 6);
  assert.notEqual(run.code, 0);
  assert.match(
    run.stderr,
    /Vale download failed::HTTP 504 \(curl exit 22\) from /,
  );
});
