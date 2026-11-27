---
name: formal-billing-lease
description: TLA+ model of the renewal loop of @antelopejs/payment-subscriptions (Engine claim, act and release over one subscription record with a revision compare-and-set, the pinned attempt and its replay deadline, and a provider that deduplicates by idempotency key), checked with TLC. Use when a change touches src/engine.ts, src/transitions.ts or src/records.ts, or when a change to leases, replay protection, commits or retries needs proof that it charges no period twice and loses no payment.
---

# Formal check: renewal lease and charge

Every due renewal is charged by whichever instance claims it first. `Engine.process` claims the record with a lease (`leaseOwner`, `leaseUntil`) through a compare-and-set on `revision`, pins the attempt (method, `attemptStartedAt`, `attemptReplayUntil`), charges with the idempotency key `payment-subscriptions:<id>:<period>:<attempt>`, commits the outcome with another compare-and-set, and releases the lease. A takeover after a lease expires sends the same key again only strictly before `attemptReplayUntil`, which is `guaranteedReplayMs` after the pin. Without a replay guarantee (the default), it halts the record for reconciliation instead.

The model treats each database round trip as one step, and TLC checks every order of those steps across two instances, a crash, a provider that may decline, lose its answer or be unreachable, and ticks of the clock, within the bounds below. The promise it checks is that a paying customer is charged at most once per period and that no charge is forgotten.

- `BillingLease.tla` holds the variables, the actions and the rules. Each condition carries a `file.ts:NN` comment.
- `BillingLease.cfg` and `ReplayWindow.cfg` are the full configurations, with no replay guarantee (the default) and with one. Each has a `.ci.cfg` twin, the CI configuration.
- `BillingLease.map.mjs`, `chart-renewal.cfg` and `chart-replay.cfg` are for reading results with `/statechart`.

## Run it

From the repository root, with Node 24 and `pnpm install` done (the runner comes from `@antelopejs/tooling-configs/formal`):

```sh
node .agents/skills/formal-billing-lease/check.mjs          # CI configuration
node .agents/skills/formal-billing-lease/check.mjs --full   # full configuration
```

Java 11 or later comes from `$JAVA`, else `java` on PATH, else the `eclipse-temurin:21-jre` Docker image (set `TLC_DOCKER_PREFIX` to name the containers). The first run downloads TLC 1.7.4 into `~/.cache/antelopejs-formal` (or `$XDG_CACHE_HOME/antelopejs-formal`) and checks its SHA-256. Each run checks the default first, then the replay guarantee.

| Configuration          | Last tick | States (default, replay guarantee) | Wall time |
| ---------------------- | --------- | ---------------------------------- | --------- |
| CI (`<config>.ci.cfg`) | 4         | 931,043, 2,358,551                 | 14.3 s    |
| Full (`<config>.cfg`)  | 5         | 4,169,994, 13,265,002              | 52.3 s    |

Both configurations run two instances, one renewal, a two-tick lease, one retry after a decline and one crash. The replay guarantee is two ticks. The times are one run each in Docker Java 21 on a shared 32-core machine with a load average near 17.

- Exit 0 means every rule that held still holds, and each finding still breaks with its recorded counterexample length. No finding is recorded today.
- Exit 1 means a rule changed. `BROKEN` names a rule that held and now breaks. `CHANGED` names a finding whose shortest counterexample changed length. `HOLDS` names a finding that no longer breaks. The script keeps TLC's output in a temporary folder and prints its path. The run stops at the first configuration that changed, so a change in the default skips the replay guarantee.
- Exit 2 means TLC or Java could not run, or the arguments were wrong.

The lines that name a changed rule match `^(?:BROKEN|CHANGED|HOLDS) +(\w+)`. A rule that still holds prints as lowercase `holds`.

## When to run it

Run `--full` when a change touches a file in the coverage record below, or this folder. A changed rule (exit 1) fails the check. CI runs `node .agents/skills/formal-billing-lease/check.mjs` (job `formal-billing-lease`). The CI configuration catches every scratch break in the last section, so it is the one CI runs on every push.

## The rules

| Rule                 | Plain sentence                                                                                                                                                                                                                                                        | Harm when it breaks                                            | Default | Replay guarantee |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------- | ---------------- |
| `OneChargePerPeriod` | The provider makes at most one successful charge per subscription period.                                                                                                                                                                                             | A customer pays twice for one period.                          | holds   | holds            |
| `NoLostOutcome`      | A period the provider charged and no commit recorded stays recoverable: the record is held for reconciliation, or it keeps the pinned attempt, and the next claim either replays its key (the provider answers that success) or, past the deadline, holds the record. | The customer paid, and the subscription says past due or ends. | holds   | holds            |
| `Progress`           | A live record that is neither ended, held nor past the model's last period always has a due time, so a sweep claims it again.                                                                                                                                         | A renewal stops and nobody is told.                            | holds   | holds            |

