# Round 31 E — delegated tasks and Stop

Source handoff only. Checks, typecheck, lint, build, and native acceptance are pending root. This lane did not run them.

Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.
Branch base: `136f318e931a4433ea6d178f3f9e961e1a2d8a86`.

## Original files

Ported through local adapters. Shared chat files were not edited.

| Original | Use |
| --- | --- |
| `apps/ui/components/chat/SubRunTree.tsx` | Ordered branches, live last-3 calls, `+N earlier`, skeleton, settled outcome, Stop control. Matches the pin. |
| `apps/ui/components/chat/SubRunBlock.tsx` | `delegate_tasks` headline row, open while live, fold when live ends, elapsed slot, error and output sections. Matches the pin. |
| `apps/ui/components/chat/StepRow.tsx` | `StepGlyph` only. The current file adds `aria-expanded` on the step button versus the pin. The glyph is unchanged. Dense rows use the current `StepRow`. |
| `apps/ui/components/chat/ElapsedTime.tsx` | Header clock only while a snapshot task is `queued` or `running`. A saved row that mounts settled renders no clock. |
| `packages/contracts/src/chat-sub-runs.ts` | `subRunHeadline`, `subRunOutcome`, `isSubRunLive`, `isSubRunFailing`, `isSubRunStalled`. Matches the pin. Headline tool name is `delegate_tasks`. |
| `apps/ui/components/chat/MessageView.tsx` | Hosted Stop calls `cancelSubRunAction` when no override is passed (around the `onStopTask` assignment in `MessageViewInner`). Desktop must not call that action. |

Intentional difference: `SubRunTree` sets `stopRequested` and leaves the button disabled after one click. `DesktopDelegationTree` disables that button only while its request is in flight, then enables it again if the attempt fails.

## D contract

E does not declare `DesktopDelegationSnapshot`. Imports are type-only, from D's source file:

- `apps/ui/lib/desktop/delegation-client.ts` imports `../../../../packages/contracts/src/desktop-delegation`
- `apps/ui/components/desktop/delegation/task-view.ts`, `DesktopDelegationTree.tsx`, `DesktopDelegationBlock.tsx`, and `DesktopDelegationMount.tsx` import `../../../../../packages/contracts/src/desktop-delegation`

That file is not on this branch. Typecheck of these imports fails until root lands D's `packages/contracts/src/desktop-delegation.ts`. Do not copy the type into E. After it is present, the relative import resolves without a package rebuild. Root may also add this to `packages/contracts/src/index.ts` and switch callers later:

```ts
export * from './desktop-delegation.js'
```

D's shape used here: `{delegationId, revision, parentAgentId, parentSessionId, parentRunId, toolCallId, tasks}`. Each task uses `taskId` (mapped to `SubRunTask.id` for display only), `title`, `status`, `steps`, `toolCalls`, `failures`, `preview`, `calls`, `cleanup`, and optional `result`, `error`, `activity`, `idleMs`, `startedAt`, `finishedAt`. Unknown extra fields are ignored. A list or snapshot that fails the read is rejected whole. Nothing is filled in.

Read bounds, above D's current limits (`workers` 4, `tasks` 32, calls kept at 8, preview 600): more than 64 tasks, 32 calls on one task, or 8000 characters of preview, result, or error is unreadable. Raise the constants in `delegation-client.ts` if D legitimately exceeds them. The UI does not enforce the four-worker ceiling.

## Exported surface

From `apps/ui/components/desktop/delegation/index.ts`:

- `DesktopDelegationMount`, `DesktopDelegationBlock`, `DesktopDelegationTree`
- `DESKTOP_DELEGATION_POLL_MS` (3000)
- `delegationTaskToSubRun`, `delegationOutcome`, `delegationDetail`
- `DELEGATION_EMPTY_RESULT`, `DELEGATION_OUTCOME_UNREAD`
- `createDesktopDelegationClient`, `delegationUrl`, `projectDelegations`, `readDelegationList`, `readDelegationSnapshot`, `visibleDelegations`
- `DesktopDelegationReadError` with `kind: 'unavailable' | 'malformed' | 'unfinished'`
- `DELEGATION_LIST_UNAVAILABLE`, `DELEGATION_LIST_UNREADABLE`, `DELEGATION_STOP_UNAVAILABLE`, `DELEGATION_STOP_UNFINISHED`, `DELEGATION_UNREADABLE`

