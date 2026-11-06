# Desktop Round 33 — Agent D handoff (E8 model tools)

Source only. No tests, typecheck, lint, build, install, server, packaging, Docker, Keychain, live provider, or app launch was run. E8 is not accepted and the checklist was not changed.

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round33-routine-tools`  
Branch: `desktop/round33-routine-tools`  
Base: `56fdce61a780e005644057cc77d8edebbf0d067a`  
Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`

## Original → adapter

| Original at `a6d63a4` | Desktop adapter |
| --- | --- |
| `apps/engine/src/tools/builtin/schedule.ts` | `apps/engine/src/desktop/schedule-tools/tools.ts` — same six tools and the same success/error lines where the Mac path can keep them |
| `apps/engine/src/tools/builtin/automation-model.ts` | `schedule-tools/model.ts` — no silent substitute. A different pin is refused. A matching pin is stored as follow-coworker (`connectionId`/`provider`/`model` null) |
| `apps/engine/src/schedules/loader.ts` | `schedule-tools/files.ts` compare-and-swap on the same `schedule:${agentId}:${slug}` lock. Definitions stay in the existing `.md` files |
| `apps/engine/src/schedules/cron.ts` | reused for list/get next-run text and for cron validation. No second timer |
| `apps/engine/src/runtime/scheduler.ts` and `desktop-schedule-state.ts` | not called. Listing, reading, editing, deleting, recovering a receipt, or reviewing a result does not claim an occurrence |
| `apps/ui/components/agent/AgentPanelScheduled.tsx` and `ScheduledRunBlock.tsx` | unchanged. Actual runs still use the accepted scheduled-run presentation. `DesktopScheduleToolNotice` only shows a tool outcome |
| Human Routines API `apps/ui/lib/desktop/server/schedules/` | unchanged and independent of the new grant |

Hosted `scheduleTools` remain the non-desktop path. This package does not replace them.

## Contract

`packages/contracts/src/desktop-schedule-tools.ts` is not on the barrel. Engine value-imports it from `@rerun/contracts`, so root adds this before the tools can load:

```ts
export * from './desktop-schedule-tools.js'
```

Then rebuild `@rerun/contracts`. The UI server imports the source file directly so the notice route does not wait on that rebuild.

Grant id: `scheduleManage` (`DESKTOP_SCHEDULE_MANAGE_GRANT_ID`). It is not the existing `schedule` grant. That grant still only means “run routines while Rerun is open.” Management stays off until root adds the id and a person turns it on.

## Behavior

- Identity is the current engine coworker, run, and session. Mutations also hash `coworker + run + toolCallId` into the request id. The same id and the same fingerprint replay the terminal receipt. A different fingerprint conflicts. The previous routine stays.
- Every call rechecks enabled, deleting, guided setup, and `scheduleManage`. Human Routines requests do not use this grant, and these tools do not require the run grant.
- Create takes cron or `runAt`, not both, plus an IANA timezone. Update that sets cron clears `runAt`, and the reverse. A legacy row that still has both or neither is refused rather than rewritten. `schedule_edit` is exact text and does not change timing. `schedule_update` with `body` is a full replacement.
- `expectedRevision` is the sha256 of the editable definition. `lastRunAt` is not part of it. The scheduler stamp is copied from the current file inside the lock, so a fired one-shot is not cleared and does not become due again.
- The intent row is reserved before the file swap. A lost acknowledgement of a landed file seals `committed` on retry or `recover`. An unlanded write stays pending so the same request can finish. A file that moved under a pending intent is sealed `interrupted` and is not overwritten. Terminal receipts are not rewritten. A post-reserve refusal other than a stopped parent or a cancellation leaves that intent pending. `recover` does not apply it and does not clear it. The same request can finish later. A later request that passes admission supersedes it, keeps the file that is on disk, and only then writes its own change.
- A stopped parent or a cancelled admission before the swap seals the intent and does not save. Delete unlinks that one `.md` file. Run rows and occurrence rows are not touched.
- Outcomes are `committed`, `rejected`, `cancelled`, and `uncertain`. The model still receives the original one-line string. `readDesktopScheduleTools().projection(toolCallId)` has the structured outcome for that turn.
- A past one-shot can still be due once under the accepted scheduler. These tools do not fire it, do not mark it fired, and do not replay missed cron ticks.

Desktop differences from the hosted tools, on purpose:

- Create does not upsert an existing slug.
- Update cannot leave both cron and `runAt` set.
- Timezone is required on create.
- A provider/model other than the coworker’s connected pair is refused, because `scheduler.ts` still strips pins on desktop (`connectionId`/`provider`/`model` forced null before `automationModel`). Storing that pin would look saved and then run as the coworker model.
- A coworker with no connected desktop model cannot save an enabled routine.
- `schedule_get` adds a `Revision:` line so a later edit can pass `expectedRevision`.

## Root wiring