`TypeOK` holds too. The plan's `KeyStable` rule ("every charge for one period and attempt carries one key") holds by construction: `ChargeKey` builds the key from the period and attempt of the decision (transitions.ts:74-79), and the model sends exactly that key. The plan's guess that `pinAttemptMethod` could move an attempt to a new key is wrong: the pin writes only the method and the deadline (engine.ts:202-207), and only a commit of a decline moves `attempt` (transitions.ts:172-177). A takeover decides from the record it claimed, so it charges the same period and attempt.

## No finding on campaign/integration

Every rule holds in every configuration at the sync commit. `src/test/race.test.ts` drives two of the model's paths on the real code with a second `Engine`, a manual clock and the in-memory provider: two instances racing on one renewal (one charge), and a takeover of an expired claim (the original key replayed). `pnpm run checks` runs it.

## Read every result with /statechart

Read each TLC result with the pstack `/statechart` skill. Work on a copy of `BillingLease.tla`, the map and the chart configs in a scratch folder outside the repo, since it writes its output next to its input. Use `BillingLease.map.mjs` as the view: one region for the subscription, one for the provider and one per worker. Both chart configs run one instance, since two instances pass the 500-state chart budget. `chart-renewal.cfg` (no replay guarantee; a success, a decline or a lost answer; one retry) reaches 471 states and draws 21 states and 22 arrows. `chart-replay.cfg` (a two-tick replay guarantee; a success or a lost answer) reaches 307 states and draws 17 states and 18 arrows. Every rule holds in both, `NoDeadlock` included. The view hides `Settled`, the step that changes nothing once nothing else can happen. When a change breaks a rule, run `/statechart` on `BillingLease.ci.cfg` or `ReplayWindow.ci.cfg`: above the budget it draws only the bug paths.

## Real bug or modeling error

Node runs other callbacks at every `await`, so database answers, provider answers and the next sweep can interleave in any order the model allows, and an instance can stall between any two of them. Each database write is a compare-and-set on `revision` (records.ts:108-122), and the model applies a write and hands its answer back in one step. A step order is a modeling error when the code cannot produce it, for example two writes of one instance merged into one, or a compare-and-set that succeeds on a revision the record no longer has. Replay a counterexample with `src/test/race.test.ts` as the model: `secondInstance()` builds a second `Engine`, `ManualClock` holds time still between steps, and `provider.chargesFor()` and `provider.ledger()` show every charge and replay the provider received. Call `claim`, `act`, `commit` and `release` of each instance in TLC's order, one action per step. Assert only what a customer or an operator observes: the provider's charges and the stored record. If the replay does not reproduce a finding, treat the model as wrong until you show it is not.

## Changing the model

- For an intended code change, edit the action that maps to that code, keep the `file.ts:NN` comment on each condition and update its line, then run both configurations.
- Never weaken or drop a rule to make the check pass. A new finding goes into `CONFIGS` in `check.mjs` with its counterexample length for each configuration, and into this file with its replay. A fixed finding leaves `CONFIGS` once a replay confirms the fix.
- When you change the bounds of a `.ci.cfg`, rerun the scratch changes below on it. The CI configuration must still catch each one.
- After you confirm that the model describes the code at a newer commit, move the sync commit forward. Do it only then.

## Coverage record

