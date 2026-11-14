import { createServer } from "node:http";
import type { TestContext } from "node:test";

import { freePort } from "../../verify/record.ts";

const RELEASE_SUFFIX = "/latest";

/** The fields of a release manifest the registry reads of an AntelopeJS module. */
interface StubRelease {
  name: string;
  version: string;
  antelopeJs: { implements: readonly string[] };
  dependencies: Readonly<Record<string, string>>;
}

/**
 * Serves each package `latest` names its `latest` dist-tag, each package `releases` names that manifest as its
 * `latest` release, a 503 for the `latest` release of each package `failing` names, and a 404 for any other; returns
 * the registry URL, ending in `/`.
 */
export async function stubRegistry(
  t: TestContext,
  latest: Readonly<Record<string, string>>,
  releases: Readonly<Record<string, StubRelease>> = {},
  failing: readonly string[] = [],
): Promise<string> {
  const document = (
    path: string,
  ): StubRelease | { "dist-tags": { latest: string } } | undefined => {
    if (path.endsWith(RELEASE_SUFFIX)) {
      const name = path.slice(0, -RELEASE_SUFFIX.length);
      return Object.hasOwn(releases, name) ? releases[name] : undefined;
    }
    return Object.hasOwn(latest, path)
      ? { "dist-tags": { latest: latest[path] } }
      : undefined;
  };
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url?.slice(1) ?? "");
    if (failing.some((name) => path === `${name}${RELEASE_SUFFIX}`)) {
      response.writeHead(503).end();
      return;
    }
    const body = document(path);
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  });
  const port = await freePort();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${port}/`;
}

/** Points this process's registry reads at `url` until the test ends. */
export function useRegistry(t: TestContext, url: string): void {
  const saved = {
    npm_config_registry: process.env.npm_config_registry,
    NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
  };
  process.env.npm_config_registry = url;
  process.env.NPM_CONFIG_REGISTRY = url;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
