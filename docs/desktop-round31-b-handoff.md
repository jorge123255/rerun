# Round 31 lane B — persistent coworker-call UI

## Scope and source references

Implemented only the lane-B owned UI/client paths. The port uses the original source at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/chat/SubRunBlock.tsx`: original `call_agent` headline, live/settled status, elapsed slot, dense settled row and expandable details.
- `apps/ui/components/chat/SubRunTree.tsx`: original task branch, queued/running/settled glyphs, progress calls, outcome text and running-task Stop placement.
- `packages/contracts/src/chat-sub-runs.ts`: canonical `SubRunProgress`, `SubRunTask`, `SubRunCall`, `isSubRunLive` and `subRunHeadline` behavior. There is no separate original `CallAgentBlock` export; `SubRunBlock` with `kind: 'call-agent'` is the original equivalent.
- `apps/ui/components/chat/MessageView.tsx`: original live standalone versus settled dense presentation.
- `apps/ui/components/foreman/ForemanNextSteps.tsx`: original `Open chat` label and exact-agent/exact-session navigation pattern.

A’s canonical snapshot is imported with TypeScript `import type` directly from `packages/contracts/src/desktop-coworker-calls.ts` through `apps/ui/lib/desktop/coworker-calls-client.ts`. That A file did not yet exist in this lane or A’s worktree when this handoff was written. It is an explicit integration dependency, not a license to create a parallel type.

`apps/ui/AGENTS.md` asks for installed Next.js guides under `node_modules/next/dist/docs/`. Neither this worktree nor the primary checkout has that directory. No dependency installation was attempted, per lane rules.

## UI and client behavior

- `DesktopCoworkerCalls` polls the canonical GET route every 3 seconds while active and visible. Inactive/hidden owners do not issue reads; owner changes invalidate retained callbacks and old responses; unmount aborts reads, removes the interval and disposes the client.
- Server order is preserved. Calls are filtered again by exact parent agent/session before display. No completion is inferred from a stream closing.
- `DesktopCoworkerCallBlock` maps the persistent snapshot into one original `SubRunProgress` and renders the original `SubRunBlock`. Live calls are standalone; settled calls are dense. Waiting-human remains live and adds `Waiting for you in <name>’s chat.` Completed, dispatched, error, cancelled and interrupted states remain available from durable snapshots.
- Snapshot `createdAt`/`updatedAt` are not converted into start/finish timings. The canonical payload does not establish actual execution start/end, so restored calls do not show fabricated durations, idle times, current-call elapsed values or lost events.
- Stop is the original `SubRunTree` running-task adapter. It sends only `{operation:'stop',requestId,callId,expectedRevision}` to the parent session’s route. A retry of the same revision reuses the request ID. A failed Stop remounts the original branch so its button is retryable. The server remains the authorization boundary.
- `Open chat` performs a fresh GET and verifies call ID, parent agent/session/run, tool-call ID and target agent. It invokes the injected callback only with the fresh server-returned `{agentId,sessionId}`. Missing, replaced or unassigned targets fail without opening a latest-chat fallback.
- Long status/error text wraps, the block retains `min-w-0`/`w-full`, and the original container-query/truncation behavior is unchanged. Narrow, short and installed-app layouts were not visually exercised in this lane.

Status mapping: `queued → queued`; `running` and `waiting-human → running`; `dispatched → dispatched`; `completed → done`; `error`, `cancelled` and `interrupted → error`. Cancelled/interrupted use explicit `Call cancelled.` / `Call interrupted.` outcomes so the original settled headline cannot incorrectly announce an answer.

## Required root integration

1. Integrate A’s `packages/contracts/src/desktop-coworker-calls.ts` and canonical route before typechecking this lane. Root may additionally export the type from `@rerun/contracts`; the lane’s source-path import can then be changed centrally if desired.
2. Mount `DesktopCoworkerCalls` once in `DesktopConversation`’s `ConversationContent`, after the transcript rows and before the browser/request cards. Pass the exact current parent agent/session. Do not mount one poller per tool part.
3. Thread an asynchronous exact-target callback from `DesktopApp` through `CoworkerChat` and `DesktopChatTabs` into `DesktopConversation`. Root owns those files; no lane changes were made to them.
4. Keep A’s server-side owner/run/tool-call/revision/grant checks. This client is not an authorization grant.

Typed mount fragment:

```tsx
import { DesktopCoworkerCalls } from './coworker-calls/DesktopCoworkerCalls'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'

