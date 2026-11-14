import { createServer } from "node:http";
import type { TestContext } from "node:test";

import { freePort } from "../../verify/record.ts";

/** Serves each package `latest` names its `latest` dist-tag, and a 404 for any other; returns the registry URL, ending in `/`. */
export async function stubRegistry(
  t: TestContext,
  latest: Readonly<Record<string, string>>,
): Promise<string> {
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url?.slice(1) ?? "");
    const version = Object.hasOwn(latest, name) ? latest[name] : undefined;
    if (version === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ "dist-tags": { latest: version } }));
  });
  const port = await freePort();
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
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