`projectDelegations(value, filter)` reads the GET shape `{delegations}` and then applies `visibleDelegations`. It throws `Delegated tasks could not be read.` on a bad shape. It does not post.

## What the UI does

`DesktopDelegationMount` reads `GET /api/desktop/sessions/{sessionId}/delegation` (`{delegations: Snapshot[]}`) and posts `{operation:'stop-task', requestId, delegationId, taskId, expectedRevision}`. The response used on success is `{delegation: Snapshot}`. Both calls are `cache: 'no-store'`, `credentials: 'same-origin'`, `redirect: 'error'`. List deadline 20s. Stop deadline 120s.

The mount root sets `data-state` to `loading`, `empty`, `unavailable`, `malformed`, or `ready`, and `data-view` to `live` or `history`.

- `loading`: the first read for this parent is still in flight. The fallback stays. No success headline is drawn.
- `empty`: the read succeeded and no row matches this parent. The fallback stays. No tasks are invented.
- `unavailable`: HTTP, network, or timeout. Message `Delegated tasks could not be loaded.` Retry is a GET.
- `malformed`: the list or a supplied projection failed the reader. Message `Delegated tasks could not be read.` Retry is a GET.
- `ready`: at least one matching snapshot is shown.

A later failed read keeps the last good rows and shows the banner. An empty successful read does not keep those rows: the server list is the live authority when no transcript is supplied.

`view` defaults to `live`. Historical messages must pass `view="history"`. History performs one GET, does not poll, and does not mount the header clock. Live polls every 3000ms only while `followLive` is set or a visible task is `queued` or `running`. `useVisibleInterval` stops that timer while the document is hidden and on unmount. Hiding the tab also aborts the in-flight GET. Showing it again reads once if the live view is selected, or if history still has no row and no transcript. Events that disappear between polls are not reconstructed.

`projection` is a transcript in the GET shape. `parentSnapshots` is a root-supplied list. Either one is applied without POST. It wins over a GET that started earlier. History does not let a later GET replace a supplied transcript, so a cleaned runtime cannot blank a saved result. A bad projection is `malformed`, not an empty success. Passing neither leaves the GET in charge.

Same page, same `delegationId` + `taskId` + `expectedRevision`, reuses one `requestId` (`crypto.randomUUID`), including after a failed response. A new revision is a new id. The map is in memory for the page. It is not stored on disk. After a full app restart a new id is sent. D must keep that from re-executing a settled task. This UI does not retry execution itself and does not post Stop on mount.

Stop does not mark a task stopped before the response. The returned snapshot is applied only when this mount is still alive, the click generation is still current, the parent filter is unchanged, and the snapshot's delegation, session, agent (when passed), run (when passed), tool call (when passed), and task id match that click. Otherwise the response is ignored. A non-OK response throws the server `error` string when it is present. The button for that task is enabled again. The mount then re-reads the list before the button shows the failure. A 409 does not paint a stopped state by itself. A Stop body that parses but names another session is rejected by the client.

The button is shown for a `running` task, for any task with `cleanup: 'blocked'`, and for `stopped` while cleanup is not `complete`. A `queued` task has no button unless its cleanup is already `blocked`, matching `SubRunTree` for the normal case. `done` and `error` hide it once cleanup is `complete`. Only the clicked button is disabled, and only while that request is in flight. Collapse and unmount do not post.

## Root wiring

Do not mount a second engine. D owns the route, runtime, grant, and store. Suggested mount, in the client `DesktopAssistantReply` loop, instead of `DesktopToolStep` when the tool is `delegate_tasks`. `DesktopConversation` already has `sessionId` and `activeRunId`; pass `sessionId` down. Do not pass `activeRunId` as `parentRunId` on older messages. That id is not those messages' delegation run, and the filter would hide saved tasks.

