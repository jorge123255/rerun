# Round 31 C — complete coworker mention handoff

Source implementation and regression sources only. This continues commit `dad86d6876f560bdf19f836938b5cff41d9a9b4a`; it does not replace that work. Root owns central integration, every execution check and product acceptance.

## Original source mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/chat/MentionAutocomplete.tsx`: `@`/`/` trigger regex, query matching, preferred-same-Box then name ordering, `Coworkers`/`Skills` headings, buddy/handle/Box hint placement, handle-or-name insertion, ArrowUp/Down wrap, Enter/Tab selection, Escape, pointer pick and menu-local scrolling.
- `apps/ui/components/chat/ChatComposer.tsx`: injected textarea handlers, mention-first key handling before Send, caret/focus synchronization and mention tokens. The desktop wrapper keeps its existing IME guard and only submits Enter when the mention handler did not consume it.
- `apps/ui/lib/chat/composer-links.ts`: standalone mention boundaries, longest-first tokenization and saved-message presentation. Selected desktop metadata accepts only the same standalone boundaries, so email/embedded text cannot become a coworker token.
- `apps/engine/src/tools/builtin/call-agent.ts`: exact-ID then unique-case-insensitive-name resolution, duplicate-name refusal and separately authorized `call_agent`. Plain typed names remain plain text for that runtime path; mention selection never dispatches or grants it.

The desktop menu preserves the original absolute bottom anchor, `max-h-56` behavior at normal heights, local `scrollTop`, truncation, headings and ordering. Its responsive cap is `min(14rem,50dvh)` for short viewports. No original shared component was edited.

## Canonical contract and roster authority

`DesktopCoworkerCallTarget` is imported directly from `packages/contracts/src/desktop-coworker-calls.ts`; no second target response type or permission model exists. That A file is still absent and is a required integration dependency.

The route uses root-injected authority with this exact required signature:

```ts
import { desktopCoworkerMentionTargets } from '@/lib/desktop/server/engine'

const targets = await desktopCoworkerMentionTargets(runtime, ownerAgentId, { signal })
```

Root must implement that central export using the authenticated caller’s current local identity and current roster/grant authority. It must validate the caller, reject stale local/engine mappings, exclude the caller itself and deleted targets, and return canonical local `{agentId,name,handle,boxName,enabled,callable}` rows. `callable` must reflect current enabled state plus the actual default-off call grant and allowed target IDs. It must never expose engine IDs, private context, credentials, memories, files or chats. Lookup cannot enable a coworker, create a session, start a run or change a grant.

`createDesktopCoworkerMentionsApi` projects only those six fields even if an injected row has extras. It rejects duplicate local IDs and malformed/oversized rows rather than guessing or silently truncating. Duplicate names and duplicate handles remain valid because selection binds an immutable local ID. Limits are explicit: 100 targets, 256 UTF-16 code units per public text field, 10-second default authority deadline. Cancellation returns 408, deadline 504, invalid roster 502 and unavailable authority 503. Empty returns `{targets:[]}` with 200.

## Exported owned API

From `@/components/desktop/mentions`:

- `DesktopCoworkerMentions`, `DesktopCoworkerMentionsApi`
- `DesktopMentionMenu`, `DesktopMentionItem`
- `useDesktopMentionAutocomplete`
- `useDesktopCoworkerMentionTargets`, `listDesktopCoworkerMentionTargets`, `revalidateDesktopCoworkerMentionsAtSend`
- All pure model helpers from `coworker-mention-model.ts`

From `@/lib/desktop/coworker-mentions` (client-compatible re-export): the pure model helpers plus the lookup hook/client functions above.

From `@/lib/desktop/server/coworker-mentions`:

- `createDesktopCoworkerMentionsApi`
- `validateDesktopCoworkerMentionsAtSend`
- `DesktopCoworkerMentionRosterAuthority`
- `DESKTOP_COWORKER_MENTION_TARGET_LIMIT`, `DESKTOP_COWORKER_MENTION_TEXT_LIMIT`, `DESKTOP_COWORKER_MENTION_LOOKUP_TIMEOUT_MS`

Pure model surface:

- `insertDesktopCoworkerMention`, `deleteDesktopCoworkerMention`, `replaceDesktopCoworkerMention`, `reconcileDesktopCoworkerMentions`
- `desktopCoworkerMentionFields`, `desktopCoworkerMentionsFromMetadata`
- `revalidateDesktopCoworkerMentions`
- `desktopCoworkerMentionMetadataFields`, `restoreDesktopCoworkerMentionMetadata`
- `desktopCoworkerMentionHistoryTokens`, `desktopCoworkerMentionsForRegeneration`
- `DesktopCoworkerMention`, `DesktopResolvedCoworkerMention`, `DesktopCoworkerMentionRevalidation`, `DesktopCoworkerMentionIdentity`, `DesktopCoworkerMentionMetadata`, `DesktopCoworkerMentionRestore`, `DESKTOP_COWORKER_MENTION_METADATA_VERSION`

