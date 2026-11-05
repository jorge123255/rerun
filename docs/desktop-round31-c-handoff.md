# Round 31 C — coworker mention handoff

Source handoff only. Root owns integration, all checks and product acceptance.

## Original references

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/chat/MentionAutocomplete.tsx`: shared `@`/`/` detection, preferred ordering, labels, Box hint, keyboard selection, menu scrolling and token text.
- `apps/ui/components/chat/AgentChat.tsx`: composer/question-form textarea synchronization and mention-token rendering.
- `apps/ui/components/foreman/ForemanComposerSlot.tsx`: composer synchronization and menu anchoring.
- `apps/ui/components/foreman/ForemanChatLayer.tsx`: history mention tokens.

The desktop adapter preserves the original absolute, bottom-anchored menu, `max-h-56` scrolling list, truncation, preferred-then-name ordering, ArrowUp/ArrowDown/Enter/Tab/Escape behavior and direct textarea synchronization. It also retains the existing `useDesktopSkillSuggestions` shelf read and the desktop IME guard.

## Required contract and server authority

`DesktopCoworkerCallTarget` is imported directly from `packages/contracts/src/desktop-coworker-calls.ts`. That paired A file is absent at the assignment base; root must integrate A and its central export policy without creating a second target definition.

`apps/ui/app/api/desktop/coworkers/[agentId]/mentions/route.ts` deliberately depends on this missing root-owned export:

```ts
import { desktopCoworkerMentionTargets } from '@/lib/desktop/server/engine'

const targets = await desktopCoworkerMentionTargets(runtime, ownerAgentId)
```

Root must implement that function using current local roster and A's current call-grant authority. It must validate the owner, exclude the owner itself and deleted targets, and return exact public `{agentId,name,handle,boxName,enabled,callable}` rows. It must not expose engine IDs. `callable` must reflect current enabled state and the actual per-coworker call grant/allowed target IDs; selecting a mention never changes either value. `createDesktopCoworkerMentionsApi` explicitly projects these six fields even if an authority row carries extra private fields.

## Composer wiring

Replace the existing `DesktopSkillMentions` wrapper with `DesktopCoworkerMentions`; its API extends `DesktopSkillMentionsApi`, so the existing composer render function remains compatible. Root supplies controlled text and mention records plus the current conversation Box name:

```tsx
import { DesktopCoworkerMentions, type DesktopCoworkerMentionsApi } from '@/components/desktop/mentions'
import type { DesktopCoworkerMention } from '@/lib/desktop/coworker-mentions'

const [coworkerMentions, setCoworkerMentions] = useState<DesktopCoworkerMention[]>([])

<DesktopCoworkerMentions
    agentId={agent.id}
    preferredBoxName={currentBoxName}
    text={input}
    mentions={coworkerMentions}
    onTextChange={setInput}
    onMentionsChange={setCoworkerMentions}
>
    {api => <ExistingDesktopComposer mentionApi={api} />}
</DesktopCoworkerMentions>
```

`api.targets`, `targetStatus`, `targetError` and `retryTargets` expose roster availability. The existing `status`, `skills`, `error` and `retry` fields remain the skill-shelf values. `api.tokens` includes current roster/skill tokens and valid persisted tokens, including an old token after a rename.

## Durable drafts, queue and regeneration

A selected record is exactly:

```ts
type DesktopCoworkerMention = {
    targetId: string
    token: string
    start: number
    end: number
}
```

Offsets are UTF-16 textarea offsets. The token excludes the trailing insertion space. Root should add an optional `coworkerMentions` array to its existing draft, queued-message and source-message metadata schemas. Do not replace the central schemas with this document's structural type.

Use the owned helpers rather than re-serializing by name:

```ts
import {
    desktopCoworkerMentionFields,
    desktopCoworkerMentionsFromMetadata,
} from '@/lib/desktop/coworker-mentions'

const fields = desktopCoworkerMentionFields(text, coworkerMentions)
const restored = desktopCoworkerMentionsFromMetadata(savedText, savedMetadata)
```

- Draft: include `fields` in the existing draft write attempt and revision comparison. Restore with `desktopCoworkerMentionsFromMetadata(draft.text, draft)` and preserve the records through the existing draft flush/quit handshake.
- Queue: include the same fields when enqueueing, persist them unchanged, and restore them for every flush/send-now path. Clear text and mention records together only after admission.
- Regeneration: read the exact source message's metadata and carry the records into the alternate request. Do not infer targets from the current display names or current roster tokens.
- Editing: `reconcileDesktopCoworkerMentions` shifts unaffected ranges and drops an edited token's record. Dropped records are plain text; they are not silently resolved to a target.
- History rendering: merge `api.tokens` as before. The records, not `ComposerMention`, retain immutable target identity.

## Required send admission

Root must call `api.revalidateSend()` before an initial send, every queued delivery and every regeneration. This performs a fresh GET for the current owner and resolves only the stored IDs. A rename retains the old visible token but resolves the same ID; duplicate names cannot redirect it. Missing/deleted, disabled or uncallable targets and stale ranges return `{ok:false}` and must block admission while preserving the draft and queue item. A typed plain name has no record and remains plain text for deterministic tool-side disambiguation.

On `{ok:true}`, root may attach the returned exact target IDs to its trusted message metadata. Root/A must still reauthorize the actual `call_agent` invocation and allowed targets at execution. The mention adapter itself never dispatches work, creates a session, changes grants or copies target context.

## Unsupported and unverified cases

- No persistent-call execution, target-chat navigation, delegation, tool registration or grant mutation is implemented in this lane.
- Old visible tokens are not rewritten after a rename, and name-only persisted text is not upgraded into a selected mention.
- A failed roster read does not substitute a cached roster for send admission.
- The paired A contract and root roster export remain integration dependencies, so this source is not independently buildable at the assignment base.
- Regression sources were authored but not executed. No tests, typecheck, lint, builds, servers, live APIs, Mac UI, restart QA, packaging, Docker or Keychain operations were run.
