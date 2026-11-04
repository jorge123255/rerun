# Desktop suggested replies integration handoff

## Assigned implementation

- `apps/ui/components/desktop/DesktopQuickReplies.tsx` renders the original `Suggestions`/`Suggestion` presentation. It accepts `message`, `show`, `disabled`, `pending`, and an injected `onSend(text): Promise<boolean>`.
- `apps/ui/lib/desktop/quick-replies.ts` exposes `desktopQuickRepliesOf(message)` for live or saved messages, `desktopQuickReplyInputOf(part)` for the history adapter, and the `DesktopQuickReplySend` callback type. Both helpers use the original validation and bridge-alias handling. Only validated labels or `{ replies }` leave the helper. `Suggestion` renders labels as React text, not HTML.

## `onSend` callback contract

`onSend` must resolve `true` only when the transport accepted the send — meaning the engine admitted the turn (HTTP accepted), not merely that `sendMessage` settled. Resolve `false` for every other outcome: a guard blocked the click, the transport recorded a failed response, or the request never reached the server. The AI SDK's `sendMessage` records network/HTTP failures in the `error` state without rejecting, and a guard early-return also fulfills the callback, so the component cannot infer admission from a resolved promise alone. A rejected promise or a synchronous throw releases the latch exactly like `false`.

Each click creates an activation token scoped to the message identity and a per-component generation counter. The latch state and the in-flight ref only change when the settling token is still current, so a late resolve or reject from an older message's callback never unlatches a newer message's activation. Synchronous duplicate clicks are still blocked by the ref before state flushes. When the message identity changes, the latch resets; a stale in-flight token is dropped on the next activation for the new message.

## `DesktopConversation.tsx` wiring

Import `DesktopQuickReplies`. Keep a pending flag for the injected callback plus a transport-side record that `sendToEngine` marks once it sees the response — this is the acceptance signal the boolean reports:

```tsx
const quickReplyPending = useRef(false)
const quickReplyRequest = useRef<{ accepted: boolean } | null>(null)
const quickReplyRequestIds = useRef(new Map<string, string>())
const [quickReplyBusy, setQuickReplyBusy] = useState(false)

// Inside sendToEngine, next to the existing pending/alternate/queued handling:
const quickReply = quickReplyRequest.current
// ...after `response` arrives:
if (quickReply) quickReply.accepted = response.ok

async function sendQuickReply(messageId: string, text: string): Promise<boolean> {
    if (quickReplyPending.current || !active || inactive || !ready || pendingHitl || pendingAlert
        || generating || stopping || !queue.loaded || queue.error || queue.pending || queue.queued || queue.restoredId
        || pendingAttachment.current || regenerating.current || flushingQueue.current
        || error || historyError || stopError || queueNotice) return false
    quickReplyPending.current = true
    setQuickReplyBusy(true)
    const key = JSON.stringify([sessionId, messageId, text])
    const requestId = quickReplyRequestIds.current.get(key) ?? crypto.randomUUID()
    quickReplyRequestIds.current.set(key, requestId)
    const request = { accepted: false }
    quickReplyRequest.current = request
    try {
        setLiveSessionId(null)
        setLiveRunId(null)
        const pick = !sessionId && conversationChoice.current?.session === null ? conversationChoice.current.pick : undefined
        await sendMessage({ text }, { body: {
            agentId: agent.id,
            sessionId: sessionId ?? undefined,
            requestId,
            ...(!sessionId && tabUid && { tabUid }),
            ...(pick && { modelChoice: pick }),
        } })
        return request.accepted
    } finally {
        quickReplyRequest.current = null
        quickReplyPending.current = false
        setQuickReplyBusy(false)
    }
}
```

Guards, in the order the port requires: the tab is `active`; the coworker is enabled (`!inactive`); history is `ready`; the pending-question state is known and clear (no `pendingHitl`/`pendingAlert`); no answer is in flight (`!generating`, which covers both the SDK stream and a reopened engine run); the queue is loaded with no error, pending action, or saved item (`queue.loaded`, `!queue.error`, `!queue.pending`, `!queue.queued`, `!queue.restoredId`); no pending attachment send (`!pendingAttachment.current`); no regeneration (`!regenerating.current`); no running reply being stopped (`!stopping`, `!flushingQueue.current`); and no existing error (`error`, `historyError`, `stopError`, `queueNotice` all clear).

`sendToEngine` already sees every response before the SDK does. Recording `response.ok` on the pending record is the only reliable acceptance signal — do not rely on `sendMessage` throwing or resolving. Reuse the queued-message convention: `body.requestId` is stored per suggestion key so a retap after a recorded failure repeats the same request ID and the engine's request deduplication applies; a retry can never double-send. Because `sendMessage` does not reject on failure, `quickReplyBusy` clears in `finally` while `request.accepted` still reports the admission the transport saw.

