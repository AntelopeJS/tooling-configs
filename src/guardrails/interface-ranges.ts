import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { intersects, validRange } from "semver";

import { isObject, optChild, parseJson, stringValues } from "../garden/json.ts";

const INTERFACE_PREFIX = "@antelopejs/interface-";

/** A range the root `package.json` or an installed module release declares on an `@antelopejs/interface-*` package, and who declares it. */
export interface InterfaceRange {
  name: string;
  range: string;
  holder: string;
}

/** The ranges `dependencies` declares on `@antelopejs/interface-*` packages, skipping any specifier that is not a semver range. */
export function interfaceRanges(
  dependencies: ReadonlyMap<string, string>,
  holder: string,
): InterfaceRange[] {
  return [...dependencies]
    .filter(
      ([name, range]) =>
        name.startsWith(INTERFACE_PREFIX) && validRange(range) !== null,
    )
    .map(([name, range]) => ({ name, range, holder }));
}

/** The interface ranges the root `package.json` declares under each of `fields`. */
export function rootInterfaceRanges(
  root: string,
  fields: readonly string[],
): InterfaceRange[] {
  const path = join(root, "package.json");
  const manifest = existsSync(path)
    ? parseJson(readFileSync(path, "utf8"))
    : undefined;
  if (manifest === undefined || !isObject(manifest)) return [];
  return fields.flatMap((field) =>
    interfaceRanges(stringValues(optChild(manifest, field)), "package.json"),
  );
}

/** A failure line for each two ranges on the same interface that no version satisfies together. */
export function interfaceClashes(ranges: readonly InterfaceRange[]): string {
  return ranges
    .flatMap((first, index) =>
      ranges
        .slice(index + 1)
        .filter(
          (second) =>
            second.name === first.name &&
            !intersects(first.range, second.range, {
              includePrerelease: true,
            }),
        )
        .map(
          (second) =>
            `${first.name}: ${first.holder} requires "${first.range}" and ${second.holder} requires "${second.range}"; no copy satisfies both, so the project stops at boot with "Incompatible interface package resolution". Move one of them to a release whose range meets the other.\n`,
        ),
    )
    .join("");
}