```tsx
import { getToolName, isToolUIPart } from 'ai'
import { stripBridgePrefix } from '@rerun/contracts'
import { DesktopDelegationMount } from '@/components/desktop/delegation/DesktopDelegationMount'
import { projectDelegations } from '@/lib/desktop/delegation-client'
import { DesktopToolStep } from '@/components/desktop/DesktopToolStep'

// DesktopAssistantReply gains sessionId: string.
// streaming: this part belongs to the open turn.
// savedProjection: {delegations} copied from the transcript for this tool call, or undefined.
// parentSnapshots: the newest DesktopDelegationSnapshot[] root already holds for a parent Stop.
// Inside the tool part branch:
if (stripBridgePrefix(getToolName(part)) === 'delegate_tasks') {
    blocks.push(
        <DesktopDelegationMount
            key={part.toolCallId}
            sessionId={sessionId}
            agentId={agentId}
            toolCallId={part.toolCallId}
            view={streaming ? 'live' : 'history'}
            followLive={streaming}
            projection={streaming ? undefined : savedProjection}
            parentSnapshots={streaming ? parentSnapshots : undefined}
            output={part.state === 'output-available' ? part.output : undefined}
            errorText={part.errorText}
            fallback={<DesktopToolStep part={part} restored={message.id.startsWith('engine-')} />}
        />,
    )
    continue
}
```

`projectDelegations(savedProjection, { sessionId, agentId, toolCallId })` is the same filter the mount applies. Root can call it while rebuilding history. Do not pass `activeRunId` into that filter for an older message.

A parent Stop that root already applied should arrive as `parentSnapshots` (or a new `projection`) for every mounted `delegate_tasks` row of that parent. The mount updates the matching rows and does not post Stop again. Board selection, chat scroll, drafts, and other subscriptions are untouched.

`DesktopConversation` call site to extend:

```tsx
<DesktopAssistantReply
    sessionId={sessionId}
    agent={agent}
    message={message}
    agentId={agent.id}
    streaming={status === 'streaming' && messageIndex === transcript.length - 1}
/>
```

Each mounted tool call reads the session list and keeps the row whose `toolCallId` matches. A historical row GETs once and does not poll. A live row polls on its own while it is open. One mount without `toolCallId` can show every delegation in the session. `parentRunId` filters only when passed.

`data-state="loading"`, `"empty"`, `"unavailable"`, and `"malformed"` keep `fallback` and do not invent a done headline. A later successful read replaces the fallback. A later failed read keeps the last good rows and shows Retry. A later empty live read clears them.

`call_agent` and `build_team` stay out of this mount. Coworker-call UI is lane B.

## Durable and restart behavior

The component stores nothing. After restart, history mounts with `view="history"` and the transcript `projection` when root has one, and still performs one GET. If the projection is present, the GET does not replace it. D's reconcile turns leftover `queued` / `running` tasks into `error` with `Interrupted by restart; task was not replayed` and sets `finishedAt`. The branch then shows that error string. It does not show a live skeleton, shimmer, or idle badge unless `calls[].elapsedMs`, `activity`, or `idleMs` is actually on the snapshot. D does not send those on the reconcile path. Mount does not replay Stop.

Duration text uses original `formatElapsed` only when both `startedAt` and `finishedAt` are numbers. The headline duration uses original `subRunDurationSeconds`, which is omitted when no task has a start or no task has a finish. Missing timestamps stay missing in `delegationTaskToSubRun`. `result` is not copied into `preview`. A saved result with an empty preview is shown from `result` in the outcome line and the expanded detail. Settled success text is `subRunOutcome(preview)`, or `subRunOutcome(result)` when the preview is empty. An explicit empty `result` on a `done` task uses D's phrase `(the sub-coworker returned no text)` from `orderedDelegationResult` in D's `apps/engine/src/desktop/delegation/runtime.ts`. A `done` task with neither preview nor `result` is `data-outcome="reconcile"` and says `Delegated tasks could not be read.` Queued with no `startedAt` stays the clock row and has no duration. Stopped text is `Stopped, partial work kept` even if `error` is also set. Error text is `task.error` or `Failed`. Partial text stays in the expanded `ScrollFade` after the ephemeral workspace is gone, because it is on the snapshot, not read from disk.

The header clock is `ElapsedTime` only when `view="live"`. `useElapsed` (`packages/ui/src/primitives/use-elapsed.ts`) returns nothing until it has run, ticks while `active` is true, and clears its interval when `active` becomes false, keeping the frozen value. History never mounts it. A live row that settles stops that tick; the branch duration is the saved timestamps or nothing.

