# Desktop suggested replies integration handoff

## Assigned implementation

- `apps/ui/components/desktop/DesktopQuickReplies.tsx` renders the original `Suggestions`/`Suggestion` presentation. It accepts `message`, `show`, `disabled`, `pending`, and an injected `onSend(text)`. A ref blocks a second synchronous activation; an async rejection or synchronous throw re-enables the buttons.
- `apps/ui/lib/desktop/quick-replies.ts` exposes `desktopQuickRepliesOf(message)` for live or saved messages and `desktopQuickReplyInputOf(part)` for the history adapter. Both use the original validation and bridge-alias handling. Only validated labels or `{ replies }` leave the helper. `Suggestion` renders labels as React text, not HTML.

The engine already owns generation and persistence: `tools.quickReplies` enables the capture, and the stream emits `suggest_replies`. Do not add a provider tool.

## `DesktopConversation.tsx` wiring

Import `DesktopQuickReplies`. Keep a pending state for the injected callback, with a ref for a synchronous guard. The callback must call `sendMessage` directly, not submit the composer form and not read or clear `input` or `attachment`:

```tsx
const quickReplyPending = useRef(false)
const [quickReplyBusy, setQuickReplyBusy] = useState(false)

async function sendQuickReply(text: string) {
    if (quickReplyPending.current || inactive || generating || stopping || !ready || !modelReady || queue.pending || queue.queued || regenerating.current) return
    quickReplyPending.current = true
    setQuickReplyBusy(true)
    try {
        setLiveSessionId(null)
        setLiveRunId(null)
        const pick = !sessionId && conversationChoice.current?.session === null ? conversationChoice.current.pick : undefined
        await sendMessage({ text }, { body: {
            agentId: agent.id,
            sessionId: sessionId ?? undefined,
            ...(!sessionId && tabUid && { tabUid }),
            ...(pick && { modelChoice: pick }),
        } })
    } finally {
        quickReplyPending.current = false
        setQuickReplyBusy(false)
    }
}
```

Do not set `pendingAttachment`, do not include `attachmentPath`, and do not call `setInput` or `setDraftAttachment`. The existing text/file draft therefore stays untouched and is not sent with the suggestion. Keep the first-chat model choice exactly as above.

Render through `DesktopAssistantReply` with props such as:

```tsx
quickReplies={{
    show: messageIndex === transcript.length - 1
        && !generating && !stopping && !pendingHitl && !pendingAlert
        && !error && !historyError && !stopError && !queue.error,
    disabled: inactive || !modelReady || !!queue.queued || quickReplyBusy,
    pending: quickReplyBusy || queue.pending,
    onSend: sendQuickReply,
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

The existing engine `quickReplies` family is already accurate: its build returns an empty tool map, while `config.tools.quickReplies` controls generation. Leave it and hosted callers unchanged. Do not add `suggest_replies` to `desktopRerunToolCatalog`, desktop grants, or `desktopToolInstruction`, because those surfaces describe callable tools and would falsely tell the model it can invoke one. A Mac capability label, if shown, should say “Suggested replies” and describe presentation controlled by `tools.quickReplies`, not a grant.

## Mac adaptations and limits

- The visual component and validation are upstream. The Mac additions are explicit visibility/disabled inputs, duplicate-activation protection, and an injected send callback so the side panel can preserve its independent composer and queued drafts.
- Activation sends only the chosen label. It intentionally does not attach the composer's file or overwrite its text.
- A void `onSend` keeps the component disabled until the transcript changes, preventing duplicate activation. A rejected async callback or synchronous throw allows retry.
- The root still needs to wire live/saved rendering and verify real Codex output and restart persistence. No tests, typechecks, builds, live model calls, or runtime acceptance were run for this handoff.
