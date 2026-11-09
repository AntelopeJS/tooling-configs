import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { VerifyContext } from "./context.ts";
import { httpRecorded, readOutput, type BackgroundHandle } from "./record.ts";
import type { App, Check } from "./types.ts";

const READY_TIMEOUT_MS = 120_000;
/** The longest wait between readiness probes. */
const POLL_MS = 250;
/** The wait between readiness probes in the first `FAST_POLL_WINDOW_MS`, where most apps come up: an app ready in 300 ms is seen within 25 ms of it instead of at the 500 ms tick. */
const FAST_POLL_MS = 25;
/** How long readiness is probed every `FAST_POLL_MS` before falling back to `POLL_MS`. */
const FAST_POLL_WINDOW_MS = 3000;
const SETTLE_MS = 3000;

async function probe(
  context: VerifyContext,
  app: App,
  fixture: boolean,
  folder: string,
): Promise<Check> {
  const probe = context.workspace.config.template?.probe;
  if (!fixture && probe?.log) {
    const output = readOutput(app.folder);
    return {
      name: `dev output matches ${probe.log}`,
      pass: probe.log.test(`${output.stdout}${output.stderr}`),
      detail: output.stderr.slice(-300),
    };
  }
  const path = fixture ? "/health" : (probe?.path ?? "/");
  const answer = await httpRecorded(
    folder,
    `http://127.0.0.1:${app.port}${path}`,
  );
  const status = fixture ? 200 : (probe?.status ?? 200);
  const body = !fixture && probe?.body ? probe.body : /./s;
  return {
    name: `GET ${path} answers ${status} with ${body}`,
    pass: answer.status === status && body.test(answer.body),
    detail:
      answer.error ??
      `status ${answer.status}, body ${answer.body.slice(0, 300)}`,
  };
}

/** Probes a started app in a new `ready` step until it answers, exits or times out, and aborts the journey unless it came up and stayed up. */
export async function waitReady(
  context: VerifyContext,
  app: App,
  handle: BackgroundHandle,
  fixture: boolean,
): Promise<void> {
  const folder = context.step("ready");
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let exited = false;
  void handle.exited.then(() => {
    exited = true;
  });
  const fastUntil = Date.now() + FAST_POLL_WINDOW_MS;
  let check = await probe(context, app, fixture, folder);
  while (!check.pass && !exited && Date.now() < deadline) {
    await sleep(Date.now() < fastUntil ? FAST_POLL_MS : POLL_MS);
    check = await probe(context, app, fixture, folder);
  }
  const settle = context.workspace.config.template?.probe.log
    ? (context.workspace.config.template.probe.settleMs ?? SETTLE_MS)
    : 0;
  if (check.pass && settle > 0) await sleep(settle);
  const alive = {
    name: "still running after readiness",
    pass: !exited,
    detail: `waited ${settle} ms`,
  };
  writeFileSync(
    join(folder, "ready.txt"),
    `${check.pass && !exited ? "ready" : exited ? "exited before ready" : "timed out"}\n`,
  );
  context.expect(folder, check.pass ? [check, alive] : [check], {
    critical: true,
  });
}
