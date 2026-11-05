# Round 31 lane B — persistent coworker-call UI

Source handoff only. This continues commit `c593a4225502053b17633343f758872e9b7d8454`; it does not reset that work. Root integration, checks and native acceptance remain pending.

## Original mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/chat/SubRunBlock.tsx` — `call_agent` headline, live expansion, settled dense row and output/error sections. There is no separate `CallAgentBlock` at this pin.
- `apps/ui/components/chat/SubRunTree.tsx` — task glyph/order, queued/running/settled presentation, three visible live calls plus overflow, outcome text and running-task Stop.
- `apps/ui/components/chat/StepRow.tsx` — folded dense details and responsive truncation.
- `apps/ui/components/chat/ToolCallBlock.tsx` — tool status, folded output/error presentation.
- `apps/ui/lib/chat/sub-run-progress.ts` and `packages/contracts/src/chat-sub-runs.ts` — original status, headline, outcome and exact tool-pairing helpers.
- `apps/engine/src/tools/builtin/call-agent.ts` — default independent dispatch versus waited answer, progress order and target-session semantics.

`DesktopCoworkerSubRunBlock` preserves the original block/tree/row behavior and adds only a `liveElapsed` switch. Restored snapshots never start a new elapsed timer; only the exact current live parent run gets one.

## A dependency and exported surface

A’s canonical contract is commit `5847b73a9f415cd2657d210fb8824d9ddba14435`, `packages/contracts/src/desktop-coworker-calls.ts`. The client imports its schemas and snapshot type directly; no duplicate browser schema exists. A’s GET/POST routes remain the only call and Stop authority.

Exports from `apps/ui/lib/desktop/coworker-calls-client.ts`:

- `createDesktopCoworkerCallsClient(parentAgentId, parentSessionId)` → `{list, stop, openTarget, dispose}`.
- `DesktopCoworkerCallStopError` with optional authoritative `call` for revision/completion races.
- `DesktopCoworkerCallSnapshot` and `DesktopCoworkerCallOpenTarget` types.

Exports from `apps/ui/components/desktop/coworker-calls/`:

- `DesktopCoworkerCalls` — standard single-poller mount with `{agentId,sessionId,active,currentRunId,currentRunActive,onOpenTarget}`.
- `DesktopCoworkerCallBlock` — custom placement with `{client,call,active,live,onOpenTarget,onChange}`. `onChange` is required to expose Stop.
- `useDesktopCoworkerCalls(agentId,sessionId,active,observing)` and `DESKTOP_COWORKER_CALLS_POLL_MS`.
- `desktopCoworkerCallProgress`, `desktopCoworkerCallState`, `isDesktopCoworkerCallLive`, `needsDesktopCoworkerCallUpdates`, and `desktopCoworkerCallForTool`.
- `DesktopCoworkerSubRunBlock` for the elapsed-aware original presentation adapter.

## Implemented behavior

- GET responses have a 1 MiB byte cap, strict UTF-8/JSON parsing, A schema validation, 10-second deadline, and exact parent agent/session checks. Wrong-owner and malformed responses fail instead of becoming a valid empty result.
- Loading, failed/unavailable and valid empty states are distinct. Failed reads retain any prior valid calls and offer an explicit same-owner Retry.
- Empty and fully settled views stop both interval and reads. Queued, running, dispatched and waiting-human views poll every three seconds while active/visible. A current parent run can also force observation to discover newly reserved calls.
- Owner/session/visibility changes abort old reads and timers. Unmount disposes the client. Mount/read/close performs no POST or other mutation.
- Original labels and ordering are preserved: `Calling`, `Message sent`, answered/error meanings, dense settled rows, recent-call overflow, progress counts and output/error details. Cancelled and interrupted calls cannot be presented as answered.
- `desktopCoworkerCallForTool` pairs only exact parent agent/session/run/tool-call identity, including same-name targets. Recorded timestamps are not converted into fabricated execution durations or continuing idle timers.
- Open chat re-reads and verifies the complete call identity before invoking the callback with only fresh local `{agentId,sessionId}`. A null target chat shows `Target chat is being prepared…` and disables opening. Navigation failures remain retryable.
- Stop sends only `{operation:'stop',requestId,callId,expectedRevision}`. The same revision reuses its UUID after failure or unknown acknowledgement. A failed attempt becomes retryable; an authoritative `{call}` in a race response updates the view even when the response also carries an error.
- Dispatched children remain independent. Closing observation does not stop a child, infer completion, answer a pending human request or cancel the parent.

