# Round 35 D — full workspace Routines tab

Source implementation and authored regression sources only. Assignment base `5c0f589b51a8129d097f2b97fc420a8acf859b51`; this is not installed acceptance. Root owns central integration, every repair/check and Mac/restart QA.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/foreman/ForemanRoutines.tsx`: workspace fan-out, failed-owner exclusion, next-run ordering, held toggle row, 1.5-second run settle, rename/pause/resume/Run now, editor/result navigation and empty/skeleton states.
- `apps/ui/app/api/_actions/agent.actions.ts` `listWorkspaceRoutinesAction`: exact routine fields, setup-pending derivation, running-session matching, `canRename`, and original update/test actions.
- `packages/ui/src/foreman/RoutineList.tsx`: period grouping, paused disclosure, buddy/name/frequency/status subline, switch, rename field and menu structure. Reused unchanged.
- `apps/ui/components/agent/AgentPanelScheduled.tsx` and current `apps/ui/components/desktop/schedules/DesktopCoworkerSchedules.tsx`: full edit fields, prompt, timezone, model note, conflict handling and exact result-chat behavior.
- `apps/ui/components/desktop/server/schedules/api.ts`: current authoritative schedule reads/mutations, request IDs and adopted result sessions.
- `apps/ui/components/desktop/server/schedules/adoption.ts`: exact owner/run/source checks and durable local result-chat identity.

Local adaptations: reads aggregate the same scheduler across local coworkers without invoking the model’s schedule-management grant. Mutations use the existing authoritative scheduler but add explicit current revision checks around the existing authority call. Editor polling keeps the draft and offers `Refresh from latest` / `Keep my draft` before saving.

## Implementation inventory and public contract

### `packages/contracts/src/desktop-workspace-routines.ts`

- `desktopWorkspaceRoutineChatSchema`: exact local `{agentId,sessionId,engineSessionId,tabUid,title,runId}` result destination.
- `desktopScheduleRecordSchema`: routine prompt/cron/one-shot/timezone/enabled state plus exact `revision` and optional `lastRunAt`.
- `desktopScheduledRunSchema`: scheduled source/slug/status/start identity.
- `desktopWorkspaceRoutineSchema`: original `RoutineEntry` plus revision, last result and adopted chat.
- `desktopWorkspaceRoutinesViewSchema`: bounded routines plus `canRename`.
- `desktopWorkspaceRoutineOwnerSchema`: local agent/engine IDs, enabled and setup-pending state.
- `desktopScheduleEditInputSchema`: original full editor input and cron-versus-one-shot validation.
- `desktopWorkspaceRoutineMutationSchema`: `rename`, `toggle`, `run`, `edit`, each bound to agent/slug/expectedRevision/requestId.
- `desktopWorkspaceRoutineMutationResultSchema`: current routine and optional adopted result chat.
- `byNextRun`: original next-run-then-name ordering.

### Server adapters

- `createDesktopWorkspaceRoutinesReader(authority)`: exact local owner aggregation, disabled-owner exclusion, failed-owner drop-out, running/last-result matching, setup state and `canRename`.
- `createDesktopWorkspaceRoutinesMutator(authority)`: `receipt` first for lost ACK recovery; `current → authorize → current` immediately before mutation; stale/replacement refusal; actual-name verification for rename.
- `createDesktopWorkspaceRoutinesApi(authority)`: bounded no-store GET/POST binder. Route files remain root-owned.

Authority method types are exported from `reader.ts` and `mutations.ts` as `DesktopWorkspaceRoutinesAuthority` and `DesktopWorkspaceRoutinesMutationAuthority`.

### Client and UI

- `createDesktopWorkspaceRoutinesClient`: canonical `/api/desktop/workspace/routines` GET and mutation POST with parsed responses.
- `DesktopWorkspaceRoutines`: original RoutineList, empty/skeleton states, held row, rename/toggle/run/edit/result actions and stable per-revision request IDs.
- `DesktopWorkspaceRoutineEditor`: original full editor fields and explicit conflict/refresh choices.

## Concrete root authority bindings

Use the existing local roster/engine/adoption functions, not a second scheduler or run ledger:

```ts
const authority = {
    listOwners: async signal => listCurrentLocalOwners(signal),
    listSchedules: (owner, signal) => listSchedules(engineOf(runtime), owner.engineAgentId, { signal })
        .then(rows => rows.map(row => withCurrentScheduleRevision(row))),
    listRuns: (owner, signal) => listRuns(engineOf(runtime), owner.engineAgentId, { limit: 100, signal }),
    adopt: (owner, run, signal) => adoptDesktopScheduledSession(db, engineOf(runtime), {
        agentId: owner.agentId, engineAgentId: owner.engineAgentId,
        engineSessionId: run.sessionId, runId: run.id,
    }, { signal }),
    canRename: signal => supportsScheduleRename(engineOf(runtime), signal),

    current: (agentId, slug, signal) => currentScheduleWithRevision(agentId, slug, signal),
    authorize: (agentId, signal) => authorizeDesktopSchedules(runtime, db, agentId, signal),
    receipt: (requestId, signal) => readExistingScheduleOccurrenceReceipt(requestId, signal),
    mutate: (input, signal) => applyExistingScheduleMutation(input, signal),
}
```

`listCurrentLocalOwners` must map local `agentId` to exact `engineAgentId`, exclude deleting/disabled owners as appropriate and derive `setupPending` from current setup config. `withCurrentScheduleRevision` must return the schedule’s current authoritative revision. If the engine does not expose one, root must compute a deterministic revision from the complete current schedule record, not a timestamp guess. A same-name replacement must produce a different revision.

`applyExistingScheduleMutation` delegates to existing update/create/test APIs with the supplied request ID. `readExistingScheduleOccurrenceReceipt` is root’s existing occurrence/request recovery path; no new receipt store is introduced. Manual runs use the current `x-desktop-schedule-request-id` header and `adoptDesktopScheduledSession`.

Read-only `listOwners/listSchedules/listRuns/adopt` must not call `authorizeDesktopSchedules`, because that would require the model’s schedule-management grant. `authorize` is called only by the mutator and must enforce current owner enabled/not-deleting state, setup completion, schedule grant and model availability.

## Route mount (root creates)

```ts
// apps/ui/app/api/desktop/workspace/routines/route.ts
import { createDesktopWorkspaceRoutinesApi } from '@/lib/desktop/server/workspace-routines/api'
import { desktopRoute } from '@/lib/desktop/server/http'

