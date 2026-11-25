import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { gzipSync } from "node:zlib";

import { freePort } from "./free-port.ts";

const TAR_BLOCK = 512;

/** A published module release: the `peerDependencies` of its manifest and the `frontend-vue/package.json` its tarball holds, if any. */
export interface StubModuleRelease {
  peerDependencies?: Readonly<Record<string, string>>;
  frontend?: {
    peerDependencies?: Readonly<Record<string, string>>;
    engines?: Readonly<Record<string, string>>;
  };
}

/** One ustar entry: a header with the octal size and checksum `tar` reads, then the body padded to whole blocks. */
function tarFile(path: string, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(path, 0);
  header.write("0000644\0", 100);
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\u000000", 257);
  header.fill(" ", 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = (TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK;
  return Buffer.concat([header, body, Buffer.alloc(padding)]);
}

function tarball(name: string, version: string, release: StubModuleRelease) {
  const manifest = {
    name,
    version,
    peerDependencies: release.peerDependencies,
  };
  const files = [tarFile("package/package.json", JSON.stringify(manifest))];
  if (release.frontend)
    files.push(
      tarFile(
        "package/frontend-vue/package.json",
        JSON.stringify(release.frontend),
      ),
    );
  return gzipSync(Buffer.concat([...files, Buffer.alloc(2 * TAR_BLOCK)]));
}

/**
 * Serves the abbreviated packument of each package `modules` names, its `latest` dist-tag the last version listed, and
 * the tarball of each release; a 404 for anything else. Returns the registry URL, ending in `/`.
 */
export async function stubModuleRegistry(
  t: TestContext,
  modules: Readonly<
    Record<string, Readonly<Record<string, StubModuleRelease>>>
  >,
): Promise<string> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const tarballs = new Map<string, Buffer>();
  const packuments = new Map(
    Object.entries(modules).map(([name, releases]) => {
      const versions = Object.entries(releases).map(([version, release]) => {
        const path = `tarballs/${name}/-/${version}.tgz`;
        tarballs.set(path, tarball(name, version, release));
        return [
          version,
          {
            name,
            version,
            peerDependencies: release.peerDependencies,
            dist: { tarball: `${url}${path}` },
          },
        ] as const;
      });
      return [
        name,
        JSON.stringify({
          name,
          "dist-tags": { latest: versions.at(-1)?.[0] },
          versions: Object.fromEntries(versions),
        }),
      ];
    }),
  );
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url?.slice(1) ?? "");
    const archive = tarballs.get(path);
    if (archive) {
      response.writeHead(200).end(archive);
      return;
    }
    const packument = packuments.get(path);
    if (packument === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(packument);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  return url;
}
