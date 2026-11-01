import { setTimeout as sleep } from "node:timers/promises";

/** What the wait before a shot reads from the page. */
export interface ReadyPage {
  /** The URLs of the requests the page has started and not yet ended. */
  pendingRequests(): readonly string[];
  /** When a request last started or ended, as a `Date.now()` instant. */
  lastRequestAt(): number;
  /** Whether the app reports it has mounted: the DMS sets `data-dms-ready` on `<html>` once it has. */
  appReady(): Promise<boolean>;
  /** Loads the font faces the page's text uses and answers once they are ready. */
  loadFonts(): Promise<void>;
}

/** How long the wait before a shot may take, and what counts as a quiet network. */
export interface ReadyOptions {
  /** The bound on the whole wait, in milliseconds. */
  timeoutMs: number;
  /** How long no request may start or end before the network counts as quiet, in milliseconds. */
  quietMs: number;
  /** The pause between two looks at the page, in milliseconds. */
  pollMs: number;
}

interface Seen {
  quiet: boolean;
  app: boolean;
  fonts: boolean;
}

const MAX_NAMED_REQUESTS = 3;

function networkQuiet(page: ReadyPage, quietMs: number): boolean {
  return (
    page.pendingRequests().length === 0 &&
    Date.now() - page.lastRequestAt() >= quietMs
  );
}

/** Answers what `work` resolves to, or `undefined` when `deadline` comes first. */
async function within<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T | undefined> {
  const controller = new AbortController();
  const late = sleep(Math.max(0, deadline - Date.now()), undefined, {
    signal: controller.signal,
  }).catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    controller.abort();
  }
}

/** One look at the page: every signal holds, and no request started or ended while they were read. */
async function settledOnce(
  page: ReadyPage,
  options: ReadyOptions,
  deadline: number,
  seen: Seen,
): Promise<boolean> {
  seen.quiet = networkQuiet(page, options.quietMs);
  if (!seen.quiet) return false;
  const before = page.lastRequestAt();
  seen.app = (await within(page.appReady(), deadline)) === true;
  if (!seen.app) return false;
  seen.fonts =
    (await within(
      page.loadFonts().then(() => true),
      deadline,
    )) === true;
  return seen.fonts && page.lastRequestAt() === before;
}

function unsettled(page: ReadyPage, options: ReadyOptions, seen: Seen): string {
  const pending = page.pendingRequests();
  if (pending.length > 0)
    return `${pending.length} request${pending.length === 1 ? "" : "s"} still in flight: ${pending.slice(0, MAX_NAMED_REQUESTS).join(", ")}`;
  if (!seen.quiet)
    return `the network was never quiet for ${options.quietMs}ms`;
  if (!seen.app) return "the app never set data-dms-ready on <html>";
  return "the fonts were still loading";
}

/**
 * Answers once the page is ready to be shot: the app has mounted, the fonts its text uses are loaded,
 * and no request has started or ended for `quietMs`, all seen in one look. The `load` event comes
 * before the app mounts and before its modules, fonts and data arrive, so a shot at `load` catches the
 * page half way. Fails, naming what was still pending, when the page is not ready within `timeoutMs`.
 */
export async function waitForReady(
  page: ReadyPage,
  options: ReadyOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const seen: Seen = { quiet: false, app: false, fonts: false };
  while (Date.now() < deadline) {
    if (await settledOnce(page, options, deadline, seen)) return;
    await sleep(options.pollMs);
  }
  throw new Error(
    `the page did not settle within ${options.timeoutMs / 1000}s: ${unsettled(page, options, seen)}`,
  );
}