Do not set `pendingAttachment`, do not include `attachmentPath` or message `metadata`, and do not call `setInput` or `setDraftAttachment`. The send carries only the suggestion label; the existing text/file draft stays untouched and is not sent with the suggestion. Keep the first-chat model choice exactly as above.

Render through `DesktopAssistantReply` with props such as:

```tsx
quickReplies={{
    show: messageIndex === transcript.length - 1
        && active && !generating && !stopping && !pendingHitl && !pendingAlert
        && !error && !historyError && !stopError && !queue.error && !queueNotice,
    disabled: inactive || !ready || !modelReady || !queue.loaded || !!queue.queued || !!queue.restoredId || quickReplyBusy,
    pending: quickReplyBusy || queue.pending,
    onSend: text => sendQuickReply(message.id, text),
}}
```

Use the pending question/approval state added by the root. Requiring the last transcript index, rather than merely the last assistant index, hides chips after a subsequent user turn. `generating` covers both the SDK stream and a reopened engine run.

## `DesktopAssistantReply.tsx` wiring

Accept the `quickReplies` object shown above and render after `DesktopReplySources` and before the copy/regenerate/feedback actions, matching upstream placement:

```tsx
<DesktopReplySources parts={message.parts} />
{quickReplies && <DesktopQuickReplies message={message} {...quickReplies} />}
```

Suppress the generic tool row for all `suggest_replies` aliases before the ordinary `DesktopToolStep` branch:

```tsx
import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { desktopSourceParts, QUICK_REPLIES_TOOL, stripBridgePrefix, type MessageFeedbackRating } from '@rerun/contracts'
import { DesktopQuickReplies } from './DesktopQuickReplies'

// Inside the message.parts loop:
} else if (isToolUIPart(part)) {
    if (stripBridgePrefix(getToolName(part)) === QUICK_REPLIES_TOOL) continue
    blocks.push(<DesktopToolStep key={part.toolCallId} part={part} restored={message.id.startsWith('engine-')} />)
}
```

## `publicDesktopHistory` wiring

Handle quick replies before `desktopToolPresentation`, using `desktopQuickReplyInputOf`. Construct the public part explicitly so no stored output, transport metadata, or arbitrary fields pass through:

```tsx
import { desktopQuickReplyInputOf } from '@/lib/desktop/quick-replies'

// Inside publicDesktopHistory's parts.map, before the generic tool handling:
if (stripBridgePrefix(part.toolName) === QUICK_REPLIES_TOOL) {
    return {
        type: part.type,
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        desktopPreview: true as const,
        state: part.state,
        input: desktopQuickReplyInputOf(part) ?? {},
    }
}
```

`QUICK_REPLIES_TOOL` and `stripBridgePrefix` are already exported by `@rerun/contracts`. The special case covers `suggest_replies` plus original bridge aliases such as `mcp__rerun__suggest_replies`; it preserves only validated `{ replies }`. Without this special case, the generic presentation drops the saved labels.

## Catalog capability

The existing engine `quickReplies` family is already accurate: its build returns an empty tool map, while `config.tools.quickReplies` controls generation. Leave it and hosted callers unchanged. `suggest_replies` is synthetic output the engine emits, not a callable provider tool and not a new grant — do not add it to `desktopRerunToolCatalog`, desktop grants, or `desktopToolInstruction`, because those surfaces describe callable tools and would falsely tell the model it can invoke one. A Mac capability label, if shown, should say “Suggested replies” and describe presentation controlled by `tools.quickReplies`, not a grant.

## Mac adaptations and limits

- The visual component and validation are upstream. The Mac additions are explicit visibility/disabled inputs, duplicate-activation protection, and an injected send callback so the side panel can preserve its independent composer and queued drafts.
- Activation sends only the chosen label. It intentionally does not attach the composer's file or overwrite its text.
- `onSend` reports admission explicitly: resolve `true` when the transport accepted the send, `false` when a guard or the transport refused it. A resolved promise no longer implies acceptance, so a blocked or failed send re-enables the buttons instead of leaving a suggestion permanently disabled.
- Activations are scoped by message identity and a generation token. A stale resolve or reject — for example an older message's callback settling after the transcript moved on — cannot clear a newer message's latch or pending flag.
- The root still needs `DesktopConversation` acceptance tracking, `DesktopAssistantReply` props, the saved-history projection, settings/capability labels, and runtime integration, plus verification of real Codex output and restart persistence. No tests, typechecks, builds, live model calls, or runtime acceptance were run for this handoff.
