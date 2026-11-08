import { existsSync, readdirSync, readFileSync } from "node:fs";

import { parseJson, type JsonValue } from "../../garden/json.ts";

/** The entries of a folder, empty when it does not exist. */
export function entries(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder) : [];
}

/** Parses the JSON file at `path`. */
export function readJson(path: string): JsonValue {
  return parseJson(readFileSync(path, "utf8"));
}
