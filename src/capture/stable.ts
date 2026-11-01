import { setTimeout as sleep } from "node:timers/promises";

/** How a scene waits for the page to stop changing before the shot counts. */
export interface StableOptions {
  /** How many shots in a row must be byte for byte the same. */
  stableShots: number;
  /** How many shots to take before giving up. */
  maxShots: number;
  /** The pause between two shots, in milliseconds. */
  pauseMs: number;
}

/**
 * Shoots until `stableShots` shots in a row are identical, then answers that shot. A page that loads
 * its fonts, scripts and data after the `load` event looks different until it has finished, so a
 * single shot can catch it half way. Fails when the page is still changing after `maxShots` shots.
 */
export async function stableShot(
  shoot: () => Promise<Buffer>,
  options: StableOptions,
): Promise<Buffer> {
  let last: Buffer | undefined;
  let same = 0;
  for (let taken = 1; taken <= options.maxShots; taken++) {
    const shot = await shoot();
    same = last?.equals(shot) ? same + 1 : 1;
    if (same >= options.stableShots) return shot;
    last = shot;
    await sleep(options.pauseMs);
  }
  throw new Error(
    `the page did not stop changing after ${options.maxShots} shots`,
  );
}
