# Desktop Routines — integrated source handoff

## Current root integration (2026-11-04; native checks in progress)

This section describes the coding-worktree integration and supersedes the historical activation snippets below. The original agent handoff remains intact as provenance. In particular, its instruction to await preparation drain before signalling active model cancellation is superseded by the shutdown sequence here. Routines is installed and has been exercised in the Mac app at `464332f`; the earlier Keychain startup block is resolved. Build `742d089` is installed and awaiting Keychain approval for the final native gates. Final restart acceptance and cleanup are not yet claimed complete. The [integration review](../desktop-handoff-integration-review.md) is the acceptance ledger; source wiring and authored regressions alone are not native acceptance.

- `apps/engine/src/desktop/schedule-binding.ts` supplies current engine enabled/grant checks and the authenticated UI authorization/adoption bridge. It initializes the additive occurrence schema and recovers interrupted claims once per immutable owner per engine process, including newly created coworkers before their first admission. Existing owners pending deletion are skipped at startup so local deletion recovery can proceed. It uses the existing trusted loopback callback origin and engine bearer credential, refuses redirects, bounds acknowledgement bytes and time, and requires `ok:true,persisted:true`.
- `apps/engine/src/cli/commands/desktop-run.ts` first listens with authenticated reads available and mutations/readiness blocked. It then reconciles interrupted runs, allowing scheduled failure callbacks to fetch their exact session/run, binds and recovers scheduling, starts the scheduler, and reports ready. The supervisor already starts the UI before the engine. Desktop ticks do not activate hosted memory/brain/Codex-home maintenance.
- Quit closes HTTP and scheduler admissions synchronously. Terminal UI schedule/MCP closure, active model cancellation and preparation drain then proceed together; a final abort pass follows drain before service teardown. This prevents a model preparation that needs cancellation from blocking its own Stop. Failed callback closure never reopens admission; the supervisor retains its existing forced-stop fallback.
- `runtime/headless-run.ts` durably stores provider/model and exact scheduled trigger identity immediately after reserving the run row and before launch callbacks/model preparation. A context-write or admission failure cancels the row. Early provider failures and restart reconciliation therefore remain identifiable as scheduled results.
- `apps/ui/lib/desktop/server/schedules-binding.ts` resolves the exact local/engine owner, rejects deletion/disabled owners, checks the current explicit `schedule` grant, and rechecks local identity after the engine read. The terminal shutdown set is shared across Next route bundles with `globalThis`/`Symbol.for`, keyed by data root and launch nonce. The authenticated engine callback dispatches strict `desktop.schedule.authorize`, `desktop.schedule.adopt`, and `desktop.schedule.shutdown` events before generic notification parsing. Adoption ACK follows durable SQLite ownership checks; generic `agent.schedule.completed` callbacks adopt before terminal notification handling.
- Browser CRUD/Test Run is mounted at `/api/desktop/coworkers/[agentId]/schedules`, with GET/PUT/POST/DELETE and existing desktop authentication. The engine permits only the corresponding scoped schedules routes and owned run/session reads. UI mutations recheck authorization after the bounded body read; engine CRUD rechecks before writes. The merged cron/one-shot exclusivity correction is desktop-only, preserving original hosted PATCH behavior.
- `DesktopCoworkerRoutines` wraps the original panel primitives in the existing controlled coworker dialog. The `scheduled` panel is exposed as **Routines**; the additive **Schedules** grant is available in Capabilities. Result opening uses the existing `onSelectSession` path with the durable **local** chat ID. Owner changes, close/reopen and retained callbacks cannot navigate an obsolete result. List epochs prevent an older GET from replacing a newer mutation/Refresh result. No model-side `schedule_*` tools are exposed in the desktop registry in this slice.
- Owned history GET performs bounded, best-effort scheduled-chat recovery before reading local chats. Successful recovery is cached per owner/engine identity and launch; concurrent reads share one attempt, failures retry after 30 seconds, and an unavailable engine leaves valid saved chats available with a response warning. Recovery checks at most 200 scheduled sessions and skips existing local mappings. The finished-runs projection separately adopts missing eligible scheduled sessions within its existing 2.5-second deadline, four-worker limit and unchanged activation cutoff; invalid/slow results remain explicitly unavailable and are throttled. Cancellation checks prevent late network responses from starting local adoption writes.
- Desktop chat now renders parsed scheduled-run metadata using Rerun's original `ScheduledRunBlock`: **Scheduled run**, routine name, and **View prompt**. It does not label the routine as a human message. The original hosted workspace-link navigation is disabled in this prompt view; desktop Files remains the document entry point.

New/expanded authored regressions cover startup read/write/readiness ordering, cancellation before preparation drain, one-time existing/new owner schema recovery, grant revocation during acknowledgements, stalled acknowledgement cancellation, durable adoption and cross-bundle shutdown, run-context persistence before early model failure, closed/reopened panel navigation, bounded history recovery with offline fallback and owner changes, scheduled completion adoption/cutoff/deadline/isolation, original transcript divider/draft preservation, and desktop-only timing validation. Root owns all verification; exact automated results and source identities are recorded in the acceptance ledger, separately from native evidence.

Remaining scope limits are intentional: tasks run only while Rerun is open; one due occurrence after sleep/reopen, no replay of every missed interval; durable at-most-once claims can lose a claimed occurrence on crash; incomplete manual receipts refuse blind replay. Paused tasks cannot run until resumed; disabled coworkers or a missing Schedules grant block this adapter. Raw cron/ISO and timezone replace hosted natural-language parsing, and tasks follow the coworker's configured local model. Latest-result lookup is limited to 100 runs: a missing match in a full page is explicitly unavailable, while a complete smaller page can establish Not run yet. Result refresh is manual. First-open history recovery is bounded and cached, not a continuous full-engine history scan. No model-side scheduling tools are exposed.

### Native evidence and final pending gates

Root's Mac checks at `464332f` passed manual, one-shot, and automatic recurring runs with real replies; editing, pause, and timezone changes; the original `ScheduledRunBlock`; and immediate routine chat title/list updates. Disabled-coworker and grant-blocked cases passed, including the corrected refusal display that does not falsely show an empty routine list. Earlier restart checks preserved routine state and results without replaying a consumed occurrence.

The final candidate `742d089` is installed and awaiting Keychain approval. Final native rechecks, full-restart state comparison, and backed-up cleanup/original-workspace verification remain **pending**. Root will replace this statement only after those gates finish; the [acceptance ledger](../desktop-handoff-integration-review.md) owns the final verdict.

## Historical E8 source handoff (preserved provenance)

Everything below records the external lane's state at handoff, including its then-unapplied
integration instructions and lack of check execution. It does not describe the current
installed app or add an outstanding activation requirement. The current integration,
shutdown order, scope, and acceptance status above supersede those historical statements.

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
