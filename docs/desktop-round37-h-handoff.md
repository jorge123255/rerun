# Round 37 — Agent H handoff: chat recovery (C6/C8 delta)

Implementation commit: `df1792c0f479d3e217799802d4d8a585ad3bb992`
Base: `e87edabffded9b56c67f98539a412e230959435c` on `desktop/round37-chat-recovery`.
Original reference: Rerun fork `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (`upstream-review-20261106`, read-only).

**No checks executed and no installed acceptance.** Root owns review, fixes, all tests, typecheck, lint, builds, packaging, and board/full-restart Mac acceptance. This lane ran no test, typecheck, lint, build, install, server, provider/network call, or UI/screenshot tool.

## Changed files (all owned paths)

- `packages/contracts/src/chat-error.ts` — verbatim port of upstream `2a57fa6` (byte-identical): adds `thinking_replay`, `session_gone` kinds, `OPENCODE_CREDITS_USED_UP`, `OPENCODE_GO_LIMIT`, `MODEL_NOT_IN_PLAN`, `ENGINE_SESSION_NOT_FOUND`, `SESSION_NOT_FOUND`, `THINKING_REPLAY_REJECTED`, `errorMessageOf` comment fix.
- `packages/contracts/src/chat-error-copy.ts` — verbatim port of upstream `2a57fa6` (byte-identical): per-kind titles/copy incl. `thinking_replay` ("engine bug, not the model"), `session_gone` ("conversation unavailable… start a new conversation"), opencode plan limits.
- `apps/ui/lib/desktop/chat-recovery/controller.ts` — scoped recovery controller (pure TS): classification via `unwrapChatError`+`classifyChatError`, scope binding `{agentId, tabUid, sessionId, liveSessionId, runId, requestId}`, error generation counter, model-revision recording, kind-gated actions.
- `apps/ui/lib/desktop/chat-recovery/use-desktop-chat-recovery.ts` — React hook binding the controller to `useChat` error + failed-run poll; auto-clears when both sources empty; stale scope ⇒ `view()` null and `act()` no-op.
- `apps/ui/lib/desktop/chat-recovery/controller.test.ts` — 11 regressions: session_gone, envelope unwrap, run_in_flight/continue, thinking_replay retry-without-switch, usage_limit/unauthorized actions, cross-tab stale scope, late failed-run guard, generation stability, model-revision binding, canRetry gate, clear, scope-key coverage.
- `apps/ui/components/desktop/chat/recovery/DesktopProviderErrorNotice.tsx` — desktop port of upstream `ProviderErrorNotice` (newer revision): same action order (stop/new-conversation/continue → retry → switch → reconnect), same copy via `chatErrorTitle`/`friendlyError`, `NoticeActions` cells, `BorderBeam` header. Adds `agentId`/`sessionId` and an inline recovery model picker when no external `onSwitchModel` is wired.
- `apps/ui/components/desktop/chat/recovery/DesktopRecoveryModelPicker.tsx` — conversation-scoped model picker on the canonical `/api/desktop/agents/:id/model` GET/PATCH. Saved chats PATCH `{action:'conversation'}` only; unsent chats route picks through `onPicked` (pending `modelChoice`). Offers workspace-default/coworker-default follow options exactly like `DesktopModelSelector` (its `follow-workspace` PATCH is the same explicit coworker-default action the main picker performs). Deliberately omits the coworker-default star so a recovery notice cannot silently retarget the coworker default.
- `apps/ui/components/desktop/chat/recovery/DesktopProviderErrorNotice.test.tsx` — 6 component regressions incl. happy-dom mount, action dispatch, internal picker PATCH body assertion, and unsent-chat pending-pick path with zero PATCHes.

## Original → desktop mapping

| Upstream (`2a57fa6`) | Desktop port |
|---|---|
| `packages/contracts/src/chat-error{,-copy}.ts` | Same files, byte-identical |
| `apps/ui/components/chat/ProviderErrorNotice.tsx` (upstream rev: `session_gone`, `thinking_replay` retry, `onNewConversation`, opencode glyph) | `components/desktop/chat/recovery/DesktopProviderErrorNotice.tsx` |
| `requestModelPicker(uid)` store → chat model picker | `DesktopRecoveryModelPicker` on the canonical desktop model route, or root-wired `onSwitchModel` |
| `reconnectProvider` → `reconnectAiProvider`/providers dialog | `reconnectProvider` port → `onOpenModelSettings` (see fragments) |
| `onNewConversation` prop | `newConversation` port → `onSelectSession(null, 'New conversation')` via `openSessionTab` |
| `retryLastTurn` → `regenerate()` | `retryLastTurn` port → `regenerateReply()`/`regenerate` (canonical `regenerationRequestId`) |
| `continueInterruptedRun` → `sendMessage('Continue where you left off.')` | `continueRun` port → same text through desktop `sendMessage` |
| `handleStop` | `stopRun` port → existing `handleStop` (abort stream + engine cancel) |

Kind → action parity with upstream: `run_in_flight`→Stop; `session_gone`→New conversation; `interrupted`→Continue; `overloaded|generic|thinking_replay`→Retry; `usage_limit|provider_error|context_window|overloaded|generic`→Switch model; `unauthorized`→Reconnect. `budget` renders title+copy with no actions (upstream routes it to `BudgetExhaustedNotice`, which has no desktop equivalent — see limitations). `thinking_replay` is explicitly NOT offered a model switch, matching upstream copy ("switching models will not help").

## Root activation fragments

### 1. `apps/ui/lib/desktop/server/stop-turn.ts` — expose failed-run error text

`runSchema` already carries `error: z.string().nullable()` and `listRuns` returns it; one field is missing:

```ts
export async function readDesktopTurnRunning(runtime: DesktopRuntime, sessionId: string): Promise<{ running: boolean; runId: string | null; failedRunId: string | null; failedRunError: string | null }> {
    // ... unchanged target/running lookup ...
    const failed = owned.find(run => run.status === 'error')
    return { running: !!running, runId: running?.id ?? null, failedRunId: failed?.id ?? null, failedRunError: failed?.error ?? null }
}
```

(The GET route at `app/api/desktop/sessions/[sessionId]/stop/route.ts` already `Response.json`s the whole result — no route change needed.)

### 2. `DesktopConversation.tsx` — failedRunError state

```ts
const [engineRunning, setEngineRunning] = useState<{ id: string | null; running: boolean; runId?: string | null; failedRunId?: string | null; failedRunError?: string | null }>({ id: null, running: false })
// in check():
setEngineRunning({ id: sessionId, running, runId: ..., failedRunId: typeof body.failedRunId === 'string' ? body.failedRunId : null, failedRunError: typeof body.failedRunError === 'string' ? body.failedRunError : null })
```

### 3. `DesktopConversation.tsx` — recovery wiring (new imports)

```ts
import { useDesktopChatRecovery } from '@/lib/desktop/chat-recovery/use-desktop-chat-recovery'
import type { DesktopRecoveryScope } from '@/lib/desktop/chat-recovery/controller'
import { DesktopProviderErrorNotice } from '@/components/desktop/chat/recovery/DesktopProviderErrorNotice'
```

```ts
const [modelRevision, setModelRevision] = useState(0) // bump wherever the conversation model pick changes (rememberModel + selector onConversationChoice)
const lastUserText = useRef<string | null>(null)       // capture last role==='user' message text for retry fallback

