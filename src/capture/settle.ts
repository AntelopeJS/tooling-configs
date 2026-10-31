import type { Sharp } from "./browser.ts";

export interface Captured {
  scene: string;
  output: string;
  png: Buffer;
}

export async function settle(
  _sharp: Sharp,
  _root: string,
  _check: boolean,
  _captured: Captured,
): Promise<string | undefined> {
  throw new Error("not implemented");
}