The pure model has no client directive, allowing the server validator to reuse the exact range and target logic without duplicating it.

## Composer integration and event order

Replace `DesktopSkillMentions` with `DesktopCoworkerMentions`, keeping controlled per-tab text/mention state and the existing attachment/composer structure:

```tsx
import { DesktopCoworkerMentions } from '@/components/desktop/mentions'
import type { DesktopCoworkerMention } from '@/lib/desktop/coworker-mentions'

const [coworkerMentions, setCoworkerMentions] = useState<DesktopCoworkerMention[]>([])

<DesktopCoworkerMentions
    agentId={agent.id}
    preferredBoxName={currentBoxName}
    text={input}
    mentions={coworkerMentions}
    onTextChange={setInput}
    onMentionsChange={setCoworkerMentions}
    enabled={composerEnabled}
    refreshKey={composerRefreshKey}
>
    {api => <>
        <Textarea ref={api.inputRef} {...api.textareaProps} />
        {api.menu}
    </>}
</DesktopCoworkerMentions>
```

`api.textareaProps` includes the original handlers and ARIA listbox/active-option attributes. Event order is IME guard → mention navigation/selection → only if not prevented, ordinary Enter submit. When no menu consumes Enter, Shift+Enter retains ordinary newline behavior and unrelated shortcuts remain untouched. Pointer `mousedown` prevents focus loss, then restores caret/focus. The menu scrolls itself, never the board/chat.

`api.targets`, `targetStatus`, `targetError` and `retryTargets` expose `idle/loading/ready/empty/error/unavailable`. Existing `status`, `skills`, `error` and `retry` remain the /skill shelf fields. Disabled or uncallable targets are not presented as new selections. Old valid selected tokens remain renderable after a rename.

## Immutable metadata and editing

A selected record remains:

```ts
type DesktopCoworkerMention = {
    targetId: string
    token: string
    start: number
    end: number
}
```

Offsets are UTF-16 textarea offsets; `token` excludes the trailing insertion space. Explicit insertion requires an enabled/callable target and a standalone trigger. Editing shifts unaffected ranges and drops an edited token’s record. Dropped records are plain text and are never re-resolved by display name. Deletion removes the exact selected token and shifts other records.

`desktopCoworkerMentionFields` supplies the simple history-compatible `coworkerMentions` array. `desktopCoworkerMentionHistoryTokens` supplies safe `ComposerMention[]` for root’s saved-message renderer without changing old text after a rename.

## Versioned draft, queue and acknowledgement binding

`desktopCoworkerMentionMetadataFields(identity,text,mentions)` returns one optional `coworkerMentionMetadata` envelope with version 1, exact agent/session/tab/request identity, exact body text and immutable records. `restoreDesktopCoworkerMentionMetadata` refuses wrong versions, owners, sessions, tabs, request IDs, bodies and ranges. No origin-only persistence is created.

Use identities as follows:

```ts
const draftFields = desktopCoworkerMentionMetadataFields(
    { agentId, sessionId, tabUid, requestId: null }, text, mentions,
)

const queueFields = desktopCoworkerMentionMetadataFields(
    { agentId, sessionId: queueScope.sessionId ?? null, tabUid: queueScope.tabUid ?? null, requestId: queued.id },
    queued.text, mentions,
)

const acknowledgedFields = desktopCoworkerMentionMetadataFields(
    { agentId, sessionId: admittedSessionId, tabUid, requestId: admittedRunOrRequestId },
    admittedText, mentions,
)
```

Required root schema/store additions, all optional for backward compatibility:

- `apps/ui/lib/desktop/composer-draft.ts`: `coworkerMentionMetadata` and legacy `coworkerMentions`; include metadata in write fingerprint/CAS and clear it with text only after admission.
- `apps/ui/lib/desktop/queued-message.ts`: the same fields on the queued item; preserve them through waiting/sending/review, restart and retry.
- Server draft/queue stores and chat request/history metadata schemas: additive migration/parse support; do not rewrite existing attachments or unrelated drafts.

Draft restore uses `requestId:null`. Queue restore uses the existing item ID. Acknowledged send reconciliation uses the exact admitted request/run ID. Failed/cancelled sends keep text and metadata. Old metadata cannot bind another owner, tab, request or edited body.

## Required server send admission and regeneration

Client `api.revalidateSend()` is a fresh-read UX adapter, not sufficient authority. Root must call the server helper before initial admission, every queue flush/send-now and every regeneration:

