import type { GardenContext } from "./context.ts";
import {
  child,
  object,
  optStr,
  type JsonObject,
  type JsonValue,
} from "./json.ts";

export const TOOLING_PACKAGE = "@antelopejs/tooling-configs";

function distTags(packument: JsonValue): JsonObject {
  return child(object(packument, "packument"), "dist-tags");
}

export function tagVersion(
  packument: JsonValue,
  tag: string,
): string | undefined {
  return optStr(distTags(packument), tag);
}

/** The `latest` dist-tag of tooling-configs. */
export async function tooling(context: GardenContext): Promise<string> {
  const packument = await context.packument(TOOLING_PACKAGE);
  const latest =
    packument === undefined ? undefined : tagVersion(packument, "latest");
  if (latest === undefined)
    throw new Error(`${TOOLING_PACKAGE} has no latest version on npm.`);
  return latest;
}
