import { num, object, parseJson } from "../garden/json.ts";

/** Seconds each test file took in CI, keyed by repository-relative path. */
export type TestWeights = Readonly<Record<string, number>>;

/** `node --test` reads each path as a glob, and the shard step splits its list on whitespace. */
const GLOB_OR_SPACE = /[[\]*?{}\\\s]/u;

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function byWeightThenPath(
  a: { file: string; weight: number },
  b: { file: string; weight: number },
): number {
  return b.weight - a.weight || a.file.localeCompare(b.file, "en");
}

/** Parses the committed weights file. */
export function parseWeights(text: string, source: string): TestWeights {
  const data = object(parseJson(text), source);
  return Object.fromEntries(
    Object.keys(data).map((key) => [key, num(data, key)]),
  );
}

/** The per-file mean over several measurements, sorted by path so the committed file diffs cleanly. */
export function meanWeights(
  measurements: readonly TestWeights[],
): Record<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const measurement of measurements)
    for (const [file, seconds] of Object.entries(measurement)) {
      const sum = sums.get(file) ?? { total: 0, count: 0 };
      sums.set(file, { total: sum.total + seconds, count: sum.count + 1 });
    }
  return Object.fromEntries(
    [...sums]
      .toSorted(([a], [b]) => a.localeCompare(b, "en"))
      .map(([file, { total, count }]) => [
        file,
        Math.round((total / count) * 10) / 10,
      ]),
  );
}

/**
 * Longest-processing-time-first assignment: files go by descending weight, then path, each to the least loaded
 * shard, the lowest index on a tie. A file without a weight counts as the median of the known weights, so a new
 * test file lands somewhere sensible before the weights are refreshed. Every shard computes the same result from
 * the same inputs.
 */
export function assignShards(
  files: readonly string[],
  weights: TestWeights,
  total: number,
): string[][] {
  const known = Object.values(weights);
  const fallback = known.length ? median(known) : 1;
  const shards: string[][] = Array.from({ length: total }, () => []);
  const loads: number[] = Array.from({ length: total }, () => 0);
  const weighted = files.map((file) => ({
    file,
    weight: Object.hasOwn(weights, file) ? weights[file]! : fallback,
  }));
  for (const { file, weight } of weighted.toSorted(byWeightThenPath)) {
    const target = loads.indexOf(Math.min(...loads));
    shards[target]!.push(file);
    loads[target]! += weight;
  }
  return shards;
}

/**
 * The files shard `shard` of `total` runs; `node --test` sorts them by path before it starts any. Throws when a path
 * would break `node --test` or the shard is empty.
 */
export function shardFiles(
  files: readonly string[],
  weights: TestWeights,
  shard: number,
  total: number,
): string[] {
  if (
    !Number.isInteger(shard) ||
    !Number.isInteger(total) ||
    shard < 1 ||
    shard > total
  )
    throw new Error(`shard ${shard} of ${total} is not a valid shard`);
  const odd = files.filter((file) => GLOB_OR_SPACE.test(file));
  if (odd.length)
    throw new Error(
      `node --test reads each path as a glob; rename these test files: ${odd.join(" ")}`,
    );
  const mine = assignShards(files, weights, total)[shard - 1]!;
  if (!mine.length) throw new Error(`shard ${shard} runs no test file`);
  return mine;
}