const recoveryScope: DesktopRecoveryScope = {
    agentId: agent.id,
    tabUid: tabUid ?? null,
    sessionId,
    liveSessionId: liveSessionId ?? sessionId,
    runId: engineRunning.runId ?? null,
    requestId: pendingQueue.current?.item.id ?? null,
    modelRevision,
}
const recovery = useDesktopChatRecovery({
    scope: recoveryScope,
    error: error?.message ?? null,                       // useChat transport/run error only — NOT historyError
    failedRun: engineRunning.failedRunId ? { runId: engineRunning.failedRunId, error: engineRunning.failedRunError ?? null } : null,
    canRetry: messages.some(m => m.role === 'user'),
    active,
    ports: {
        retryLastTurn: () => { if (canRegenerate) void regenerateReply(); else if (lastUserText.current && sessionId) void sendMessage({ text: lastUserText.current }, { body: { agentId: agent.id, sessionId } }) },
        continueRun: () => { if (sessionId) void sendMessage({ text: 'Continue where you left off.' }, { body: { agentId: agent.id, sessionId } }) },
        stopRun: () => handleStop(),
        newConversation: () => onSelectSession?.(null, 'New conversation'),
        switchModel: undefined,                            // internal DesktopRecoveryModelPicker is the default adapter; or wire a controlled-open DesktopModelSelector later
        reconnectProvider: () => onOpenModelSettings?.(),
    },
})
```

`retryLastTurn` uses `regenerateReply()` (canonical `regenerationRequestId` durable identity) when `canRegenerate`; the fallback resends the last user text through `sendMessage` — the engine's `run_in_flight` admission and queued-turn reconcile remain the dedupe authority. For a first-turn failure (`sessionId` still null) there is no transcript to regenerate; root may choose to restore the text into the composer instead — flagged as a limitation below.

`onConversationChoice` on `DesktopModelSelector` should also bump `modelRevision` (it already reports the effective conversation pick on load and change).

### 4. Render site (~line 1203)

Replace the `{(error || historyError) && ...}` block: keep `historyError`/`stopError`/`queueNotice`/`uploadNotice` as-is; render the recovery notice for the classified error and drop the raw `error?.message` div (the notice supersedes it):

```tsx
{historyError && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
    {historyError}
    <Button type="button" size="sm" variant="outline" className="ml-2" onClick={() => { /* existing history retry */ }}>Retry</Button>
</div>}
{recovery.notice && (
    <DesktopProviderErrorNotice
        kind={recovery.notice.kind}
        message={recovery.notice.message}
        agentId={agent.id}
        sessionId={sessionId}
        onRetry={() => recovery.act('retry')}
        onContinue={() => recovery.act('continue')}
        onStopRun={() => recovery.act('stop')}
        onNewConversation={() => recovery.act('new-conversation')}
        onReconnect={() => recovery.act('reconnect')}
        onSwitchModel={undefined}
        onConversationChoice={pick => rememberModel(pick)}
        onOpenModelSettings={onOpenModelSettings}
        onModelSaved={() => setModelRevision(n => n + 1)}
    />
)}
```

`historyError` stays on its own path deliberately: "Could not load history" classifies as `generic` and must not offer a message resend.

### 5. Optional upstream parity (root-owned files, not touched here)

- `apps/ui/components/chat/ProviderErrorNotice.tsx` is the older revision — missing `session_gone`/`thinking_replay`/`onNewConversation`/opencode glyph that upstream `2a57fa6` has. Web `AgentChat` does not pass `onNewConversation`; adopting the upstream file verbatim restores parity.
- `apps/ui/components/chat/NoticeActions.tsx` upstream adds `flex-wrap`/`basis-48`/`ml-auto` for narrow panels — worth adopting for the short-window checks.

## Contracts barrel

`packages/contracts/src/index.ts` already exports `./chat-error.js` and `./chat-error-copy.js` — no barrel change needed. `apps/ui/lib/chat-error.ts` re-exports the same symbols for `@/lib/chat-error` consumers.

## Implemented / dependent / unsupported

- **Implemented (this lane):** classification contract parity; scoped controller with stale-scope and late-run guards; notice UI with upstream action order/copy; conversation-scoped recovery model picker; durable retry via existing `regenerate`/`sendMessage` authorities; New conversation via existing `openSessionTab`.
- **Dependent on root:** fragments 1–4 above; `failedRunError` transport field; `modelRevision` source; notice mount point; optional upstream `ProviderErrorNotice`/`NoticeActions` adoption.
- **Unsupported / out of scope:** `budget` kind has no desktop `BudgetExhaustedNotice` equivalent (renders copy only, no actions); first-turn (`sessionId === null`) retry has no transcript to regenerate — root chooses composer-restore vs resend; `opencode` provider glyph falls back to the generic server icon (`PROVIDER_ICONS` has no `opencode` entry in this tree); `reconnectProvider` maps to coworker model settings rather than a dedicated provider-auth dialog (no desktop equivalent exists); Supabase untouched — all state stays in the desktop SQLite/object-store authorities.

## Honest limitations

- Retry-after-unknown-admission relies on the engine's existing `run_in_flight`/queued-turn reconcile; this lane did not add a `reconcileOnly` probe for ordinary sends (root may add one if acceptance shows duplicate admissions).
- `thinking_replay` retry assumes a fresh run does not carry the rejected block, per upstream copy; engine-side replay correctness is unchanged and root-verified.
- The recovery picker duplicates a subset of `DesktopModelSelector` deliberately (ownership boundary); if root prefers, `DesktopModelSelector` can grow a controlled-open prop and `onSwitchModel` replaces the internal picker with zero behavior change.
- No checks executed: tests, typecheck, lint, build, and Mac acceptance are all root-owned and pending.
