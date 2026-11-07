import { relative } from "node:path";
import type { TestEvent } from "node:test/reporters";

type Settled = Extract<TestEvent, { type: "test:pass" | "test:fail" }>;

function isSettled(event: TestEvent): event is Settled {
  return event.type === "test:pass" || event.type === "test:fail";
}

/**
 * A `node --test` reporter that writes one JSON object mapping each test file to the seconds its top-level tests took,
 * the weights `src/ci/shard.ts` balances shards by.
 */
export default async function* fileDurations(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  const seconds = new Map<string, number>();
  for await (const event of source) {
    if (!isSettled(event) || event.data.nesting !== 0 || !event.data.file)
      continue;
    const file = relative(process.cwd(), event.data.file);
    seconds.set(
      file,
      (seconds.get(file) ?? 0) + event.data.details.duration_ms / 1000,
    );
  }
  yield JSON.stringify(Object.fromEntries(seconds));
}
