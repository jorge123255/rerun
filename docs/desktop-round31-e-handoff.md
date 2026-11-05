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

## What the UI does

`DesktopDelegationMount` reads `GET /api/desktop/sessions/{sessionId}/delegation` (`{delegations: Snapshot[]}`) and posts `{operation:'stop-task', requestId, delegationId, taskId, expectedRevision}`. The response used on success is `{delegation: Snapshot}`. Both calls are `cache: 'no-store'`, `credentials: 'same-origin'`, `redirect: 'error'`.

Same page, same `delegationId` + `taskId` + `expectedRevision`, reuses one `requestId` (`crypto.randomUUID`), including after a failed response. A new revision is a new id. The map is in memory for the page. It is not stored on disk. After a full app restart a new id is sent. D must keep that from re-executing a settled task; this UI does not retry execution itself.

Stop does not mark a task stopped before the response. A non-OK response throws the server `error` string when it is present (`Delegation unavailable or changed. Refresh and retry Stop.` from D's route). The button is enabled again. The mount then re-reads the list. A 409 does not paint a stopped state by itself.

The button is shown for a `running` task, for any task with `cleanup: 'blocked'`, and for `stopped` while cleanup is not `complete`. A Stop that persisted `stopped` and then failed cleanup can be posted again. A `queued` task has no button unless its cleanup is already `blocked`, matching `SubRunTree` for the normal case. `done` and `error` hide it once cleanup is `complete`.

Live rows poll every 3000ms while `followLive` is set or any visible task is `queued` or `running`. `useVisibleInterval` stops that poll while the document is hidden and on unmount. Settled history is one read, then idle. Events that disappear between polls are not reconstructed.

## Root wiring

Do not mount a second engine. D owns the route, runtime, grant, and store. Suggested mount, in the client `DesktopAssistantReply` loop, instead of `DesktopToolStep` when the tool is `delegate_tasks`. `DesktopConversation` already has `sessionId` and `activeRunId`; pass `sessionId` down. Do not pass `activeRunId` as `parentRunId` on older messages. That id is not those messages' delegation run, and the filter would hide saved tasks.

```tsx
import { getToolName, isToolUIPart } from 'ai'
import { stripBridgePrefix } from '@rerun/contracts'
import { DesktopDelegationMount } from '@/components/desktop/delegation/DesktopDelegationMount'
import { DesktopToolStep } from '@/components/desktop/DesktopToolStep'

// DesktopAssistantReply gains sessionId: string.
// Inside the tool part branch:
if (stripBridgePrefix(getToolName(part)) === 'delegate_tasks') {
    blocks.push(
        <DesktopDelegationMount
            key={part.toolCallId}
            sessionId={sessionId}
            agentId={agentId}
            toolCallId={part.toolCallId}
            followLive={live}
            output={part.state === 'output-available' ? part.output : undefined}
            errorText={part.errorText}
            fallback={<DesktopToolStep part={part} restored={message.id.startsWith('engine-')} />}
        />,
    )
    continue
}
```

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

Each mounted tool call reads the session list and keeps the row whose `toolCallId` matches. Several historical `delegate_tasks` rows therefore each GET once. A session-level mount without `toolCallId` is supported if root would rather share one poll. `parentRunId` filters only when passed.

While the list is empty or unreadable, `fallback` stays visible and no task rows are invented. A later successful read replaces the fallback. The last good list is kept when a later read fails.

`call_agent` and `build_team` stay out of this mount. Coworker-call UI is lane B.

## Durable and restart behavior

The component stores nothing. After restart it shows whatever GET returns. D's reconcile turns leftover `queued` / `running` tasks into `error` with `Interrupted by restart; task was not replayed` and sets `finishedAt`. The branch then shows that error string. It does not show a live skeleton, shimmer, or idle badge unless `calls[].elapsedMs`, `activity`, or `idleMs` is actually on the snapshot. D does not send those on the reconcile path.

Duration text uses original `formatElapsed` only when both `startedAt` and `finishedAt` are numbers. The headline duration uses original `subRunDurationSeconds`, which is omitted when no task has a start or no task has a finish. Missing timestamps stay missing in `delegationTaskToSubRun`. `result` is not copied into `preview`. Settled success text is `subRunOutcome(preview)`. Stopped text is `Stopped, partial work kept` even if `error` is also set. Error text is `task.error` or `Failed`.

A stopped task counts on the failed side of the original headline (`1 done · 1 failed`). The branch itself still says stopped.

Original activity fallback sets `elapsedMs` to `idleMs ?? 0`, which would shimmer a call that was never timed. This adapter sets `elapsedMs` only when `idleMs` was saved.

## Unsupported and not verified

- This branch cannot typecheck until D's contract file is in the tree.
- Tests in `apps/ui/components/desktop/delegation/*.test.ts` and `*.test.tsx` were not executed.
- No browser, Mac, or restart pass.
- Progress is polled, not streamed. A call that starts and ends inside the 3s gap never appears.
- A queued task cannot be stopped from this control unless its cleanup is already `blocked`.
- Cleanup is not drawn. `blocked` only keeps the Stop button so the same POST can be retried.
- The in-memory Stop id does not survive an app restart. A repeated Stop after restart uses a new id.
- If Stop mutates the revision and the follow-up GET fails, the on-screen revision can be stale until Retry. The button stays enabled.
- `ToolOutput` still truncates a root-supplied tool `output` at 2000 characters. Delegation preview uses the original `ScrollFade` (`max-h-40`) and is not that truncation.
- Narrow layout still hides the failure and idle badges below `@md`, same as `SubRunTree`. That container query was not measured here.
- Default-off delegation grant, route mounting, admission, and child isolation are D and root. An empty GET shows the fallback tool step.