```ts
const restored = restoreDesktopCoworkerMentionMetadata(identity, text, metadata)
if (!restored.ok) throw new DesktopHttpError(409, restored.error)

const checked = await validateDesktopCoworkerMentionsAtSend(rosterAuthority, {
    agentId, text, mentions: restored.mentions, signal,
})
if (!checked.ok) throw new DesktopHttpError(409, checked.error)
```

For legacy `coworkerMentions` history, root may parse the simple records but must still perform the same fresh server ID/range check. Missing/deleted, disabled, uncallable, duplicate-ID and stale-range cases refuse. Rename keeps the original visible token and exact ID. Duplicate names/handles never redirect. Plain names have no record and stay plain text. The helper performs only a fresh roster read; it does not dispatch, grant tools or bypass A’s admission.

For regeneration:

```ts
const mentions = desktopCoworkerMentionsForRegeneration(sourceText, regeneratedText, sourceMetadata)
// Create a new current request identity and run validateDesktopCoworkerMentionsAtSend again.
```

Damaged source ranges throw rather than silently dropping a selected coworker. Unchanged regeneration preserves ID/display token; edited regeneration reconciles ranges first. Never reuse the old acknowledged request identity as the new regeneration request.

## Implemented / dependent / unsupported matrix

| Area | Implemented in lane | Root dependency | Unsupported here |
| --- | --- | --- | --- |
| Original @ and / discovery | Trigger/matching/order/headings/icons/hints/insertion | Mount beside existing composer | File mentions |
| Keyboard/pointer/focus/IME | Wrap, Enter/Tab, Escape, hover/pick, caret/focus, ARIA, local scroll | Preserve root event ordering | Runtime accessibility acceptance |
| Trusted roster | Bounded safe GET, cancellation, deadlines, empty/error states | Current caller/roster/grant authority export | Engine IDs/private context |
| Immutable tokens | ID/token/range, insert/delete/shift/invalidate | Controlled per-tab state | Name-based silent re-resolution |
| Send safety | Client fresh check and required server validator | Call server validator in every admission path | Dispatch/grant/tool authority |
| Drafts/queues/acks | Versioned owner/body/request envelope and reconciliation | Additive central schemas/migrations/stores | New persistence silo |
| History/regeneration | Safe old-token rendering and strict source carry-forward | Renderer and alternate-request wiring | Retroactive rename or old-request reuse |
| Verification | Focused regression sources authored | Run/repair all checks and Mac/restart QA | Tests/builds/live acceptance by lane |

## Regression sources authored, all unrun

- `coworker-mention-model.test.ts`: @ boundaries, duplicate identities/names, insertion/deletion/range edits, rename/delete/disable/revoke, plain text, versioned draft/queue/ack ownership and body binding, history/regeneration.
- `server-coworker-mentions.test.ts`: safe projection, valid empty, duplicate IDs/names, response bounds, cancellation/deadline, fresh server send validation and refusal without dispatch.
- `coworker-mentions-client.test.tsx`: stale owner/generation rejection, loading/empty/error/unavailable/retry and fresh read-only send lookup.
- `DesktopCoworkerMentions.test.tsx`: preferred ordering, Box hints, /skill coexistence, immutable selection without Send, email/plain text, Arrow wrap/ARIA, pointer focus/caret and IME/Escape.

No tests, typecheck, lint, builds, installs, servers, live APIs, Mac UI, restart QA, packaging, Docker or Keychain operations were run. Installed Next.js documentation under `node_modules/next/dist/docs` is absent in this checkout; no installation was attempted.

## Changed files in this continuation

- `apps/ui/components/desktop/mentions/coworker-mention-model.ts` — new pure token/metadata model.
- `apps/ui/components/desktop/mentions/coworker-mention-model.test.ts` — new regression source.
- `apps/ui/components/desktop/mentions/server-coworker-mentions.test.ts` — new regression source.
- `apps/ui/components/desktop/mentions/coworker-mentions-client.test.tsx` — new regression source.
- `apps/ui/components/desktop/mentions/DesktopCoworkerMentions.tsx` — preserve ARIA props through the composed API.
- `apps/ui/components/desktop/mentions/DesktopMentionMenu.tsx` — option identity and short-height behavior.
- `apps/ui/components/desktop/mentions/useDesktopMentionAutocomplete.ts` — IME, ARIA and highlight lifecycle.
- `apps/ui/components/desktop/mentions/DesktopCoworkerMentions.test.tsx` — expanded interaction regression source.
- `apps/ui/components/desktop/mentions/index.ts` — complete owned exports.
- `apps/ui/lib/desktop/coworker-mentions.ts` — pure-model re-export and generation-safe client lifecycle.
- `apps/ui/lib/desktop/server/coworker-mentions.ts` — bounded authority, cancellation and server send validator.
- `apps/ui/app/api/desktop/coworkers/[agentId]/mentions/route.ts` — signal-forwarding authority call.
- `docs/desktop-round31-c-handoff.md` — this handoff.
