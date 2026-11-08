# UP-01 / FX03: scheduler computation containment

Source delivery only. No checks executed and no Mac acceptance. No push or PR.

## Identity and consumed revisions

- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/finish-scheduler-up01`
- Branch: `desktop/finish-scheduler-up01`
- Starting base verified clean: `8297fe6404caa114dcb0c2cd6006291a8abb2038` (frozen `desktop/finish-cloud-base-20261106-8297fe64`).
- Implementation commit: `f301ade151769fed4da8911185b14c4df9f77ff6`.
- This document is committed separately after implementation. Its commit is the delivery tip; obtain it with `git rev-parse HEAD`. The final response records the actual tip without a self-referential document hash.
- Original public reference: `2a57fa6dd53311f763bfc9abde85997b7f7e5309`.
- Supplement: `ab3def9bfcf545cc9548f99c63c2b011ca094023`.
- No unfinished cloud contracts or RD37/RD38 packages consumed. No rebase/cherry-pick or changes to integration `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08`.

## Original mapping and classification

At original `2a57fa6…`, `apps/engine/src/schedules/cron.ts` directly constructs Cron and calls nextRun from `isDue` and `nextRunAt`. The supplement's same file adds `isValidTimezone` by actual computation and a catch around next-run computation. This package follows that design, moving the reusable computation boundary into a dedicated owned helper rather than rewriting the scheduler.

Original/current `apps/engine/src/runtime/scheduler.ts`, `tick`, already walks schedules in order and calls `isDue`. At this base a thrown computation escapes that walk; containing `isDue` is sufficient for this specific failure. The runtime tick file is untouched.

Existing Mac `apps/engine/src/desktop/schedule-tools/lifecycle.ts`, `assertTiming`, checked timezone through Intl and cron through construction only. Existing `schedules/loader.ts`, `writeSchedule` and `updateScheduleAt`, already owns merged-definition writes and file locks. These are the real engine storage adapters used by `apps/engine/src/http/routes/schedules.ts` and then by `apps/ui/lib/desktop/server/schedules/api.ts`. Their constructor-only route checks are not the authoritative final guard.

Already implemented: scoped schedule grants, owner checks, live admission, intent reservation/recovery, atomic writes, same-request receipts, model selection and Stop lifecycle. New here: per-routine safe cron computation and compute validation immediately before these existing writers. Root verification: all execution, API error presentation, timezone/ICU behavior and installed scheduler QA. No new product or credential policy is introduced.

Read evidence: the three `codex-Rerun-*` audit/checklist/source-evidence documents under `rerun-next-batch-20261106`, plus finish `CHECKLIST.md`, `COORDINATION.md`, and `WORKTREE-MANIFEST.md`. They identify UP-01/FX03; they are not execution/acceptance evidence.

## Changed paths

- `apps/engine/src/schedules/next-run.ts` (new production helper)
- `apps/engine/src/schedules/next-run.test.ts` (new unrun regressions)
- `apps/engine/src/schedules/cron.ts` (existing public helper delegates computation)
- `apps/engine/src/schedules/loader.ts` (validate merged state inside existing write locks)
- `apps/engine/src/schedules/loader.test.ts` (unrun writer regressions)
- `apps/engine/src/desktop/schedule-tools/lifecycle.ts` (compute-based validation before intent reservation)
- `apps/engine/src/desktop/schedule-tools/lifecycle.test.ts` (unrun lifecycle regressions)
- `docs/desktop-finish-scheduler-up01-handoff.md`

## Public helper signatures

Direct engine imports; no contract barrel or dependency changes:

```ts
export type CronTiming = { cron: string; timezone: string | null }
export type CronComputation = { ok: true; next: Date | null } | { ok: false }
export function computeNextRun(timing: CronTiming, from: Date): CronComputation
export function nextCronRun(timing: CronTiming, from: Date): Date | null
export function isValidTimezone(timezone: string): boolean
export class ScheduleTimingError extends Error {
    readonly field: 'cron' | 'timezone'
}
export function assertComputableTiming(
    timing: { cron: string | null; timezone: string | null }, from: Date,
): void
```

`ok: true, next: null` means no future occurrence, not malformed timing. `ok: false` means construction/computation failed or its input/output date is invalid. Runtime projection collapses that failure to no next run, matching the original supplement. Validation preserves the distinction and refuses failures. No thrown raw decoder errors or new logs are exposed.

UTC and supported IANA/platform timezone aliases are tested by Cron computation using a fixed reference instant. Actual schedule computation uses the supplied clock/baseline and selected zone. Null timezone retains the existing runtime default rather than silently converting legacy routines to UTC. No timezone rewriting, mutation or disabling occurs on reads.

## Concrete bindings and root activation

Chosen delivery is the **owned helper implementation**, with narrow existing helper/writer bindings. It is not an alternative full tick patch. All listed bindings are already in the implementation commit. Root applies the owned commits to its aggregate source; do not install a second scheduler.

`apps/engine/src/schedules/cron.ts`, both `isDue` and `nextRunAt`, imports:

```ts
import { nextCronRun } from './next-run.js'
```

The one-line tick computation binding inside `isDue` is:

```ts
const next = nextCronRun({ cron: schedule.cron, timezone: schedule.timezone }, baseline ? new Date(baseline) : now)
```

The existing central `runtime/scheduler.ts::tick` remains:

```ts
if (isDue(schedule, now)) void fire(agentId, schedule, assertActive)
```

No new central import/mount is required for that existing call.

`apps/engine/src/schedules/loader.ts`, `writeSchedule` and `updateScheduleAt`, imports and calls the following after constructing the merged `next`, inside the same existing lock and before writing:

```ts
import { assertComputableTiming } from './next-run.js'
```

```ts
assertComputableTiming(next, new Date())
```

The desktop tool lifecycle passes its injected `now()` into `computeNextRun` and keeps the existing `M.invalidCron` / `M.invalidTimezone` refusals. It validates before new intent reservation. Committed receipt replay and pending-intent reconciliation are unchanged; this package never retries a run/effect or rewrites previously committed receipts.

### Root-owned HTTP/UI presentation fragments

Storage now refuses invalid writes even if preflight misses them. Root should map the typed storage refusal to HTTP 400 instead of a generic server error in `apps/engine/src/http/routes/schedules.ts`, both POST write and PATCH update. Import:

```ts
import { ScheduleTimingError } from '../../schedules/next-run.js'
```

Wrap each existing write call and response in its existing handler, preserving authorization and all other failures. For POST:

```ts
try {
    const schedule = await writeSchedule(agentId, body)
    return c.json(schedule, 201)
} catch (error) {
    if (error instanceof ScheduleTimingError) return c.json({ error: error.message }, 400)
    throw error
}
```

For PATCH use `await updateScheduleAt(agentId, slug, body)` and its existing `return c.json(schedule)` in the same pattern. Do not move the write outside its canonical lock or accept a partial-patch timezone as the whole definition.

In root-owned `apps/ui/lib/desktop/server/schedules/api.ts::input.superRefine`, change only its constructor preflight expression to compute too:

```ts
if (value.cron) new Cron(value.cron, { timezone: value.timezone }).nextRun()
```

Keep the existing Intl, mutually exclusive timing, schema validation, error copy, secure loopback, request receipt and cancellation boundaries. This UI/server preflight is optional early feedback, not another engine authority. No UI next-run mirror is changed by this package. No migration, grant, registration, packaging, UI mount or schema export is required.

## Behavior / recovery matrix

| Scope | Source behavior | Remaining dependency or limit |
| --- | --- | --- |
| Bad saved cron/timezone | `isDue` false and next-run null, following rows evaluated | Root scheduler execution QA |
| Deferred Cron throw / invalid baseline | Contained inside computation | Other scheduler exceptions are outside this package |
| Valid recurring routine | Same cron expression, zone, baseline and ordering | Root ICU/DST execution |
| Disabled / spent one-shot | Existing semantics retained | No new one-shot policy |
| No future occurrence | Valid computation with null next | Not falsely rejected as invalid cron |
| Desktop tools create/update/edit | Compute before new intent reservation | Existing authority/custody remains required |
| Desktop UI via engine writer | Merged state validated before publication | Root 400 mapping and preflight fragments above |
| Failed write validation | Existing file remains intact | Invalid legacy files must be corrected or removed to edit through these writers |
| Restart/lost ACK/Stop | Existing durable schedule intents and atomic writer behavior unchanged | No migration/replay or new outcome authority |

## Authored, unrun regressions

- Malformed cron, bad timezone and invalid prior baseline ahead of a healthy due row; array order and saved values preserved.
- Deferred Cron computation failure contained while the next routine remains evaluable.
- Spring/autumn New York daily 09:00 UTC offsets, UTC/platform zone validation and invalid evaluation dates.
- Disabled and spent one-shot compatibility; valid exhausted computation distinguished from failure.
- Actual loader rejects bad new definitions before any schedule file or creation notice; merged update and overwrite reject while retaining exact prior bytes/Markdown.
- Desktop lifecycle injected computation failure refuses before reservation/write/notice; failed update preserves the exact saved definition and write count.

These are regression sources, not successful execution evidence. Existing test harnesses use temporary directories/in-memory fixtures only when root runs them. No fixture or application code was executed here.

## Limits, risks and verification

No tests, typecheck, lint, formatter, build, dependency install, fixture, provider/network request, UI, DB live operation, listener, restart, guest/Docker, account or Keychain operation ran. Source and Git inspection only. The existing installed dependency is `croner`; no package/lockfile edits.

Hook-stop: none. `core.hooksPath` was unset and standard commit hook files were absent at inspection; plain local commits were used without bypass options. No prohibited hook was encountered.

This contains Cron/date computation exceptions, not malformed YAML/read failures in `listSchedules`, arbitrary fire/admission failures, or a computational wall-clock timeout. Those retain existing scheduler load/error behavior. The helper is synchronous and does not start scheduled jobs or introduce a worker/timer. No automatic fire, retry, disable, repair, timezone normalization or source rewrite runs on observation/restart.

A previously malformed legacy definition can still be read or removed, but an unrelated write through the now-validating writer may refuse until timing is corrected. Valid saved tasks retain values and serialization flow. Root should execute the regression sources and existing loader/lifecycle suites, review HTTP error mapping, and perform scheduler/restart acceptance. Source delivery is not installed acceptance and does not complete the shared checklist.

## Proposed draft PR (not published)

Title: `Contain malformed routine timing and validate computed next runs`

Body: `Malformed cron/timezone computation now stays within its routine so later schedules remain evaluable. Shared schedule writes and desktop schedule tools validate actual next-run computation before publishing a merged definition, preserving existing identity, atomic writes and receipts. Includes authored offline regression sources; no checks executed. Root HTTP/UI presentation fragments and installed scheduler acceptance remain pending.`