A stopped task counts on the failed side of the original headline (`1 done · 1 failed`). The branch itself still says stopped.

Original activity fallback sets `elapsedMs` to `idleMs ?? 0`, which would shimmer a call that was never timed. This adapter sets `elapsedMs` only when `idleMs` was saved.

## Feature matrix

| Feature | State | Notes |
| --- | --- | --- |
| D's `DesktopDelegationSnapshot` and task fields, no second schema | Dependent | Type-only relative import. Fails typecheck until root lands D's file. |
| Public parent agent, session, run, tool call, and delegation id on each block | Implemented | `data-*` attributes. `parentRunId` filters only when passed. |
| GET list and POST `stop-task` | Implemented | Route mount is D and root. |
| Loading, empty, unavailable, malformed, retry | Implemented | `data-state` on the mount. Retry is GET. |
| Live poll only while that view is open or a task is queued or running | Implemented | History does not poll. Hidden tab aborts the GET and stops the timer. |
| Stale GET cannot replace a newer parent snapshot or another tool call | Implemented | Epoch plus a write counter. History keeps a supplied transcript. |
| Ordered branches, tones, dense row, expand and collapse | Implemented | Request order. Unfinished siblings stay visible. |
| Recorded counts, failures, last 3 calls, `+N earlier` | Implemented | No `idleMs ?? 0` shimmer. |
| Live elapsed stops when the snapshot settles | Implemented | Header clock is live-only. History uses both timestamps or omits duration. |
| Ordered result, error, cancel, partial text | Implemented | Detail is preview, or `result` when preview is empty. |
| Never started, restart interruption, empty result, missing outcome | Implemented | Queued clock; D's restart string; D's empty-result phrase; reconcile line. |
| Acknowledged per-task Stop, retryable failure, no permanent latch | Implemented | Late or foreign responses are not applied. |
| Parent Stop updates rows without another POST | Implemented | Pass `parentSnapshots` or `projection`. |
| Unmount, collapse, and identity change do not stop workers | Implemented | They abort reads only. |
| Restart history from GET plus transcript | Dependent | Root must pass `view="history"` and the projection. D must reconcile. |
| Chat mount in `DesktopAssistantReply` | Dependent | Snippet above. This lane did not edit that file. |
| Default-off grant, four workers, cleanup, admission | Dependent | D and root. This UI does not draw cleanup or enforce the ceiling. |
| Streamed progress inside the 3s gap | Unsupported | Poll only. A call that starts and ends inside the gap never appears. |
| Stop a `queued` task whose cleanup is `pending` | Unsupported | Same as `SubRunTree` until cleanup is `blocked`. |
| Stop request id across an app restart | Unsupported | The map is memory only. D must ignore a new id on a settled task. |
| Group headline recount when one `done` task has no stored outcome | Unsupported | The branch shows reconcile. `subRunHeadline` still counts `done`. |

## Unsupported and not verified

- This branch cannot typecheck until D's contract file is in the tree.
- Tests in `apps/ui/components/desktop/delegation/*.test.ts` and `*.test.tsx` were authored and not executed.
- No browser, Mac, or restart pass. Root runs those.
- A queued task cannot be stopped from this control unless its cleanup is already `blocked`.
- Cleanup is not drawn. `blocked` only keeps the Stop button so the same POST can be retried.
- The in-memory Stop id does not survive an app restart. A repeated Stop after restart uses a new id.
- If Stop's follow-up GET fails, the on-screen revision can stay until Retry. The button stays enabled. The task is not painted stopped unless a snapshot says so.
- `ToolOutput` still truncates a root-supplied tool `output` at 2000 characters. Delegation preview uses the original `ScrollFade` (`max-h-40`) and is not that truncation.
- Narrow layout still hides the failure and idle badges below `@md`, same as `SubRunTree`. That container query was not measured here.
- `ElapsedTime` keeps its frozen seconds after a live row settles, because that is `useElapsed`. History does not mount it. This lane did not edit `ElapsedTime`.
- Default-off delegation grant, route mounting, admission, and child isolation are D and root. An empty GET with no transcript shows the fallback tool step.
