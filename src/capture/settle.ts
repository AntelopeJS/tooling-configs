import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { decode, encodeWebp, type Sharp } from "./browser.ts";
import { changedRatio, withinTolerance } from "./compare.ts";

export interface Captured {
  scene: string;
  output: string;
  png: Buffer;
}

/**
 * Settles one capture against the committed file. A write run creates the file, or replaces it when the
 * new capture differs by more than the tolerance, so render noise leaves the committed bytes alone. A
 * `check` run writes nothing and answers how the capture differs, or `undefined` when it is within the
 * tolerance.
 */
export async function settle(
  sharp: Sharp,
  root: string,
  check: boolean,
  captured: Captured,
): Promise<string | undefined> {
  const target = join(root, captured.output);
  const webp = await encodeWebp(sharp, captured.png);
  if (!existsSync(target)) {
    if (check)
      return `scene ${captured.scene}: ${captured.output} does not exist; run antelopejs-capture`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, webp);
    return undefined;
  }
  const ratio = changedRatio(
    await decode(sharp, readFileSync(target)),
    await decode(sharp, webp),
  );
  if (withinTolerance(ratio)) return undefined;
  if (!check) {
    writeFileSync(target, webp);
    return undefined;
  }
  return `scene ${captured.scene}: ${(ratio * 100).toFixed(2)}% of the pixels differ from ${captured.output}`;
}