## Required root wiring

Mount once in `DesktopConversation`’s `ConversationContent`, after transcript rows and before other request/browser cards. Do not mount one poller per tool part. `activeRunId` already exists in the current desktop conversation; `busy` identifies the current live submission.

```tsx
import { DesktopCoworkerCalls } from './coworker-calls/DesktopCoworkerCalls'
import type { DesktopCoworkerCallOpenTarget } from '@/lib/desktop/coworker-calls-client'

// DesktopConversation prop:
onOpenCoworkerCallTarget?: (target: DesktopCoworkerCallOpenTarget) => Promise<void>

{sessionId && <DesktopCoworkerCalls
    agentId={agent.id}
    sessionId={sessionId}
    active={active}
    currentRunId={activeRunId}
    currentRunActive={busy}
    onOpenTarget={onOpenCoworkerCallTarget}
/>}
```

For a custom per-tool renderer, use the controller’s snapshots and the exact projector rather than title matching:

```tsx
const call = desktopCoworkerCallForTool(calls, {
    agentId: agent.id,
    sessionId,
    runId: trustedParentRunId,
    toolCallId: part.toolCallId,
})
```

Thread the asynchronous target callback from `DesktopApp` through `CoworkerChat` and `DesktopChatTabs` into `DesktopConversation`:

```tsx
async function openCoworkerCallTarget(target: DesktopCoworkerCallOpenTarget): Promise<void> {
    if (controlCenterDisabled || isDesktopQuitting()) throw new Error('Navigation is currently unavailable.')
    if (!currentAgents.current.some(agent => agent.id === target.agentId)) throw new Error('This coworker is no longer available.')
    focusFromControlCenter(target.agentId)
    selectCoworker(target.agentId, target.sessionId)
}
```

Root’s existing `requested={id: sessionId}` path must continue to report a missing session rather than selecting another chat. Root/A must also keep the target’s existing attention/request flow; this lane never answers it.

## Feature matrix

| Area | Status | Evidence or remaining dependency |
| --- | --- | --- |
| Strict bounded reads and owner isolation | Implemented in source | A’s canonical schemas, bounded reader, generation/disposal guards and regression cases |
| Original call presentation and progress | Implemented in source | Original SubRunBlock/Tree/StepRow adapter, all canonical statuses, overflow and previews |
| Exact tool pairing and same-name targets | Implemented in source | `desktopCoworkerCallForTool` plus fresh full-identity navigation check |
| Target adoption and navigation | UI implemented; root wiring dependent | Null-target disabled state; root supplies current-roster callback and exact existing session selection |
| Acknowledged Stop and completion races | Implemented in source; A route dependent | Stable request UUID, retryable failures and authoritative race snapshots |
| Live/current-run observation | Implemented in source; root props dependent | Empty/settled/hidden views stop; root supplies `currentRunId/currentRunActive` |
| Historical/restart rendering | Implemented in source | Durable snapshots and links; no fabricated elapsed/idle timing or automatic replay |
| Target human attention | Root/A dependent | This lane opens the actual target chat but never answers the request |
| Live elapsed timer | Implemented only for exact current run | No recorded execution start/end is inferred from `createdAt/updatedAt` |
| Responsive/native/board acceptance | Root dependent | Narrow/short layouts retain original wrapping/truncation but were not visually exercised |
| New grants, dispatch, chat creation or replay | Unsupported here | A/root retain all authority and lifecycle |

## Authored, unexecuted regressions

- `coworker-calls-client.test.ts`: strict empty/populated reads, wrong owner/chat and malformed responses, exact Stop payload/UUID reuse, completion race, fresh target validation, same-name targets, missing/replaced targets, disposal and no mutation.
- `coworker-call-progress.test.ts`: every status mapping, progress/error details, no restored durations, exact same-title pairing and settled-versus-active polling.
- `DesktopCoworkerCallBlock.test.tsx`: original live/settled presentation, waiting-human, missing-target disabled state, Open chat, Stop failure/retry/lost acknowledgement, completion race and live-only elapsed.
- `DesktopCoworkerCalls.test.tsx`: active/visible polling, empty and settled timer/read shutdown, loading versus empty, stale owner reads, retry and unmount with no mutation.

No tests, typecheck, lint, build, dependency installation, server, live provider/API call, UI action, packaging, Docker, Keychain or native/restart acceptance was performed. The installed Next.js documentation directory was absent from this worktree. Root must run all checks and repair any defects; no checklist completion or product acceptance is claimed.