// DesktopConversation props:
onOpenCoworkerCallTarget?: (target: DesktopCoworkerCallOpenTarget) => Promise<void>

// Inside ConversationContent, after transcript.map(...):
{sessionId && <DesktopCoworkerCalls
    agentId={agent.id}
    sessionId={sessionId}
    active={active}
    onOpenTarget={onOpenCoworkerCallTarget}
/>}
```

Typed root navigation fragment, using root’s existing exact-session request path:

```tsx
async function openCoworkerCallTarget(target: DesktopCoworkerCallOpenTarget): Promise<void> {
    if (controlCenterDisabled || isDesktopQuitting()) throw new Error('Navigation is currently unavailable.')
    if (!currentAgents.current.some(agent => agent.id === target.agentId)) throw new Error('This coworker is no longer available.')
    focusFromControlCenter(target.agentId)
    selectCoworker(target.agentId, target.sessionId)
}
```

Add the same callback type to `CoworkerChat` and `DesktopChatTabs` props and forward it unchanged. Root’s existing `requested={id: sessionId}` handling reports a missing session instead of selecting another chat; preserve that behavior.

For custom placement, `DesktopCoworkerCallBlock` accepts `{client,call,active,onOpenTarget,onChange}`. `onChange` is required to expose Stop: it must replace the acknowledged snapshot in the owning `useDesktopCoworkerCalls` controller (`controller.replace`). The standard mount already does this.

## Durable/restart behavior and limits

- Durable snapshots are re-read after reload; no browser-local call state is authoritative.
- Dispatched calls retain their independent target lifecycle. The UI does not cancel a parent run or infer child completion from parent status.
- Waiting-human navigation opens the actual target chat. Root/A must still provide the target’s existing attention/request flow; this lane does not answer pending requests.
- Queued calls deliberately have no Stop button because original `SubRunTree` offers Stop only for a running task. Running and waiting-human calls expose it when the parent supplies `onChange`.
- The minimum canonical snapshot has no dedicated error field. Error/cancelled/interrupted detail uses `progress.preview` where available and an explicit generic reason otherwise.
- No visual QA, responsive runtime QA, tests, typecheck, lint, build, server, live API, packaging or installed-app acceptance was performed. The added Vitest sources are unexecuted and must not be treated as passing.

## Changed files

- `apps/ui/lib/desktop/coworker-calls-client.ts`
- `apps/ui/components/desktop/coworker-calls/coworker-call-progress.ts`
- `apps/ui/components/desktop/coworker-calls/DesktopCoworkerCallBlock.tsx`
- `apps/ui/components/desktop/coworker-calls/DesktopCoworkerCalls.tsx`
- `apps/ui/components/desktop/coworker-calls/useDesktopCoworkerCalls.ts`
- `apps/ui/components/desktop/coworker-calls/coworker-call-progress.test.ts`
- `apps/ui/components/desktop/coworker-calls/coworker-calls-client.test.ts`
- `apps/ui/components/desktop/coworker-calls/DesktopCoworkerCallBlock.test.tsx`
- `apps/ui/components/desktop/coworker-calls/DesktopCoworkerCalls.test.tsx`
- `docs/desktop-round31-b-handoff.md`

Root should run the focused coworker-call Vitest sources, the UI typecheck/lint and integration tests after adding A and the wiring above. Root owns all discovered repairs and acceptance.
