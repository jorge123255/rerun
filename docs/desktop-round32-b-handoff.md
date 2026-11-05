# Round 32 B — desktop voice composer handoff

Base: `ab0de35eb45fbcf0b801943fd8ad7c3c861b9210`.

Source handoff only. Root owns integration, repairs, all execution checks, permissions, backend selection, and real recording/review/send/playback/restart acceptance.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/hooks/useVoiceRecorder.ts`: gesture-only capture, AAC-first plus backup encoding, analyser sampling, generation guards, duration cap and hardware disposal.
- `apps/ui/hooks/useVoiceMessage.ts`: upload/transcription/send lifecycle and retention after failure. Original Finish sends directly; this Mac adapter deliberately inserts local review before transcription and a separate acknowledged Send.
- `apps/ui/components/chat/VoiceComposerControls.tsx`, `VoiceRecorderBar.tsx`, `VoiceWaveform.tsx`, `VoiceMessageBubble.tsx`: microphone/discard/send/retry controls, live recorder bar, waveform/progress and lazy audio player.
- `apps/ui/lib/voice/client.ts`, `recording.ts`, `duration.ts`, `marker.ts`, `peaks.ts`: original upload errors, 32 kbps format fallback, duration formatting and marker/waveform helpers.
- `packages/contracts/src/voice.ts`: five-minute cap, 48-peak encoding and voice marker parser/builders.
- `apps/ui/app/api/voice/transcribe/route.ts` and `apps/ui/lib/ai/transcribe.ts`: hosted transcription flow. Its OpenRouter key/model/provider behavior is not used or assumed.

The new controls preserve the original `PromptInputButton` variants, icon ordering, recorder bar, 50 ms duration polling, responsive truncation and accessible labels. Stop now produces a local review; Transcribe and Send are separate user actions.

## Exported owned surface

- `packages/contracts/src/desktop-voice.ts`: lifecycle, scope, format, recording/draft metadata, upload/revision actions, send receipt, duration/byte/level limits.
- `apps/ui/lib/desktop/voice/useDesktopVoiceRecorder.ts`: bounded `MediaRecorder`/stream/analyser hook.
- `apps/ui/lib/desktop/voice/useDesktopVoiceMessage.ts`: review/upload/transcribe/send/retry/discard/re-record/restore controller.
- `apps/ui/lib/desktop/voice/client.ts`: typed same-origin API client.
- `apps/ui/lib/desktop/voice/voice.ts`: attempt fingerprints, canonical audio references and original marker construction.
- `apps/ui/lib/desktop/voice/useDesktopVoicePlayback.ts`: lazy playback, seek, elapsed/progress, fetch/URL cleanup.
- `apps/ui/components/desktop/voice/DesktopVoiceComposer.tsx`: complete composer adapter.
- `DesktopVoiceComposerControls.tsx`, `DesktopVoiceRecorderBar.tsx`, `DesktopVoiceReview.tsx`, `DesktopVoiceWaveform.tsx`, `DesktopVoiceMessageBubble.tsx`: original visual adapters.
- `apps/ui/lib/desktop/server/voice/types.ts`: owner/store/blob/transcription/send/reference authority interfaces.
- `store.ts`: `ensureDesktopVoiceSchema`, `desktopVoiceStore`, `desktopVoiceSchemaSql`.
- `bytes.ts`: MIME/magic/duration/waveform/byte validation and SHA-256 identity.
- `service.ts`: `createDesktopVoiceService` for upload/draft/list/transcribe/send/discard/audio.
- `api.ts`: `desktopVoiceApi`, `desktopVoiceHandlers` using `desktopRoute` authentication.
- `binding.ts`: `bindDesktopVoiceService` and fail-closed `desktopVoiceService` for the canonical route at `apps/ui/app/api/desktop/coworkers/[agentId]/voice/route.ts`.

No barrel `index.ts` was edited or created.

## Required root integration

### Contract and schema

Export the contract centrally after review:

```ts
export * from './desktop-voice.js'
```

Append `desktopVoiceSchemaSql` as a new numbered central SQLite migration with its previous-version regression. Do not initialize the table in request handlers. The table stores attempt state and safe metadata only, not audio bytes or credentials.

### Authority construction

```ts
const service = createDesktopVoiceService({
    store: desktopVoiceStore(db),
    blobs: desktopVoiceBlobAuthority,
    owner: (scope, signal) => authorizeDesktopVoiceScope(runtime, scope, signal),
    send: input => sendDesktopVoiceTranscript(runtime, input),
    references: (scope, attemptId) => desktopVoiceReferenceExists(runtime, scope, attemptId),
    transcribe: configuredDesktopTranscriber?.transcribe,
})

