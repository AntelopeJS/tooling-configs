/** How long one phase of `new` took, in whole milliseconds. */
export interface PhaseTiming {
  phase: string;
  ms: number;
}

/** How long one step folder of a journey lasted, in whole milliseconds. */
export interface StepTiming {
  step: string;
  ms: number;
}

/** Starts a clock; the returned function gives the whole milliseconds elapsed since. */
export function stopwatch(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

/**
 * Times the step folders of one journey: a step lasts from the `start` call
 * that names it to the next `start` call, or to `finish` for the last one.
 */
export class StepClock {
  private readonly times: StepTiming[] = [];
  private open: { step: string; elapsed: () => number } | null = null;

  /** Ends the running step, if any, and starts timing `step`. */
  start(step: string): void {
    this.close();
    this.open = { step, elapsed: stopwatch() };
  }

  /** Ends the running step and returns how long every step lasted, in the order they started. */
  finish(): StepTiming[] {
    this.close();
    return this.times;
  }

  private close(): void {
    if (this.open === null) return;
    this.times.push({ step: this.open.step, ms: this.open.elapsed() });
    this.open = null;
  }
}

/** Milliseconds as seconds with one decimal, e.g. `12.3 s`; `not measured` when there is no measurement. */
export function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined
    ? "not measured"
    : `${(ms / 1000).toFixed(1)} s`;
}