export async function GET(request: Request) {
    return desktopRoute(request, async () => createDesktopWorkspaceRoutinesApi(authority).GET(request))
}
export async function POST(request: Request) {
    return desktopRoute(request, async () => createDesktopWorkspaceRoutinesApi(authority).POST(request))
}
```

Use `dynamic = 'force-dynamic'` and no-store responses. Root may bind authority once per runtime, but must not create a parallel scheduler.

## Foreman mount (replace unavailable seam)

Replace the old unavailable-only `routines.list` presentation with the concrete component; do not leave its stub in the mutation path:

```tsx
const routinesClient = createDesktopWorkspaceRoutinesClient()

<DesktopWorkspaceRoutines
    client={routinesClient}
    agentNameOf={agentNameOf}
    onOpenChat={chat => openExistingExactResultChat(chat)}
    onOpenRoutine={routine => openExistingCoworkerSchedule(routine.agentId, routine.slug)}
    docked={docked}
    className="min-h-0 flex-1 pt-24"
    refreshKey={schedulesRefreshKey}
    workingSessions={workingSessionKey}
/>
```

Root supplies `onOpenChat` through the existing exact adopted-chat opener, preserving board selection, tabs and unsent drafts. `onOpenRoutine` is the existing per-coworker schedule editor. `workingSessions` should be the sorted working-session IDs used for the original 1.5-second settle.

## Persistence and recovery semantics

- Reads reconstruct state from authoritative schedules/runs after restart. Mount, polling and history reads never fire Run now.
- Toggle holds the row in its prior position until the next run time passes, matching original behavior.
- Each action uses a stable request ID for its exact revision. Duplicate clicks/lost ACK reconcile through the existing occurrence/request identity; a new revision requires a new request.
- `current → authorize → current` refuses deleted/replaced routines and owner/grant/setup/model changes before effects.
- Editor polling marks external changes but keeps local text. Saving/Run now is blocked until the user chooses latest or keeps the draft.
- Existing disabled coworkers and setup gates remain visible as setup-pending rows, not silently enabled. Model availability is checked only by the existing mutation authority.
- No feature-owned migration is needed: this package uses existing schedule, occurrence and adopted-session persistence.

## Implemented / dependent / unsupported matrix

| Area | Implemented in lane | Root dependency | Unsupported here |
| --- | --- | --- | --- |
| Aggregation | Workspace owners, ordering, setup/running/last results | Current roster/schedule/run readers | New scheduler |
| Original list | Grouping, held row, empty/skeleton, rename/toggle/menu | Concrete mount replacing unavailable seam | Parallel presentation authority |
| Mutations | Revision checks, rename/pause/resume/run/edit | Existing schedule authority/receipts | Model-grant-free mutation |
| Result navigation | Exact adopted local chat only | Existing adoption/navigation | Guessed session/run |
| Editor | Full fields and conflict/refresh choices | Existing model/provider/save adapters | Silent draft replacement |
| Restart/ACK | Read reconstruction and stable per-revision IDs | Existing occurrence recovery | Mount/restart auto-run |
| Verification | Aggregation/mutation/mounted UI regressions | Run all checks and restart QA | Acceptance claims |

## Regression sources authored, all unrun

- `apps/ui/lib/desktop/server/workspace-routines/reader.test.ts`: multi-owner aggregation, setup state, running/last results, failed-owner exclusion and no fabricated history.
- `apps/ui/lib/desktop/server/workspace-routines/mutations.test.ts`: stale/replacement revisions, duplicate/lost ACK, exact rename/toggle/run authority and disabled/setup/model refusal.
- `apps/ui/components/desktop/foreman/routines/DesktopWorkspaceRoutines.test.tsx`: empty state, exact result chat, pause rollback and editor draft preservation/refresh choice.

No tests, typecheck, lint, builds, installs, servers, provider calls, UI actions, Docker, Keychain, live data or restart acceptance were performed. Installed Next.js guides under `node_modules/next/dist/docs` are absent in this checkout; no installation was attempted.

## Changed files

- `packages/contracts/src/desktop-workspace-routines.ts`
- `apps/ui/lib/desktop/server/workspace-routines/reader.ts`
- `apps/ui/lib/desktop/server/workspace-routines/reader.test.ts`
- `apps/ui/lib/desktop/server/workspace-routines/mutations.ts`
- `apps/ui/lib/desktop/server/workspace-routines/mutations.test.ts`
- `apps/ui/lib/desktop/server/workspace-routines/api.ts`
- `apps/ui/lib/desktop/workspace-routines/client.ts`
- `apps/ui/components/desktop/foreman/routines/DesktopWorkspaceRoutines.tsx`
- `apps/ui/components/desktop/foreman/routines/DesktopWorkspaceRoutines.test.tsx`
- `apps/ui/components/desktop/foreman/routines/DesktopWorkspaceRoutineEditor.tsx`
- `docs/desktop-round35-d-handoff.md`

There is no separate dependent-agent contract revision. Scheduler/adoption interfaces were read at assignment base `5c0f589b51a8129d097f2b97fc420a8acf859b51`.