bindDesktopVoiceService(service)

const handlers = desktopVoiceHandlers(service)
export const GET = handlers.GET
export const POST = handlers.POST
```

Root must supply one authority-owned service instance per current runtime. If renderer and service are in separate processes, use the existing authenticated IPC boundary rather than constructing a parallel store/provider runtime.

`authorizeDesktopVoiceScope` validates the current local coworker, exact tab and optional session, deletion state and abort signal. `desktopVoiceBlobAuthority` implements immutable private create/reconcile/read/delete for exact `{attemptId,sha256,mimeType,byteLength}` under root-owned storage. It must reject links, replacement identities, traversal and remote paths. Audio is never accepted as a remote URL or renderer filesystem path.

`sendDesktopVoiceTranscript` is the exact owner/tab chat or queue admission callback. It must make the attempt ID idempotent, reconcile a lost acknowledgement before another submission, and return `{messageId:string|null}` only after acknowledgment. Only the transcript is model input. The returned `text` also carries the original voice marker for history/player use; do not claim raw-audio model support.

`desktopVoiceReferenceExists` checks saved messages plus draft/queue/history references and other tabs. Sent audio and referenced audio cannot be deleted. Cleanup deletes bytes before metadata only when the exact attempt is unreferenced.

### Transcription backend

`DesktopVoiceTranscriptionPort` is required for transcription but optional at construction. Root explicitly configures and authorizes it. If absent, the service returns `phase:'unavailable'`; the recording remains playable/reviewable and no audio leaves the Mac for transcription. No Codex/ChatGPT capability, hosted OpenRouter key, paid backend, unrelated credential or local model download is inferred.

The port receives `{bytes,format,signal}`. Root enforces its backend deadline/cancellation and safe errors. Service cancellation/failure retains the upload. Empty results return to review with an honest unintelligible message.

### Composer and history

Mount `DesktopVoiceComposer` at the existing composer voice-control position, retaining typed text and attachment state in the parent:

```tsx
<DesktopVoiceComposer
    agentId={agent.id}
    tabUid={tabUid}
    sessionId={sessionId ?? undefined}
    besideSend={hasOtherComposerContent}
    onSent={({ draft, text }) => reconcileVoiceSend(draft, text)}
/>
```

`onSent` refreshes/reconciles only after acknowledged send. It does not perform another submission. Root decides whether to hide the textarea during recording/review without unmounting its draft. The controller never edits typed text, attachments or round31 mention state.

For saved history, use the original `parseVoiceMessage` and mount:

```tsx
<DesktopVoiceMessageBubble
    scope={{ agentId, tabUid, sessionId }}
    src={voice.src}
    durationMs={voice.durationMs}
    peaks={voice.peaks}
    transcript={voice.transcript}
