# E8 desktop schedules completion — source handoff

Preserves reviewed `7e67ce1907ede7e43acda346027835b1923a6a0b`, prepared base `927c5e17da6b6db84657261695a98e0533b264de`. Original Rerun reference `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

This commit supplies working source components/helpers, not root integration or acceptance. The four-file reviewed handoff did not supply the desktop panel, authenticated desktop adapter or durable chat adoption; generic hosted UI and desktop first-turn helpers did not establish this path.

## Intended source

- `apps/ui/components/desktop/schedules/DesktopCoworkerSchedules.tsx`: isolated panel/editor. Original panel primitives, New, scheduled task count, No scheduled tasks yet, New task/Edit task, When, Timezone, Enabled, Task prompt, Create task/Save changes, Test Run and confirmed Delete task. Create/edit, pause/resume via Enabled + Save, recurring cron/one-shot, next run/last status, result chat and Refresh. Uses the coworker's configured local model, no hosted parsing/model picker.
- `apps/ui/lib/desktop/server/schedules/api.ts`: authenticated factory, exact local coworker resolution, current root schedule authorization, local engine CRUD/Run now/history calls, bounded input and result-chat adoption.
- `apps/ui/lib/desktop/server/schedules/adoption.ts`: exact local/engine/session/run ownership checks, idempotent SQLite adoption, stable local session and tab identities, callback/history recovery helpers.
- `apps/engine/src/runtime/desktop-schedule-state.ts`: additive occurrence schema and durable due/manual ownership, settlement and startup recovery.
- `apps/engine/src/runtime/scheduler.ts`: synchronous per-schedule reservation before first await, fresh schedule/agent/grant reads, desktop occurrence claims, adoption, guarded preparation/launch, stopped generation and drain contract.
- `apps/engine/src/runtime/headless-run.ts`: optional lifecycle checkpoints before run-row creation, after it and before actual runAgent invocation; cancelled row on failed admission.
- `apps/engine/src/schedules/loader.ts`: compare-and-consume under the same file lock used by pause/edit.
- `apps/engine/src/http/routes/schedules.ts`: narrow schedule route correction: nullable cron/runAt updates with merged timing validation, timezone validation on patch, required UUID manual request header on desktop.
- Focused sources: `runtime/desktop-schedule-state.test.ts`, updated `runtime/scheduler.test.ts`, UI server `schedules/adoption.test.ts`. NOT executed.

Original references read: `AgentPanelScheduled.tsx` list/editor/history; `ScheduledRunBlock.tsx`; `runtime/scheduler.ts`; `runtime/headless-run.ts`; `http/routes/schedules.ts`; `schedules/cron.ts`, `loader.ts`, `message.ts`. The original `<scheduled_run>` message wrapper is retained, allowing root's existing parser to render ScheduledRunBlock. No DesktopConversation edit. Next route docs read from `final-build/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`; no dependencies added.

## Root integration: mandatory exact contracts

### 1. Current grant and owner authority

Root adds the schedules opt-in to its central grant schema/UI/catalog and supplies an authorization function that throws unless the exact local coworker still maps to the requested engine ID, is not deleting, is currently enabled, and its current schedules grant is true. Re-read authority on each call; do not use board projection or a captured permission snapshot. The engine uses this callback before and after awaited preparation. API management currently requires the same grant/enabled check; disabled coworkers do not run or edit schedules through this adapter.

```ts
// In the supervised UI process, one binding for the current desktop DB:
import { desktopSchedulesApi } from '@/lib/desktop/server/schedules/api'
const api = desktopSchedulesApi(db, authorizeCurrentScheduleEngineOwner)
```

`authorizeCurrentScheduleEngineOwner(engineAgentId): Promise<void>` is a REQUIRED root-owned interface, not a helper supplied by this lane. It checks the current local identity, engine enabled state and exact schedule grant. Root must implement its central schema/policy, never replace this callback with a no-op.

Concrete route (root-owned) `app/api/desktop/coworkers/[agentId]/schedules/route.ts`:

```ts
import { getDesktopSchedulesService } from '@/lib/desktop/server/schedules-binding'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = {params:Promise<{agentId:string}>}
async function handle(request:Request,context:Context) {
  return (await getDesktopSchedulesService()).api(request,(await context.params).agentId)
}
export {handle as GET,handle as PUT,handle as POST,handle as DELETE}
```

`getDesktopSchedulesService` is the root binding, not a lane export. GET returns schedules with nextRunAt and lastResult/chat. PUT `{slug?,input:{name,description,body,cron:string|null,runAt:string|null,timezone,enabled}}`; PATCH is intentionally not exposed. PUT clears fixed model overrides to follow the coworker's configured local provider. DELETE `{slug}`; POST `{slug,action:'run',requestId:<UUID>}`. Test Run retries retain their UUID after uncertain failure; recorded manual receipts replay their original identity; incomplete receipts reject rather than launching another run. Paused tasks must be resumed before Test Run.

Root engine policy must allow authenticated local engine operations used here:

- GET `/agents/:id/schedules` and `/agents/:id/schedules/:slug`
- POST `/agents/:id/schedules` and `/agents/:id/schedules/:slug/run`
- PATCH and DELETE `/agents/:id/schedules/:slug`
- Existing scoped GET sessions, runs and session messages/stream routes for adoption/history/opening.

Do not enable `/api/schedules/parse` or any hosted parser. Keep all existing engine authentication and exact owner restrictions. This commit does not change `desktop/policy.ts`.

### 2. Occurrence schema and app-open scheduler

In the engine process, root registers `desktopScheduleOccurrenceSchema` in EACH coworker's system DB before schedules are admitted. It is an additive internal table and must remain hidden from coworker database tools. Register for new coworkers too. Root does not modify user tables.

```ts
import { getSystemDb } from './db/systemDb.js'
import { desktopScheduleOccurrenceSchema, recoverDesktopScheduleClaims } from './runtime/desktop-schedule-state.js'
import { configureDesktopSchedules, startScheduler } from './runtime/scheduler.js'
// Single engine-owner startup, AFTER reconcileInterruptedRuns, before scheduler/API admission:
for (const engineAgentId of localEngineAgentIds) {
  const {client}=await getSystemDb(engineAgentId)
  await client.executeMultiple(desktopScheduleOccurrenceSchema)
  await recoverDesktopScheduleClaims(engineAgentId)
}
configureDesktopSchedules({
  authorize: authorizeCurrentScheduleEngineOwner,
  adopt: async(engineAgentId,engineSessionId,runId,title)=> {
    // Root's authenticated local callback bridge must await durable adoption acknowledgement.
    await postDesktopScheduleAdoption({agentId:engineAgentId,sessionId:engineSessionId,runId,title})
  },
})
const stopScheduler=startScheduler()
```

The authorize/adopt implementations above are root cross-process bindings. A failed/missing grant or adoption bridge fails closed; it does not silently launch a headless task with no desktop result path. `postDesktopScheduleAdoption` must use existing app/engine authentication and acknowledge only after SQLite adoption, not the current persisted:false response. Startup must have one engine owner: do not call recoverDesktopScheduleClaims in a live second process. Recovery marks outstanding claims interrupted without replaying them. Durable unique `(schedule_slug,occurrence)` plus one-active-schedule index prevents concurrent/manual/restart duplication. A claimed baseline encountered again advances the file stamp to now without relaunch, so a crash before stamping cannot freeze future intervals. A due attempt while the task is already active is likewise skipped and advances its baseline. Crash after claim but before launch may lose that occurrence; this is deliberate at-most-once behavior, never exactly-once execution.

### 3. Shutdown ordering (fix is incomplete until root uses drain)

```ts
stopping=true             // reject new engine API work
stopScheduler()           // synchronous: closes admission, bumps generation, clears interval
await stopScheduler.drain() // await ticks + in-progress launch preparation, not entire model runs
await abortAllRuns()       // now no suspended schedule prep can start a run after this sweep
// then existing MCP/server shutdown
```

Clearing a timer alone is insufficient. Checks occur after awaited list/get/model/grant/claim/stamp/adoption/notification and inside headless launch. Drain intentionally waits for dependencies to return; if a dependency hangs, root must keep the engine stopped and terminate it rather than reopen admission or report a completed drain. Do not race drain and abortAllRuns. Manual runs use the same global stopped/generation boundary and per-schedule reservation. Existing `desktop-run.ts` from reviewed commit still calls only stopScheduler(); root owns changing its shutdown to the above contract. No startup/shutdown source was edited by this follow-up.

### 4. Durable callback, history and Actions adoption

```ts
import { adoptDesktopScheduleEvent, recoverDesktopScheduledChats } from '@/lib/desktop/server/schedules/adoption'
// Root callback AFTER authenticateDesktopEngineRequest + notification schema validation:
// For source:schedule agent.session.created / agent.message.completed only:
const chat=await adoptDesktopScheduleEvent(db,engineOf(runtime),notification)
return Response.json({ok:true,persisted:!!chat,chat})
// Root chat-history recovery, before reading local session history:
await recoverDesktopScheduledChats(db,engineOf(runtime),localCoworkerId)
// Root Actions/completion path: if engine-only scheduled session, call adoption before lookup/drop.
```

`adoptDesktopScheduleEvent` maps exact engine ID to one workspace-1 local coworker; adoption then verifies remote session owner/source and, if provided, exact run owner/session. SQLite insert uses existing desktop_sessions unique engine_session_id, exact local/engine owner predicates and deletion guard. It returns `{agentId,engineAgentId,sessionId:<LOCAL>,engineSessionId,tabUid,title,runId}`; replay/restart returns the same local session and deterministic `schedule:<local-session-id>` tabUid. Do not pass the engine session ID to desktop chat controls expecting a local ID. The engine creation callback may have runId:null; completion binds/checks the eventual run. A different owner fails rather than hijacking an existing session. History recovery adopts up to 200 newest scheduled sessions per coworker per pass; older engine history remains available for explicit recovery.

Root panel entry:

```tsx
<DesktopCoworkerSchedules agentId={coworker.id} onOpenSession={chat=> {
  // Use the board's existing open-conversation operation with chat.agentId,
  // chat.sessionId (LOCAL), chat.tabUid, chat.title and chat.runId.
}}/>
```

Root callback/history/Actions, panel entry and chat opening are untouched. Local sessions persist without requiring a browser tab to remain open. The original ScheduledRunBlock can render the retained scheduled message marker through root's existing transcript renderer; this lane does not modify that renderer.

## Scope, semantics and remaining limits

Only app-open execution. A due task consumes one baseline, advances lastRunAt to now, then cron schedules the next future occurrence; sleep/reopen does not replay every missed interval. Current pause, grant and enabled state are checked at admission. Compare-and-consume shares the file lock with edits; body/config changes during preparation reject launch. One-shot tasks auto-disable when consumed. Manual runs require an enabled task, explicit current grant and stable request UUID. All desktop tasks follow the coworker's configured local provider/model; external/hosted fixed overrides are not presented. Natural-language parsing is unavailable, so UI exposes cron or an explicit ISO one-shot instant and timezone. This is a documented desktop difference from the hosted parser. UI displays the latest matching run within the newest 100 engine runs; when no matching run is present it explicitly reports Unavailable — history not established, never Not run yet. Refresh updates results; no browser polling loop added.

The helper source has not been connected to the live app. Root wiring and validation remain required; source completion is not runtime acceptance. This correction edits no shared central files; prior shared changes are identified below, no live workspace/database/credential changes, no dependencies installed, no preview app, no push or merge.

**No tests, type checks, lint, builds, packaging, network/tool/model requests, native Mac/restart checks or Mac acceptance were run by this lane.** Root must run the authored offline regressions plus integration checks for same-chat restart adoption, Stop/Quit during each preparation await, sleep catch-up, simultaneous due/manual, grant/pause/disable changes and current configured provider use.

## Reviewed completion corrections and activation gate
Occurrence SQL uses a template string preserving the claimed/started predicate. Manual UUID replay reads the durable receipt before new admission preparation and validates run/session agent ownership, schedule trigger slug and schedule session source. A recorded receipt returns the original session/run even after settlement/restart. A claimed/interrupted receipt lacking IDs fails truthfully and requires reconciliation; it never launches blindly. Different requests while a schedule is active cannot inherit the active request's result. UI retains the retry UUID. History outside the bounded page is explicitly unknown/unavailable; no inference of never-run is made. Matching results preserve durable chat IDs and existing source metadata.

Root MUST integrate before activation, in this order:
1. Initialize occurrence schema in EVERY existing coworker system DB after interrupted-run reconciliation, and in the coworker creation/bootstrap path before any admission. Single-owner startup runs recoverDesktopScheduleClaims. Do not reset or delete receipts: they retain replay identity.
2. Supply authorizeCurrentScheduleEngineOwner that resolves CURRENT exact engine ID to one local coworker, rejects deletion/reassignment/disabled owners, and checks its CURRENT explicit schedules grant. Apply the same identity check at authenticated UI routes and every engine admission. Bind local configured provider/model; no hosted provider override.
3. Mount desktopSchedulesApi at authenticated `/api/desktop/coworkers/[id]/schedules` with GET/PUT/POST/DELETE only. Root engine policy allows exactly GET/POST `/agents/:id/schedules`, GET/PATCH/DELETE `/agents/:id/schedules/:slug`, POST `/agents/:id/schedules/:slug/run` for the authorized identity; no generic unrestricted wildcard. Reject unknown paths/methods. Manual POST requires x-desktop-schedule-request-id UUID.
4. Implement authenticated cross-process postDesktopScheduleAdoption bridge, validating exact engine/local identity and current owner/grant before calling adoptDesktopScheduleEvent. Await durable SQLite adoption acknowledgement containing local sessionId, engineSessionId, tabUid and runId. persisted:false is failure, not adoption. Wire callback/history/Actions recovery BEFORE board opening; engine IDs must never substitute for local chat IDs.
5. Register coworker panel and configured local provider selection. Raw cron/ISO controls remain the local fallback; hosted natural-language parsing is unavailable.
6. Call configureDesktopSchedules(authorize/adopt) BEFORE startScheduler. In desktop mode start without bindings must remain unactivated. Quit first closes API admission, calls stopScheduler(), awaits stopScheduler.drain(), THEN abortAllRuns. Never start first and fill bindings later.

Prior shared-file changes inherited from 7e67ce1907ede7e43acda346027835b1923a6a0b: `apps/engine/src/cli/commands/desktop-run.ts` starts/stops scheduler but lacks configured bindings/drain order; `apps/ui/lib/desktop/server/engine-callback.ts` acknowledges session creation with persisted:false. These are NOT activation-approved. Root manually replaces those portions with the additive configure/start/drain and durable adoption snippets above; this correction does not expand either file. Root owns policy, bootstrap, callback/history/Actions, provider selection, panel and board wiring. Original source references remain a6d63a4: AgentPanelScheduled/ScheduleEditor, ScheduledRunBlock, runtime/scheduler.ts, runtime/headless-run.ts, http/routes/schedules.ts and schedules/cron.ts.

No checks (including tests/typecheck/lint/build) or Mac acceptance were run by me. No live requests/data/credentials, installs, preview, push or merge. Runtime acceptance and activation remain root-only.

## Follow-up: replay while post-launch adoption has failed

Continues reviewed `267c832292c6cc75ea885e589ebfff62793e6760`; preserves `3c0f21cf91a1a80f570598bf881d02429016be65` and `7e67ce1907ede7e43acda346027835b1923a6a0b`. This slice changes only `apps/engine/src/runtime/scheduler.ts`, `apps/engine/src/runtime/scheduler.test.ts` and this handoff.

When desktop launch preparation is already reserved, both its fulfillment and rejection now lead to an independently authorized durable receipt lookup for the exact coworker/schedule/manual UUID. A post-launch adoption failure therefore does not prevent replay of IDs already persisted, even while model settlement remains pending. This continuation never clears/replaces the original active reservation, starts another run or awaits model settlement. A different UUID cannot inherit the run; missing/incomplete receipts refuse. Non-desktop calls retain the original launch promise and its rejection semantics. Receipt ownership validation remains in replayDesktopSchedule unchanged.

The replay continuation is registered synchronously in preparation drain, captures the scheduler generation, checks Stop/generation/request activity around every await, and checks fresh authorization before and after the durable lookup. Shutdown therefore drains this continuation under the same admission contract before root aborts model runs.

Authored unexecuted regression source permits initial session adoption, persists original receipt IDs, rejects post-launch adoption, keeps the original model settlement pending, retries the same UUID and requires original IDs and one launch; another UUID and an incomplete receipt refuse. Existing SQL syntax safety and explicit unavailable-history fallback remain unchanged.

All root-only integration contracts and additive snippets above remain mandatory: exact current owner/grant identity authorization including authenticated cross-process bridge; narrow authenticated UI/engine routes; schema/recovery for existing and new coworkers; durable ownership-checked chat adoption before callback/history/Actions/board opening (persisted:false is failure); panel/provider selection; configure authorization/adoption BEFORE scheduler start; close admission, stop, await preparation drain, then abort active runs at Quit. The inherited desktop-run/engine-callback changes identified above are NOT activation-approved and were not expanded. App-open execution, one occurrence after sleep/reopen, at-most-once claims, raw cron/ISO fallback and unavailable hosted natural-language parsing remain unchanged.

Original references: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, engine `runtime/scheduler.ts`, `runtime/headless-run.ts`, schedules routes/cron helpers, UI AgentPanelScheduled/ScheduleEditor and ScheduledRunBlock; reviewed correction source at `267c832`. Prepared base remains `927c5e17da6b6db84657261695a98e0533b264de`.

**Checks and Mac acceptance were not run by me.** No tests, type checks, lint, builds, packaging, installs, network/tool/model requests, app control, live data/credential changes, preview, push or merge. Source handoff only; root activation and acceptance remain pending. Stop after this correction handoff.
