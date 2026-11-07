import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { gzipSync } from "node:zlib";

import { freePort } from "../record.ts";

/** The package the registry serves. */
export const PACKAGE = "@acme/stale-packument";

/** The version the registry lists from the start. */
export const FIRST = "1.7.0";

/** The version `POST /publish` adds to the registry. */
export const LATER = "1.7.1";

function tarball(version: string): Buffer {
  const body = Buffer.from(
    JSON.stringify({ name: PACKAGE, version, main: "index.js" }),
  );
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

function serve(port: number): void {
  const versions = [FIRST];
  const requests: string[] = [];
  let broken = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/requests") {
      response.end(JSON.stringify(requests));
      return;
    }
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "POST" && url.pathname === "/break-tarballs") {
      broken = true;
      response.end("broken");
      return;
    }
    if (request.method === "POST" && url.pathname === "/publish") {
      versions.push(LATER);
      response.end("published");
      return;
    }
    const archive = /^\/tarballs\/(.+)\.tgz$/.exec(url.pathname);
    if (archive !== null && broken) {
      response.writeHead(500).end();
      return;
    }
    if (archive !== null && versions.includes(archive[1])) {
      response.end(tarball(archive[1]));
      return;
    }
    if (decodeURIComponent(url.pathname) === `/${PACKAGE}`) {
      const etag = `"${versions.length}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag }).end();
        return;
      }
      const origin = `http://127.0.0.1:${port}`;
      response.writeHead(200, {
        "content-type": "application/json",
        etag,
      });
      response.end(
        JSON.stringify({
          name: PACKAGE,
          "dist-tags": { latest: versions.at(-1) },
          versions: Object.fromEntries(
            versions.map((version) => [
              version,
              {
                name: PACKAGE,
                version,
                dist: { tarball: `${origin}/tarballs/${version}.tgz` },
              },
            ]),
          ),
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("ready\n");
  });
}

/**
 * Starts a registry in a child process, so a test that blocks on a spawned
 * bin still gets answers, and returns its URL. It lists `FIRST` until a
 * `POST /publish`, which adds `LATER` and changes the packument's etag.
 * `POST /break-tarballs` makes every tarball download answer 500.
 * `GET /requests` answers the JSON list of the `METHOD /path` it has served.
 */
export async function startRegistry(t: TestContext): Promise<string> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "serve", String(port)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });
  return `http://127.0.0.1:${port}`;
}

if (process.argv[2] === "serve") serve(Number(process.argv[3]));