/>
```

Opening history only renders metadata. Fetch occurs on explicit Play, never on mount, and never transcribes or sends.

### Microphone/platform permissions

Root owns all permission/startup changes. Provide the macOS `NSMicrophoneUsageDescription` string and Electron media permission request/check handlers for the current session. Permit audio capture only after the explicit Record gesture and only for the local app. Do not auto-grant on retry, tab switch or restart. Device denial/busy/removal stays in the composer with recording hardware released.

## API formats

Base route: `/api/desktop/coworkers/[agentId]/voice`.

- GET `?tabUid=...&sessionId=...` → `{drafts: DesktopVoiceDraft[]}`.
- GET `?tabUid=...&sessionId=...&attemptId=...` → `{draft: DesktopVoiceDraft|null}`.
- GET `?tabUid=...&attemptId=...&view=audio` → immutable audio bytes with exact MIME, length, `nosniff`, no-store.
- POST `{operation:'upload',agentId,tabUid,sessionId?,attemptId,format,durationMs,levels,audioBase64}` → `{draft}`. Base64 is bounded and canonical; decoded bytes are limited to 2 MiB and checked by magic/MIME/duration/waveform.
- POST `{operation:'transcribe',tabUid,sessionId?,attemptId,expectedRevision}` → `{draft}`.
- POST `{operation:'send',tabUid,sessionId?,attemptId,expectedRevision}` → `{draft,text}` where `text` is nullable only when no transcript was admitted.
- POST `{operation:'discard',tabUid,sessionId?,attemptId,expectedRevision}` → `{discarded:true}`.

All operations use current owner checks and revision-CAS where applicable. Upload computes the byte hash before reservation, reserves before publication, and reconciles duplicate attempts without orphan copies. Conflicting scope/bytes under one attempt refuses.

## Lifecycle and failure semantics

- Start only on gesture. Original format fallback and five-minute cap are retained. Encoded bytes are also capped at 2 MiB; a cap enters review with bounded partial audio, not a model send.
- Cancel, supersession and unmount stop tracks, recorder events, analyser/context/timers. Late permission resolution cannot start capture after cancellation.
- Stop returns local playback/review. Transcribe performs durable upload and configured transcription. Send is a separate acknowledged action.
- Restored `uploading`, `transcribing` and `sending` records return to review without automatic replay. `ready` restores transcript; `sent` restores history only.
- Upload/transcription/send failures retain the reusable recording and any transcript. Retry reuses attempt ID and prior results. Empty/unintelligible transcripts never send.
- Missing storage is an explicit failed state; unacknowledged microphone chunks are not claimed recoverable.
- Stored bytes are verified by length and SHA-256 before recovery or playback. Duplicate upload after ready/sent does not roll state backward, and an already acknowledged send returns its sealed state.
- Playback fetches lazily, validates reference/MIME/byte bounds, and aborts/releases URLs on owner/tab/unmount. Transcript toggle has no side effects.

## Implemented / dependent / unsupported matrix

| Area | Owned implementation | Root dependency or unsupported remainder |
| --- | --- | --- |
| Voice contract and limits | Implemented | Central export required |
| Recorder, fallback, caps and cleanup | Implemented | Electron/macOS permission and real device QA required |
| Review, playback, discard, retry | Implemented | Composer mounting required |
| Durable upload and restore | Implemented | Numbered migration and exact blob authority required |
| Configured transcription | Port, lifecycle and unavailable state implemented | Authorized backend and real transcription QA required |
| Acknowledged send | Port and idempotent lifecycle implemented | Exact chat/queue/history admission and lost-ack QA required |
| Saved player and transcript toggle | Implemented | History renderer mounting required |
| Reference-safe cleanup | Implemented | Root’s draft/queue/history reference checks required |
| Hosted OpenRouter/paid backend selection | Not used | Root chooses any explicitly authorized backend |
| Generic raw-audio model input | Unsupported | Only transcript is sent to the model |
| Automatic capture/transcribe/send on restart | Explicitly refused | Must remain unsupported |
| Real recording/playback/network/restart acceptance | Not run | Root performs all checks |

## Regression sources authored and unrun

- `apps/ui/lib/desktop/voice/voice.test.ts`: scope fingerprints, canonical references, original marker round-trip.
- `apps/ui/lib/desktop/voice/useDesktopVoiceRecorder.test.tsx`: denial, late grant, backup codec, byte cap, empty audio and hardware cleanup.
- `apps/ui/lib/desktop/voice/useDesktopVoiceMessage.test.tsx`: restart without work, lost send acknowledgement, exact retry/discard.
- `apps/ui/lib/desktop/server/voice/bytes.test.ts`: magic, empty, duration and waveform bounds.
- `apps/ui/lib/desktop/server/voice/service.test.ts`: duplicate/conflicting upload, unavailable transcription, transcription/send retry, cancellation, restore, missing bytes, reference cleanup and owner checks.
- `apps/ui/components/desktop/voice/DesktopVoiceMessageBubble.test.tsx`: lazy saved playback identity, transcript toggle and remote/different-owner refusal.

No tests, typecheck, lint, builds, installs, servers, UI interactions, provider/API/network calls, capture/playback, Docker, Keychain, push or merge were run. Root execution and native/restart acceptance remain pending.
