import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parseDocument } from "yaml";

/** The quote a YAML file sync writes uses for a string it must quote. */
export type Quote = "'" | '"';

/** The Prettier config files sync reads, in the order Prettier searches a folder; `package.json` counts only when it has a `prettier` key. */
const CONFIG_FILES = [
  "package.json",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
] as const;

/** The quote the first Prettier config file in `folder` asks for, or `undefined` when `folder` holds none. */
function folderQuote(folder: string): Quote | undefined {
  for (const name of CONFIG_FILES) {
    const file = join(folder, name);
    if (!existsSync(file)) continue;
    const document = parseDocument(readFileSync(file, "utf8"));
    if (document.errors.length) return '"';
    const options = name === "package.json" ? ["prettier"] : [];
    if (options.length && !document.has("prettier")) continue;
    return document.getIn([...options, "singleQuote"]) === true ? "'" : '"';
  }
  return undefined;
}

/**
 * The quote Prettier keeps in a YAML file of `folder` under `root`: `'` when the nearest Prettier config between them sets
 * `singleQuote: true`, `"` otherwise, as with no config, an unreadable one, or a JavaScript config sync does not run.
 */
export function prettierQuote(root: string, folder: string): Quote {
  for (let current = join(root, folder); ; current = dirname(current)) {
    const quote = folderQuote(current);
    if (quote !== undefined) return quote;
    if (relative(root, current) === "") return '"';
  }
}
