import { parseJson } from "../garden/json.ts";
import { tagVersion } from "../garden/npm.ts";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** How long one read of a package's dist-tags may take before it counts as failed. */
const REGISTRY_TIMEOUT_MS = 3000;

/** How many times a read that failed or timed out is made before the version counts as unreadable. */
const REGISTRY_ATTEMPTS = 2;

/** The registry npm is configured with, ending in `/`. */
export function registry(): string {
  const configured =
    process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
  if (!configured) return DEFAULT_REGISTRY;
  return configured.endsWith("/") ? configured : `${configured}/`;
}

/** The `latest` dist-tag of `name` on the {@link registry}, or `undefined` when it cannot be read within {@link REGISTRY_ATTEMPTS} reads of {@link REGISTRY_TIMEOUT_MS} each. */
export async function publishedVersion(
  name: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < REGISTRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(
        new URL(name.replace("/", "%2f"), registry()),
        {
          headers: { accept: "application/vnd.npm.install-v1+json" },
          signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        },
      );
      return response.ok
        ? tagVersion(parseJson(await response.text()), "latest")
        : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}