| Model action                             | Code                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Init`                                   | a live, active record due now, with no lease and no pinned attempt (records.ts:24-64)                                                                                           |
| `Load`, `Claim`                          | `claim`: Now(), load, the due and lease checks, the lease write (engine.ts:166-180); `act` then returns early or decides and performs (engine.ts:182-188, transitions.ts:58-72) |
| `AfterClaim`                             | `perform`'s held and expired-replay checks (engine.ts:222-228) and the fingerprint the decision keeps (transitions.ts:45-56)                                                    |
| `Pin`, `PinReply`                        | `pinAttemptMethod` (engine.ts:195-208), its lost compare-and-set throwing (lines 229-231, 153-155), and the deadline recheck (lines 233-241)                                    |
| `Charge`                                 | `charge` with `ChargeKey` (engine.ts:266-277, transitions.ts:74-79), the outcome and error mapping (engine.ts:243-263, transitions.ts:36-43)                                    |
| `CommitLoad`, `CommitWrite`              | `commit`: reload, `Apply` with its fingerprint check, `Finalize`, five writes, then the throw (engine.ts:284-305, 80-95; transitions.ts:125-225, 243-297)                       |
| `Release`, `ReleaseWrite`, `ReleaseLoad` | `release` and `releasePatch` (engine.ts:316-346)                                                                                                                                |
| `Crash`                                  | a process that dies: whatever it held is gone and its lease stays (engine.ts:153-155 for the throws that end a process the same way)                                            |
| `Tick`                                   | the clock (clock.ts:9-11)                                                                                                                                                       |
| no action                                | `sweep` and the triggers only start `process` (engine.ts:132-145, triggers.ts); `Load` is enabled whenever the record is claimable                                              |

The sync commit is `a5e40c6` on AntelopeJS/payment-subscriptions `campaign/integration`. `src/engine.ts` last changed in `b7f47ad`, `src/transitions.ts` and `src/records.ts` in `bc1ae04`.

## Bounds and what is left out

The provider keeps a key for any request sent before its first receipt of that key plus `guaranteedReplayMs`, and for no later request. That is the operator's side of the contract: `guaranteedReplayMs` is set below the provider's real retention by a margin that covers clock skew, request latency and stalls (docs/2.renewal-clock.md:63-68, README.md:112). Without that margin, a takeover that passed its deadline check and stalled on the way to the provider charges again: the `no-margin` row below. Without a replay guarantee the rules hold even though the provider deduplicates nothing, because no request ever repeats a key.

The model also leaves out:

- settlement: a pending charge, `GetPayment` and the `settle` decision (transitions.ts:62-64, 184-194).
- the other writers of the record: creation (implementation.ts:84-198), plan and method changes, and cancellation.
- refusals other than a decline (`CustomerNotFoundError` and the rest, engine.ts:36-45), which commit as a decline does.
- an outbox delivery that fails; the model always delivers it (engine.ts:317).
- two `process` calls of one instance, which share an instance id: only `releasePatch` reads it (engine.ts:341), and the `release-clears-any-lease` scratch change below shows that dropping that check breaks no rule.
- clock skew between instances, more than one subscription, and more than one renewal.

Two scratch changes break no rule, as the docs say they should not ("A lease is not an idempotency guarantee", docs/2.renewal-clock.md:66-67). `release-clears-any-lease` (`releasePatch` drops whatever lease the record holds, engine.ts:341-344) exits 0 in both configurations. `claim-ignores-lease` (`claim` takes a record a live peer still leases, engine.ts:171) exits 0 in both configurations too. The revision compare-and-set and the pinned attempt keep each period to one charge. The lease only keeps two instances from doing the same work.

## Confirm the check can fail

On a scratch copy of this folder (with `node_modules` reachable, for example a symlink beside it), apply one model edit at a time and run `check.mjs` with and without `--full`. Each edit mirrors the code change in the first column. These ran at the sync commit.

| Scratch change in the code, and the model edit                                                                                                   | CI configuration                                                                                                                                                      | Full configuration                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `drop-deadline-check`: a takeover resumes an attempt whatever its deadline (engine.ts:223): `AfterClaim` reconciles only a held record           | `BROKEN OneChargePerPeriod: Initial -> Load -> Claim -> Tick -> Pin -> Tick -> PinReply -> Charge -> Load -> Claim -> Charge`                                         | `BROKEN OneChargePerPeriod`, 11 states                                                                                            |
| `drop-recheck`: no deadline recheck after the pin (engine.ts:233-241): `PinReply` always sends                                                   | default holds; replay guarantee `BROKEN OneChargePerPeriod`, 13 states                                                                                                | replay guarantee `BROKEN OneChargePerPeriod`, 15 states                                                                           |
| `claim-without-revision`: the claim write ignores `revision` (engine.ts:173, records.ts:113-119): `Claim` always writes and keeps its stale copy | `BROKEN OneChargePerPeriod: Initial -> Load -> Load -> Claim -> Pin -> PinReply -> Charge -> Claim -> Pin -> PinReply -> Charge`                                      | same                                                                                                                              |
| `pin-without-revision`: the pin write ignores `revision` (engine.ts:203): `Pin` always writes                                                    | `BROKEN OneChargePerPeriod`, 13 states                                                                                                                                | same                                                                                                                              |
| `commit-ignores-fingerprint`: `Apply` skips its fingerprint check (transitions.ts:292): `CommitLoad` always applies                              | default holds; replay guarantee `BROKEN NoLostOutcome`, 23 states                                                                                                     | replay guarantee `BROKEN TypeOK`, 23 states: a late error re-arms a renewed record, which charges a period past the model's bound |
| `reconcile-without-flag`: the reconcile outcome clears `nextActionAt` without setting `reconciliationRequired` (transitions.ts:216-219)          | `BROKEN Progress: Initial -> Tick -> Load -> Claim -> Pin -> PinReply -> Charge -> CommitLoad -> CommitWrite`                                                         | `BROKEN Progress`, 8 states                                                                                                       |
| `no-margin`, no code change: the provider forgets a key at its first receipt plus `guaranteedReplayMs`, measured when the request arrives        | default holds; replay guarantee `BROKEN OneChargePerPeriod: Initial -> Load -> Claim -> Tick -> Pin -> PinReply -> Charge -> Tick -> Load -> Claim -> Tick -> Charge` | same                                                                                                                              |

Every scratch run in the table exited 1. With the edits dropped, both configurations exit 0.
