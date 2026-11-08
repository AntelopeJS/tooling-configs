import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { readJson } from "./helpers/folder-reads.ts";
import { freePort, httpRecorded } from "./record.ts";

const ECHOED = ["authorization", "content-type", "if-none-match"];

/** A loopback server that answers with the echoed request headers, one per line, and sets `etag` on its answer. */
async function echoServer(t: TestContext): Promise<string> {
  const server = createServer((request, response) => {
    response.setHeader("etag", '"v1"');
    response.end(
      ECHOED.map((name) => `${name}: ${request.headers[name]}`).join("\n"),
    );
  });
  const port = await freePort();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${port}/`;
}

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "record-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a request sends the headers the journey gives, over the JSON content type a body defaults to", async (t) => {
  const url = await echoServer(t);
  const result = await httpRecorded(folder(t), url, {
    method: "PUT",
    body: "raw",
    headers: {
      Authorization: "Bearer token",
      "Content-Type": "text/plain",
      "If-None-Match": "*",
    },
  });
  assert.equal(
    result.body,
    "authorization: Bearer token\ncontent-type: text/plain\nif-none-match: *",
  );
});

test("a body sent without headers still goes as JSON", async (t) => {
  const url = await echoServer(t);
  const result = await httpRecorded(folder(t), url, {
    method: "POST",
    body: "{}",
  });
  assert.equal(
    result.body,
    "authorization: undefined\ncontent-type: application/json\nif-none-match: undefined",
  );
});

test("the result and http.json record the request headers and the response headers", async (t) => {
  const url = await echoServer(t);
  const dir = folder(t);
  const result = await httpRecorded(dir, url, {
    headers: { "x-amz-meta-owner": "journey" },
  });
  assert.equal(result.headers["etag"], '"v1"');
  assert.partialDeepStrictEqual(readJson(join(dir, "http.json")), {
    request: { headers: { "x-amz-meta-owner": "journey" } },
    response: { headers: { etag: '"v1"' } },
  });
});
