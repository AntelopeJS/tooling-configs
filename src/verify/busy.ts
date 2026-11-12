const BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const BUSY_WINDOW_MS = 5_000;
const BUSY_STEP_MS = 5;

/** Blocks this thread for `ms` milliseconds. */
export function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs a file operation that replaces or reads a file another process may
 * replace at the same moment. Windows refuses such an operation with EPERM,
 * EBUSY or EACCES while the other side holds the file, where POSIX never
 * does, so on Windows the operation is retried for a few seconds before its
 * error is thrown. Elsewhere it runs once.
 */
export function retryBusy<T>(operation: () => T): T {
  if (process.platform !== "win32") return operation();
  const deadline = Date.now() + BUSY_WINDOW_MS;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      if (!BUSY_CODES.has(code) || Date.now() >= deadline) throw error;
      pauseSync(BUSY_STEP_MS);
    }
  }
}
