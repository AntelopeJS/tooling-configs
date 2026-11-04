import pixelmatch from "pixelmatch";

/** The share of pixels that may differ before a capture counts as changed: 0.1%. */
export const MAX_CHANGED_RATIO = 0.001;

/** Decoded RGBA pixels, four bytes each. */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The share of pixels two images differ in, 1 when their sizes differ. */
export function changedRatio(before: RawImage, after: RawImage): number {
  if (before.width !== after.width || before.height !== after.height) return 1;
  const changed = pixelmatch(
    before.data,
    after.data,
    undefined,
    before.width,
    before.height,
    { threshold: 0.1 },
  );
  return changed / (before.width * before.height);
}

export function withinTolerance(ratio: number): boolean {
  return ratio <= MAX_CHANGED_RATIO;
}
