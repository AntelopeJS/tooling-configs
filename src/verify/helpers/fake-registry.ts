import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

function entry(path: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(`package/${path}`, 0);
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
  return Buffer.concat([header, body, padding]);
}

/** A gzipped tarball holding each file under `package/`, byte for byte the same on every call. */
export function archive(files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([path, content]) =>
    entry(path, content),
  );
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function tarball(version: string): Buffer {
  return archive({
    "package.json": JSON.stringify({
      name: PACKAGE,
      version,
      main: "index.js",
    }),
  });
}

type IntegrityFormat = "sha512" | "sha1" | "sha1 sha512";

function hash(algorithm: "sha512" | "sha1", version: string): string {
  return `${algorithm}-${createHash(algorithm).update(tarball(version)).digest("base64")}`;
}

function integrity(
  version: string,
  lying: boolean,
  format: IntegrityFormat,
): string {
  if (lying) return `sha512-${"A".repeat(86)}==`;
  if (format === "sha1") return hash("sha1", version);
  if (format === "sha1 sha512")
    return `${hash("sha1", version)} ${hash("sha512", version)}`;
  return hash("sha512", version);
}

function serve(port: number): void {
  const versions = [FIRST];
  const requests: string[] = [];
  let tarballs: "served" | "broken" | "hung" = "served";
  let lying = false;
  let format: IntegrityFormat = "sha512";
  const controls = new Map<string, () => void>([
    ["/break-tarballs", () => (tarballs = "broken")],
    ["/hang-tarballs", () => (tarballs = "hung")],
    ["/lie-about-integrity", () => (lying = true)],
    ["/integrity-sha1", () => (format = "sha1")],
    ["/integrity-sha1-sha512", () => (format = "sha1 sha512")],
    ["/publish", () => versions.push(LATER)],
  ]);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/requests") {
      response.end(JSON.stringify(requests));
      return;
    }
    requests.push(`${request.method} ${url.pathname}`);
    const control =
      request.method === "POST" ? controls.get(url.pathname) : undefined;
    if (control !== undefined) {
      control();
      response.end(url.pathname);
      return;
    }
    const download = /^\/tarballs\/(.+)\.tgz$/.exec(url.pathname);
    if (download !== null && tarballs === "broken") {
      response.writeHead(500).end();
      return;
    }
    if (download !== null && tarballs === "hung") return;
    if (download !== null && versions.includes(download[1])) {
      response.end(tarball(download[1]));
      return;
    }
    if (decodeURIComponent(url.pathname) === `/${PACKAGE}`) {
      const etag = `"${versions.length}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag }).end();
        return;
      }
      const abbreviated = String(request.headers.accept).startsWith(
        "application/vnd.npm.install-v1+json",
      );
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
                dist: {
                  tarball: `${origin}/tarballs/${version}.tgz`,
                  integrity: integrity(version, lying && !abbreviated, format),
                },
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
 * `POST /break-tarballs` makes every tarball download answer 500 and
 * `POST /hang-tarballs` makes it never answer. `POST /integrity-sha1` and
 * `POST /integrity-sha1-sha512` make `dist.integrity` a sha1 hash alone, or a
 * sha1 hash followed by the sha512 one. Every version lists the
 * `dist.integrity` of its tarball. After `POST /lie-about-integrity` the full
 * document, which `npm view` reads, lists one that no tarball has, while the
 * install document, which `npm pack` reads, stays true.
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
