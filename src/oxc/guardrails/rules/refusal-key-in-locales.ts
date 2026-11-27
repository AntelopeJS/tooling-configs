import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineRule } from "@oxlint/plugins";

import { enclosingPackage } from "../self-package.ts";
import { refusalVisitors, staticValue } from "../refusals.ts";

const REFUSAL_KEY = /^\$([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_]+)+)$/;
const LOCALE_ROOT = "frontend-vue";

type Json = string | number | boolean | null | Json[] | JsonObject;

interface JsonObject {
  [key: string]: Json;
}

/** What the locale files a module ships hold: every `i18n/locales/*.json` under its `frontend-vue` directory. */
interface Locales {
  /** Top-level keys, each the namespace a module's keys start with. */
  namespaces: Set<string>;
  /** Dotted paths that end on a sentence. */
  keys: Set<string>;
}

function localeFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const inLocales =
    basename(directory) === "locales" &&
    basename(dirname(directory)) === "i18n";
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" || entry.name.startsWith(".")
        ? []
        : localeFiles(path);
    return inLocales && entry.isFile() && entry.name.endsWith(".json")
      ? [path]
      : [];
  });
}

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: Json): value is string {
  return typeof value === "string";
}

function readLocale(file: string): Json {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function collectKeys(value: Json, path: string, keys: Set<string>): void {
  if (isText(value)) keys.add(path);
  if (!isObject(value)) return;
  for (const [segment, nested] of Object.entries(value))
    collectKeys(nested, `${path}.${segment}`, keys);
}

function packageLocales(file: string): Locales {
  const locales: Locales = { namespaces: new Set(), keys: new Set() };
  const directory = enclosingPackage(file)?.directory;
  if (directory === undefined) return locales;
  for (const locale of localeFiles(join(directory, LOCALE_ROOT)).map(
    readLocale,
  )) {
    if (!isObject(locale)) continue;
    for (const [namespace, value] of Object.entries(locale)) {
      locales.namespaces.add(namespace);
      collectKeys(value, namespace, locales.keys);
    }
  }
  return locales;
}

/** A `$<ns>.<key>` refusal the dashboard cannot find in a locale shows its raw key to the user. */
export const refusalKeyInLocalesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the $<ns>.<key> message of a 4xx refusal to have an entry in the module's locale files.",
    },
    messages: {
      missing:
        "No locale file under frontend-vue/**/i18n/locales has {{key}}, so the DMS error presenter shows the raw key. Add the sentence to the module's locale files.",
    },
  },
  createOnce(context) {
    let locales: Locales | undefined;
    const visitors = refusalVisitors(context, (message) => {
      const value = staticValue(message, context.sourceCode);
      if (value?.kind !== "text" || !value.exact) return;
      const key = REFUSAL_KEY.exec(value.text)?.[1];
      if (key === undefined) return;
      const [namespace = ""] = key.split(".");
      locales ??= packageLocales(context.filename);
      if (locales.namespaces.has(namespace) && !locales.keys.has(key))
        context.report({ node: message, messageId: "missing", data: { key } });
    });
    return {
      before() {
        locales = undefined;
      },
      ...visitors,
    };
  },
});