1. Barrel export and contracts build, above.
2. Add `'scheduleManage'` to `desktopRerunGrantIds` in `packages/contracts/src/desktop-tool-grants.ts`, default absent/false, and catalog it as its own row (not nested under the run grant) with tools `schedule_list`, `schedule_get`, `schedule_create`, `schedule_update`, `schedule_edit`, `schedule_delete`. Label it as managing routines. Keep the existing Schedules row as the run switch, with no tool names.
3. On engine startup, after schedule files exist and beside the trigger binding:

```ts
import { bindDesktopScheduleTools, DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL } from './desktop/schedule-tools/index.js'

bindDesktopScheduleTools({
  getSystemClient: async engineAgentId => (await getSystemDb(engineAgentId)).client,
  authority: {
    assertActive: () => { if (stopping) throw new Error('Desktop schedules are stopping') },
    resolveOwner: async engineAgentId => { /* fresh local row + engine agent; scheduleManage === grants.scheduleManage === true; connectedModel is the usable desktop model or null; do not substitute */ },
    readRun: (engineAgentId, runId) => getRun(engineAgentId, runId),
    notify: async notice => { /* POST the notice to the UI route below. Must not call fireSchedule. */ },
  },
})
```

`DESKTOP_SCHEDULE_TOOL_SCHEMA_SQL` creates only `desktop_schedule_tool_intents` on the existing per-coworker system database. It is not a routine store. Call it from the same startup migration path, or let `createDesktopScheduleIntentStore` apply it on first use.

4. In `buildTools`, only on the desktop branch, after the trigger block:

```ts
const scheduleToolRuntime = readDesktopScheduleTools()
const manage = (ctx.agent.config.tools.desktopToolGrants as { scheduleManage?: boolean } | undefined)?.scheduleManage === true
if (scheduleToolRuntime && manage && !ctx.agent.config.ephemeral) {
  Object.assign(tools, scheduleToolRuntime.tools(ctx.agent.id, ctx))
}
```

Do not register these tools for delegation children. `delegation/runtime.ts` already blocks `schedule_` names.

5. After interrupted-run reconciliation, and not while an occurrence is being claimed, call `readDesktopScheduleTools()?.recover(engineAgentId)` per coworker. Recover seals receipts. It does not apply an unlanded write and does not start a run.
6. UI startup: `bindDesktopScheduleToolNotices()`. Mount `desktopScheduleToolNoticeRequest` at a desktop route keyed by the local coworker id. Until `bindDesktopScheduleToolNotices` runs, that route returns 503 `Schedule management is not wired on this Mac yet.` GET and POST only record or list notices. They do not read or run a routine.
7. Point the existing Routines panel refresh at those notices (or refetch `GET /api/desktop/coworkers/:id/schedules` after a committed notice). Do not add a second editor. Scheduled runs keep `ScheduledRunBlock` / `DesktopScheduledRunBlock`.
8. Optional chat rendering: `DesktopScheduleToolNotice` with the projection outcome and text. It has no button and does not fetch.

`connectedModel` must be the model `assertDesktopProvider` would allow and `isUsable` would accept. If none, pass null. Do not copy `automationModel`’s fallback ladder into the tool.

## Regressions authored, not run

- `apps/engine/src/desktop/schedule-tools/lifecycle.test.ts` — list/get text, create, exclusivity, invalid cron/ISO/timezone, pin refusal, missing model, duplicate name, full replace, exclusive cron/`runAt`, stale edit, ambiguous edit, fired-stamp preservation, human/model conflict, delete with an untouched history array, fingerprint conflict, lost ack, failed panel notice, restart recover, divergent recover, grant/setup/enabled/deleting, stopped parent, cancel, immutable receipt, provider without model
- `apps/engine/src/desktop/schedule-tools/tools.test.ts` — original created line, replay, conflict, grant off, stopped parent, exact edit
- `apps/engine/src/desktop/schedule-tools/model.test.ts`
- `apps/engine/src/desktop/schedule-tools/files.test.ts` — `lastRunAt` preserved, symlink refused
- `apps/ui/lib/desktop/server/schedule-tools/notices.test.ts`
- `apps/ui/components/desktop/schedule-tools/DesktopScheduleToolNotice.test.tsx`

## Matrix

| | |
| --- | --- |
| Implemented | Six tools, definition CAS on the existing schedule files, separate default-off permission checks, revisioned edit vs full replace, intent receipts, lost-ack/restart reconcile, projections, notice route and static presenter |
| Root-dependent | Contracts barrel, `scheduleManage` catalog grant, `buildTools` registration, system-db schema call, `bindDesktopScheduleTools` authority, startup `recover`, notice route mount, panel refetch, connected-model lookup |
| Unsupported | Natural-language schedules, a second routine database or timer, running a task from list/get/edit/delete/recover/notice review, replaying every missed cron tick, pinning a model the desktop scheduler would ignore, hosted-tool upsert, changing human Routines or Triggers, installed acceptance |
