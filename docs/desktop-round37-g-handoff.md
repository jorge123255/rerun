# Round37 G — current original question, quick-reply and voice interactions

Implementation commit: `675d63521a3fc05115bcd2aa1129b3b93edcc488`.

Branch: `desktop/round37-chat-interactions`. Prepared parent: `e87edabffded9b56c67f98539a412e230959435c`; branch, exact HEAD and initially clean status were inspected before edits. User identifies accepted runtime `81f1c62a7b9fb0ac1f44bbee77c21e0f4aa576f5`. This document is committed separately after the implementation; its own final commit ID belongs in the delivery message.

**No checks executed and no installed acceptance.** Regression sources were authored and not executed. No tests, typechecks, lint, builds, formatters, installations, fixtures, servers, network/provider requests, browser/native UI, screenshots, microphone, Keychain or restart checks were run. Git/source inspection, owned edits and local commits only. Commit hooks were disabled to honor the no-execution rule. Root owns review, repairs, all execution checks, packaging and board/full-restart acceptance. C4/C5/C8 are not marked accepted. No push, merge or publication.

## Source/design mapping and differences

Comparison source is the actual community/core Git object `2a57fa6dd53311f763bfc9abde85997b7f7e5309`, available in read-only `upstream-review-20261106`; historical acceptance/design pin remains `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. No EE code was copied and no upstream checkout was created.

| Original file at comparison pin | Port and intentional Mac adaptation |
| --- | --- |
| `packages/contracts/src/chat-hitl.ts` | Optional question header, described labels, original v2 stamping helper. The accepted Mac `pendingQuestions` reading is deliberately preserved byte for byte; an explicit desktop projection selects new presentation and digest semantics. Upstream's global string-to-object conversion would change existing pending-question IDs and receipt guards. |
| `packages/ui/src/chat/QuestionForm.tsx` and `packages/ui/src/chat/OptionRow.tsx` | Same header above question, label then muted two-line description, numbered selection, multiple selection, custom text, Skip, next/submit and dismissal. Descriptions use the existing OptionRow ReactNode label slot because OptionRow is not owned. Existing form latches and attachment behavior remain. Non-submit buttons explicitly declare `type="button"`. |
| `packages/contracts/src/chat-quick-replies.ts` | Original announcement/draft and future-value-promise rules, including French phrases and exceptions. Promises disappear; announcements prefill an empty canonical draft for the user to complete. Existing draft content, mentions and attachments block insertion. |
| `apps/engine/src/tools/builtin/hitl.ts` | Read original current question schema and current desktop tool adapter. Root fragment below widens the existing builtin schema; no parallel question tool or permission system. |
| `apps/ui/components/chat/VoiceUserMessage.tsx`, `VoiceTranscript.tsx`, `CopyAction.tsx`, `useVoicePlayback.ts` and `packages/contracts/src/voice.ts` | Original Transcript/Copy transcript action order, Copied! feedback, hover/focus/touch affordances, expanding right-aligned italic transcript and heard/unheard presentation. Existing Mac player and saved URLs remain authoritative. **Original text-length-proportional word starts are not ported:** the task requires genuine saved provider/alignment data. Missing/inconsistent data displays plain transcript. |

Existing Mac support was read first: `desktop-question.ts`, desktop server questions/receipts, `DesktopQuestionCard`, `DesktopConversation`, `DesktopAssistantReply`, quick-reply helpers/chips, canonical draft writer/hook, `voice/DesktopVoiceHistoryMessage`, `DesktopVoiceMessageBubble`, `useDesktopVoicePlayback`, saved artifact contracts, and accepted assistant plain-text clipboard handling. Basic question receipts, expand/collapse, recording, playback, seek and transcription already exist; this package does not rebuild them.

Instructions read: applicable AGENTS/CLAUDE files, `docs/desktop-agent-assignment-standard.md`, upstream comparison notes, and installed Next client-boundary guide at `final-build/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`. Callback props stay between client components; do not pass function ports across an RSC serialization boundary. No dependencies installed or manifests changed. Existing `lucide-react` supplies Captions directly because the current root icon barrel does not export it.

## Changed files (implementation: 19; this handoff: 1)

- `packages/contracts/src/chat-hitl.ts`
- `packages/contracts/src/chat-quick-replies.ts`
- `packages/contracts/src/voice.ts`
- `packages/ui/src/chat/QuestionForm.tsx`
- `apps/ui/components/desktop/chat/interactions/ScopedQuestionCard.tsx`
- `apps/ui/components/desktop/chat/interactions/ScopedQuickReplies.tsx`
- `apps/ui/components/desktop/chat/interactions/DesktopVoiceTranscript.tsx`
- `apps/ui/components/desktop/chat/interactions/DesktopVoiceTranscriptActions.tsx`
- `apps/ui/components/desktop/chat/interactions/QuestionForm.test.tsx`
- `apps/ui/components/desktop/chat/interactions/VoiceTranscript.test.tsx`
- `apps/ui/lib/desktop/chat-interactions/identity.ts`
- `apps/ui/lib/desktop/chat-interactions/questions.ts`
- `apps/ui/lib/desktop/chat-interactions/answer.ts`
- `apps/ui/lib/desktop/chat-interactions/quick-replies.ts`
- `apps/ui/lib/desktop/chat-interactions/voice.ts`
- `apps/ui/lib/desktop/chat-interactions/fixtures.ts`
- `apps/ui/lib/desktop/chat-interactions/questions.test.ts`
- `apps/ui/lib/desktop/chat-interactions/quick-replies.test.ts`
- `apps/ui/lib/desktop/chat-interactions/voice.test.ts`
- `docs/desktop-round37-g-handoff.md`

All other paths, Round36 lanes, root integration files, schema ladders, manifests, lockfiles and checklist are untouched.

## Public boundaries and concrete adapters

`ChatInteractionIdentity` carries canonical `DesktopWorkspaceId`, local agent/session/tab UID, exact source message/tool-call ID and source fingerprint. `interactionKey` includes every field. `current()` must consult live selected workspace/chat/tab/source/Stop authority, returning null when unavailable; returning the captured identity unconditionally is not a valid binding. No authority is inferred from equal transcript text or labels.

Shared question exports:

```ts
type QuestionOption = { label: string; description?: string }
type QuestionItem = {
  question: string; header?: string
  options: (string | QuestionOption)[]; multiple?: boolean
}
type DesktopQuestionProjection = {
  presentationVersion: 1 | 2; questions: QuestionItem[]; fingerprint: string
}
prepareDesktopQuestionInput(raw: Record<string, unknown>): Record<string, unknown>
projectDesktopQuestionInput(raw: unknown): DesktopQuestionProjection | null
pendingQuestionPresentation(input: Record<string, unknown>): QuestionItem[]
withHitlVersion<T>(toolName: string | undefined, input: T): T
```

`questions.ts` reexports this one shared projection; it does not duplicate parsing. `prepareDesktopQuestionInput` is exclusively a **new call, before persistence** operation. `projectDesktopQuestionInput` is the strict, observational read/validation operation. It refuses partial/malformed choices, unsupported future versions and invalid presentation markers. Existing bounds remain: 32 questions, 4,000 question characters, 100 options, 500 label characters and 32,768 fingerprint characters; new headers/descriptions are bounded to 200/2,000 characters.

`createQuestionAnswerAdapter(identity, question, {current, answer})` binds the existing `DesktopQuestionAnswer` DTO and canonical ACK-resolving callback, supplies an abort signal, retains the exact first request/intent on uncertain failure, coalesces concurrent identical admissions and refuses conflicting/accepted repeats. `ScopedQuestionCard` concretely mounts the existing `DesktopQuestionCard` through that adapter. Its effect creates no request; cleanup closes only its adapter and aborts its signal. StrictMode cleanup/setup recreates the adapter. Root's canonical saved attempt/receipt remains restart authority.

`createQuickReplyAdapter` concretely uses `desktopDraftRecord`, `updateDesktopDraft`, `saveDesktopDraft` and existing `DesktopQuickReplySend`. It has no second draft store or send-ID generator. `ScopedQuickReplies` keeps the existing `DesktopQuickReplies` presentation/latch and maps only an actual accepted send to true. Draft insertion never masquerades as a sent message. It reports saved/unsaved draft outcomes honestly because the canonical draft saver catches errors internally.

`DesktopVoiceTranscriptActions` takes exact identity/current callback, saved `VoiceMessage`, active state, existing player's real elapsed milliseconds/playing state and optional saved alignment. It mounts no audio element, records nothing and never sends. Copy uses existing `MessageAction`, `MessageActions`, `useCopy` feedback and the same synchronous human-gesture plain-text copy path used by accepted desktop assistant replies. It does not request the denied asynchronous clipboard permission or read clipboard data.

`SavedVoiceAlignment` binds exact identity and audio src to `VoiceTranscriptAlignment`: version1, source provider/alignment, provenance, exact transcript/duration and actual millisecond word intervals. `savedVoiceWords`/`alignedTranscriptWords` validate all of it before rendering progress. Missing/invalid/partial metadata, wrong source/identity/duration, overlap, out-of-range/nonfinite times and surrogate splitting fall back. Whitespace/punctuation are preserved as untimed gaps. Metadata is bounded to 20,000 transcript characters, 5,000 words and existing five-minute recording duration. No normalization or estimated times are inserted. Current saved Mac artifacts do **not** provide this metadata; pass undefined today.

## Exact dependency revisions

All dependencies below are the accepted prepared base `e87edabffded9b56c67f98539a412e230959435c`, inspected without modification. Git blob IDs pin the precise source interface, not execution/acceptance evidence.

| Dependency file | Base blob |
| --- | --- |
| `packages/contracts/src/desktop-question.ts` | `08c82bdcc0bd8142db0dd9ddb996bdf8113e0764` |
| `apps/ui/lib/desktop/questions.ts` | `86c5e3635a8660d425e9b07f38273cca2a3d6e37` |
| `apps/ui/lib/desktop/server/questions.ts` | `884dcd94330da6bc24214ce21ca4eab225e17613` |
| `apps/ui/components/desktop/DesktopQuestionCard.tsx` | `8cdd690e9d18686d7f870640eb7f9c829316f4de` |
| `apps/ui/lib/desktop/draft-writes.ts` | `dba8a8bf384e94e99131115608bfabea068663f2` |
| `apps/ui/lib/desktop/quick-replies.ts` | `298de9ba5ed5e3a5025edb22b292ad38a56f28dd` |
| `apps/ui/components/desktop/DesktopAssistantReply.tsx` | `d2be846a07c70b4a1b03626b5dcb0684c18ceb08` |
| `packages/contracts/src/desktop-voice.ts` | `33b07f7fd696fd8d02deafbb6a2747055321ba8f` |
| `packages/contracts/src/desktop-workspaces.ts` | `5c63c27e51b110e0a771492e5f23e83280d0e1fe` |
| `apps/ui/components/desktop/voice/DesktopVoiceMessageBubble.tsx` | `ab00db28d4c8b6142a6f6912dfc4d77616dfb16a` |
| `apps/engine/src/runtime/run-stream-merge.ts` | `35f174616fcba4dcdc0d6795895be716e401a14d` |
| `apps/engine/src/runtime/loop.ts` | `1abd2d16233188a43474084e5370045bd17f94fa` |

No new H recovery or I protocol-runtime contract revision was supplied/consumed. Root must compose their Round37 handoffs with this implementation's exact shared contract revision (implementation SHA above); do not assume Round36 source is active. The I dependency is explicit: recognize supported question v2 via this projection while keeping unknown versions observational/non-actionable. H's error UI must keep the canonical same-ID retry; it must not create another answer action.

## Root activation order and fragments (not applied)

### 1. Canonical question projection and public DTO

In root-owned `packages/contracts/src/desktop-question.ts`, replace the existing string-only validation body with the shared projection. Keep `desktopQuestionGuardSchema`, question ID calculation, row scanning, delivered-result detection and receipt tables unchanged:

```ts
import { projectDesktopQuestionInput, type DesktopQuestionProjection } from './chat-hitl.js'
export function desktopQuestionInput(raw: unknown): DesktopQuestionProjection | null {
  return projectDesktopQuestionInput(raw)
}
// In findDesktopQuestion, the candidate uses the projection's fingerprint:
if (input) candidate = {
  sourceMessageId: row.id, toolCallId: callId,
  questions: input.questions, fingerprint: input.fingerprint,
  requestedAt: row.createdAt ?? null,
}
```

Do **not** keep `JSON.stringify(input.questions)` there for v2. Do not stamp/rewrite read rows. For legacy strings (including v2 string-only stored rows whose header was previously ignored), the projection still returns the accepted `pendingQuestions` structure and exact `JSON.stringify` fingerprint. New calls with presentation get a separate `{v:2,questions}` fingerprint envelope. New header-only calls carry `desktopQuestionPresentationVersion:2`; described options in v2 also select new projection. This intentionally prevents retroactively changing old pending IDs.

In root-owned `apps/ui/lib/desktop/questions.ts`, widen only `questionItem`; keep answer/request DTOs and saved attempts unchanged:

```ts
const choice = z.union([
  z.string().min(1).max(500),
  z.object({ label: z.string().min(1).max(500), description: z.string().max(2000).optional() }).strict(),
])
const questionItem = z.object({
  question: z.string().min(1).max(4000), header: z.string().max(200).optional(),
  options: z.array(choice).max(100), multiple: z.boolean().optional(),
})
```

`readDesktopQuestion` already forwards `pending.questions`, so no parallel endpoint is needed. Keep its accepted receipt suppression and `reconcile` before stale-question validation. The existing SHA256 ID remains `[local agent id,local session id,source message id,tool-call id,fingerprint]`. Answer serialization, original dismissal text, canonical request IDs, answer guards and ACK headers stay unchanged. No data migration/backfill or stored-payload normalization.

### 2. New engine calls: schema, validation, stored input and streaming input agree

In `apps/engine/src/tools/builtin/hitl.ts`, retain existing ask_user schema/order/copy; add optional header and widen options as in current original:

```ts
const questionOption = z.union([
  z.string().min(1),
  z.object({ label: z.string().min(1), description: nullTolerantOptional(z.string()) }),
])
// Inside each question object:
header: nullTolerantOptional(z.string().min(1)),
options: nullTolerantOptional(z.array(questionOption).min(2)),
// Keep the deprecated suggestions string-array alias and existing multiple flag.
```

In existing `desktop/question-tool.ts`, after current `requireDesktopToolGrant` and before `desktopQuestionInput` validation, prepare the new input. Do not mutate saved history to make validation pass:

```ts
const prepared = prepareDesktopQuestionInput(input as Record<string, unknown>)
if (!desktopQuestionInput(prepared)) throw new Error('Use shorter questions and fewer choices so the questions can be shown in chat.')
return original.execute!(prepared, options)
```

The SDK's original tool-call input can differ from execute's local argument, so **both** central new-output paths need the same preparation. In `runtime/loop.ts`, extend `canonicalizeHitlNames`, which runs on newly settled messages immediately before `desktopSourceRows`/`appendMessage`, to also prepare ask_user tool-call input. Preserve original input representation for JSON-string inputs:

```ts
function prepareNewQuestionInput(input: unknown): unknown {
  let value = input
  if (typeof input === 'string') {
    try { value = JSON.parse(input) } catch { return input }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return input
  const prepared = prepareDesktopQuestionInput(value as Record<string, unknown>)
  return typeof input === 'string' ? JSON.stringify(prepared) : prepared
}
// In the content mapper, for NEW settlement rows only:
const name = isHitlToolName(p.toolName) ? canonicalHitlName(p.toolName) : p.toolName
if (desktopApp() && p.type === 'tool-call' && name === 'ask_user') {
  changed = true
  return { ...part, toolName: name, input: prepareNewQuestionInput((part as { input?: unknown }).input) }
}
// Retain the existing canonical-name branch for every other tool-call/tool-result.
```

In `runtime/run-stream-merge.ts`'s `tool-input-available` branch, canonicalize the name and prepare its input using the same logic. Preserve `tool-input-start` without adding an input property. This matches original current stream v2 stamping, augmented only for Mac header-only receipt compatibility. Do not place preparation in a historical message repository reader or a GET route. Root/I must keep new persisted input, streaming input, engine guard and desktop guard consistent. Shared contracts already use export-star barrels; no new barrel edit is necessary for these functions.

### 3. Current workspace/tab authority and question mount

Root must pass the actual selected authenticated `DesktopWorkspaceId` into Conversation. The current component does not expose it. Do not infer workspace1 from a localhost origin. Supply a live ref updated every render **before callbacks** with current workspace/agent/session/tab and active/ready/Stop/quit state. Source membership must be checked again after awaits. Empty or missing IDs disable interactions.

Replace the existing question mount in `DesktopConversation.tsx` with `ScopedQuestionCard`. Construct the following only with all canonical IDs available:

```tsx
const questionIdentity: ChatInteractionIdentity = {
  workspaceId, agentId: agent.id, sessionId, tabUid,
  messageId: question.messageId, toolCallId: question.toolCallId,
  sourceFingerprint: question.id, // Existing server hash already binds the payload fingerprint.
}
<ScopedQuestionCard question={question} identity={questionIdentity}
  disabled={draft.quitting || !active || inactive || generating || stopping || !ready}
  current={() => liveQuestionIdentity.current}
  onAnswer={(payload, signal) => {
    signal.throwIfAborted()
    return answerQuestion(payload)
  }} />
```

`liveQuestionIdentity.current` is null when source/owner changes, during Stop/quit/inactive state, or when the canonical pending question is absent. Set it to the newly computed identity otherwise. Admission readiness (`disabled`, including an in-progress send) is checked separately before dispatch; do not declare an unchanged owner stale merely because its own admitted operation sets a busy flag. Keep `answerQuestion`'s current owner checks, canonical SDK transport and verified `x-question-id`/session/run ACK behavior. It must resolve only after acceptance, as it does at the base. Its send path must use the root's existing exact-request SDK cancellation on owner disposal/Stop; the adapter abort signal is available for that binding. If root adds an abort listener, capture the exact `responding.current` object/session/request and cancel only while that object still owns it; never abort a newer chat's transport. Aborting an observational client wait is not proof that an already admitted answer was undone. Preserve its saved receipt for same-ID reconciliation. Keep the existing canonical Stop engine route and failed-Stop error behavior.

The owned wrapper intentionally keeps original `DesktopQuestionCard` request-map/latches/restore UI. Remount does not answer or reconcile automatically. An explicit Retry passes the saved exact request/intent into the canonical API.

### 4. Quick-reply consumer and canonical draft

In `DesktopAssistantReply.tsx`, replace the chip mount with `ScopedQuickReplies` and widen its optional `quickReplies` prop to `Omit<ScopedQuickRepliesProps,'message'>`. Pass `message={message}`. In `DesktopConversation.tsx`, extend that existing last-assistant-message binding:

```tsx
quickReplies={{
  identity: replyIdentity,
  current: () => liveReplyIdentity.current,
  record: () => tabUid ? desktopDraftRecord(agent.id, tabUid) : null,
  onDraftChanged: record => {
    // Already fenced synchronously by the owned adapter.
    setInputs(current => new Map(current).set(inputKey, record.state.text))
    setMentionValues(current => new Map(current).set(inputKey, record.state.coworkerMentions ?? []))
    composer.current = { text: record.state.text,
      attachments: [...desktopAttachmentPathsOf(record.state)],
      coworkerMentions: record.state.coworkerMentions }
  },
  focusDraft: () => composerForm.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(),
  show: messageIndex === transcript.length - 1 && quickRepliesVisible,
  disabled: !canSendQuickReply, pending: quickReplyBusy || queue.pending,
  onSend: text => sendQuickReply(message.id, text),
}}
```

`replyIdentity` has actual workspace/agent/session/tab/message IDs and `sourceFingerprint:JSON.stringify(message.parts)`. The live ref identifies the exact assistant source in the still-current owner and is null when that source disappears/changes or the owner stops, quits or becomes inactive. Admission requires the last visible eligible source through the existing show/disabled/pending controls and trusted send gate. Keep an unchanged in-flight source identifiable while its own operation temporarily sets busy/pending flags; those flags are admission guards, not an owner change. Root's existing `quickReplyContext` remains the final trusted send gate. This callback synchronizes the composer shadow state only; the adapter already changed/saved the real canonical record, so do not call another draft writer here. For real tab-backed composers the canonical record supplies `draft.text` through `useSyncExternalStore`.

Add a final defense in existing `sendQuickReply` before any ID/admission: `if (quickReplyDraft(text) !== null) return false`. Future promises are already excluded by `desktopQuickRepliesOf` after this shared change. Keep the existing request-ID map, accepted headers, real send callback and ordinary-draft preservation. In root-owned `lib/desktop/quick-replies.ts`, ensure input projection also uses the filtered list (currently it tests the filtered list but then returns the unfiltered parse result):

```ts
export function desktopQuickReplyInputOf(part: unknown): DesktopQuickReplyInput | null {
  const replies = quickRepliesOf({ role: 'assistant', parts: [part] })
  return replies.length ? { replies } : null
}
```

No guessed URL/path/value is ever manufactured. Announcements insert only the original lead plus `: `; future promises stay absent. Dirty text/attachments/mentions remain untouched, with a notice. Draft-save failures use the existing saved attempt and Retry saving draft flow. Neither mounting nor restoring drafts sends a quick reply.

### 5. Voice history/bubble mount and exact source lifetime

In `DesktopConversation.tsx`'s user text-part map, pass current workspace/session/tab plus `message.id` and text-part index into `DesktopVoiceHistoryMessage`. Its existing parsing and **original artifact scope** remain unchanged (a recording may belong to a closed original tab). Build interaction identity from current selected IDs and `sourceFingerprint:JSON.stringify([partIndex,text])`; this includes the exact saved marker/audio src/duration/transcript. Same-text messages still differ by message ID. A live source map keyed by message+part must verify membership, current owner and Stop/quit before returning that identity. Do not use current tab to rewrite the original saved audio URL.

Extend root-owned `voice/DesktopVoiceMessageBubble.tsx` props with identity/current/active and optional `SavedVoiceAlignment`. Keep `scope`, `isDesktopVoiceAudioReference`, player, waveform, duration, audio element, seek and saved-URL validation. Remove only the old `showTranscript` state, old Show/Hide transcript button and old transcript paragraph, then mount below the existing audio row/error:

```tsx
<DesktopVoiceTranscriptActions identity={identity} current={current}
  voice={{ src, durationMs, peaks, transcript }} active={active}
  elapsedMs={playback.elapsedMs} playing={playback.playing}
  alignment={alignment} />
```

Use `interactionKey(identity)` in the existing playback `ownerKey` (alongside original src scope if desired), rather than only agent/tab/src. Keep hook cleanup; on active=false/Stop call its existing `stopAudio`, and disable/gate Play/Seek while inactive. Root must mount these actions in the existing message group so original hover/focus/touch classes apply. No additional player, recording hook, microphone lifecycle or audio fetch is introduced. Copy always uses the saved transcript and never copies the marker URL. `alignment` stays undefined for current artifacts; do not invoke a provider on expand/copy/play and do not fabricate metadata. A future genuine saved alignment source must be bound to exact identity+src and exact original text/duration before passing it.

### 6. Registration, migration and lifecycle

No new routes, grants, tool/provider registrations, object buckets, credential stores or DB migrations are introduced. Existing authenticated questions/draft/voice routes and tool grants remain authoritative. The only protocol activation is the question v2 preparation/projection above; root/I own central protocol gating and any future migration allocation. Do not rewrite stored questions/receipts, re-import Round36 contracts or mount H's recovery UI from this lane. Mount components in current chat only, preserving the board, selected tabs and unrelated drafts. Root performs narrow/short-window execution checks; source preserves original constrained scroll areas, truncation/wrapping, explicit non-submit controls and visible focus/touch actions.

## Implemented / dependent / unsupported matrix

| Capability | Owned source | Root dependency / limit |
| --- | --- | --- |
| Headers, described choices, legacy strings, custom/Skip/dismiss | Implemented in shared form and strict versioned projection | Engine schema/stamping, desktop DTO and question consumer activation above |
| Existing question fingerprints/receipt text | Legacy reading/serialization preserved; byte fixtures authored | Root must use returned fingerprint and never rewrite saved rows |
| Duplicate answer and uncertain same-ID recovery | Adapter + existing card/receipt integration | Canonical server receipt and exact SDK Stop lifecycle stay root-owned |
| Original quick-reply value rules | Implemented original helpers/filter; concrete draft adapter and chip wrapper | Replace root consumer; keep trusted send guard/ACK path |
| Dirty draft preservation and persistence | Actual canonical writer used, exact attempt retained on failure | Existing draft save retry; no tabless unsaved draft insertion |
| Transcript/Copy transcript arrangement | Original-style actions, actual saved transcript, existing copy feedback | Bubble/history mounting and current identity/playback props |
| Heard word progress | Genuine metadata validation and presentation implemented | No current Mac alignment producer/storage; plain text today |
| Synthetic text-derived timing, automatic STT setup or generated transcript | Unsupported intentionally | No provider call/configuration inference or fake times |
| New recording/player/runtime/permissions | Not introduced | Accepted generic voice lifecycle unchanged; root owns lifecycle composition |
| Installed/board/restart acceptance | Pending | No execution by this lane |

## Persistence, recovery and failure behavior

| Situation | Behavior and recovery |
| --- | --- |
| Old pending question reopened | Identical legacy fingerprint and ID; reads do not stamp, answer or generate a turn |
| New described/header question | Explicit v2 projection binds visible choices/header to guard; raw source bytes are not modified by reads |
| Malformed/future question version | No actionable projected form; root/I show existing non-actionable protocol fallback |
| Answer ACK lost | Adapter keeps exact intent/request; canonical existing server stores receipt/guard/text and reconciles that request before checking pending status |
| Answer accepted after source switch/Stop | Committed receipt remains accepted; stale UI update rejected; no new request/turn manufactured |
| Resolved question after restart | Canonical read suppresses accepted card; mounting/history never submits again |
| Missing promised value | Announcement goes only into empty saved draft; future promise hidden; user completes and explicitly sends |
| Existing dirty/attachment/mention draft | Kept intact; insertion blocked, no send |
| Draft ACK failure / changed tab while saving | Canonical attempt survives; no focus/update of new owner; existing save-retry/restart reconciliation applies |
| Copy denied/no current source | Real copy error or stale no-op; no permission workaround, no message send |
| Missing/inconsistent alignment after remount | Plain saved transcript, same URL/player; no estimates/provider requests |
| Dispose / Stop / workspace switch | Owned pending adapter signal aborted on disposal, callbacks fenced by live exact owner; root keeps exact run/SDK/player Stop handling and genuine errors |

No owned component performs effects on mount/restore other than local observer/ref lifecycle. The quick-reply adapter's update/save happens only on a human chip activation; clipboard only on an active human copy gesture; question dispatch only on explicit answer/retry/dismiss. Durable authority remains canonical SQLite question receipts, tab draft revisions/attempts and saved voice artifacts. No second journal or database was added.

## Authored regression sources — unrun

- Persisted singular/batch legacy payload bytes, old ignored headers, unchanged SHA input/digest and serialized legacy receipt text; v2 described/header projection without raw mutation, malformed/unknown marker refusal.
- Concurrent/duplicate answer coalescing, conflicting-request refusal, explicit restored attempt retry, lost ACK reusing the same request ID, late accepted receipt after source change and closed/Stopped adapter refusal.
- Real shared QuestionForm header/description, label-only answer, synchronous double-click latch, non-submit controls, legacy Skip/dismiss and custom Unicode answer retained through failed acknowledgement/retry.
- Original announcement/promise exceptions; real canonical draft writer with offline response fixtures; dirty draft preservation; lost draft ACK retains immutable attempt and cannot focus changed chat; accepted-send boolean and adapter close.
- Real voice action components and copy affordance with offline clipboard event fixtures: exact saved transcript copy, Copied! feedback, non-submit buttons, keyed same-text message reset and stale workspace refusal. No audio/microphone instantiated by the owned action component.
- Genuine Unicode interval data, untimed punctuation and exact millisecond progress; missing/partial/invalid metadata and same-text wrong-message/wrong-src fallback; remount without metadata returns plain transcript.

These are authored sources, not validation evidence. Root must review and execute all checks and native acceptance, including clipboard behavior, accessibility, narrow/short layout, engine v2 stream/persistence parity, Stop races and full restart. Source implementation alone does not accept C4/C5/C8.
