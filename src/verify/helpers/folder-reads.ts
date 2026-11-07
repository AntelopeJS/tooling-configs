import { existsSync, readdirSync } from "node:fs";

/** The entries of a folder, empty when it does not exist. */
export function entries(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder) : [];
}
