# Round 33 B — document attachments handoff

Base: `56fdce61a780e005644057cc77d8edebbf0d067a`.

Source handoff only. Root owns integration, repairs, all checks, provider/model identity, permissions, canonical native readers, and full-restart acceptance.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/chat/ChatComposer.tsx`: immediate ordered uploads, progress/retry/remove, send blocked by unfinished/failed files, original attachment marker and voice coexistence.
- `apps/ui/components/chat/ChatAttachments.tsx`: ordered chips and paperclip behavior.
- `apps/ui/components/chat/AttachmentLightbox.tsx`: paged navigation, original names, preview and generic download.
- `apps/ui/lib/chat/attachments-marker.ts` and `packages/contracts/src/chat-attachments.ts`: ordered marker and unique display names.
- `apps/ui/lib/files/upload.ts`: picker/drop/paste intake.
- `apps/ui/components/files/FilePreview.tsx`: image/PDF/audio/video/text/generic presentation.

Accepted Mac text/image upload/draft/queue behavior and Round32 B voice handoff were used as dependency references. Existing Mac PDF text extraction, PDF/audio/video readers, immutable image snapshots, and `desktopRoute` authentication remain canonical. No Office parser or general video-understanding capability was invented.

## Exported owned surface

- `packages/contracts/src/desktop-document-attachments.ts`: scope, kind, conversion state/mode, immutable attachment, upload/revision actions, ordered references, model inputs and admission.
- `apps/ui/lib/desktop/document-attachments/client.ts`: typed same-origin client and immutable read URL.
- `useDesktopDocumentAttachments.ts`: picker/drop/paste controller with ordered intake, caps, retry/remove, restore and admission.
- `apps/ui/lib/desktop/server/document-attachments/types.ts`: owner/store/blob/PDF/audio/staging/reference authorities.
- `bytes.ts`: actual extension/MIME/magic/size validation and SHA-256 identity.
- `store.ts`: `desktopDocumentAttachmentsSchemaSql`, `ensureDesktopDocumentAttachmentsSchema`, `desktopDocumentStore`.
- `service.ts`: `createDesktopDocumentAttachmentService` for upload/convert/admission/list/discard/read.
- `api.ts`: `desktopDocumentAttachmentsApi`, `desktopDocumentAttachmentHandlers`.
- `binding.ts`: `bindDesktopDocumentAttachments`, fail-closed `desktopDocumentAttachmentService`.
- `apps/ui/app/api/desktop/coworkers/[agentId]/document-attachments/route.ts`: canonical authenticated route.
- `apps/ui/components/desktop/document-attachments/`: ordered chips, picker, attachment view and paged lightbox.

No existing composer, voice, draft, queue, history, result-card, reader, schema/bootstrap or barrel was edited.

## Required root integration

### Contract and schema

Export the new contract centrally after review:

```ts
export * from './desktop-document-attachments.js'
```

Append `desktopDocumentAttachmentsSchemaSql` as a new numbered central SQLite migration with a previous-version regression. It stores safe attachment metadata, conversion state and `admitted` state only. Audio bytes and credentials are not stored in this table.

### Authorities and route

```ts
const service = createDesktopDocumentAttachmentService({
    store: desktopDocumentStore(db),
    blobs: desktopDocumentBlobAuthority,
    owner: (scope, signal) => authorizeDesktopDocumentScope(runtime, scope, signal),
    references: (scope, attachmentId) =>
        desktopDocumentReferenceExists(runtime, scope, attachmentId),
    extractPdfText: (bytes, signal) => extractDesktopPdfText(bytes, { signal }),
    transcribeAudio: configuredAudioTranscriber?.transcribe,
    stagedFileSupported: (kind, mimeType) =>
        supportsModelFileInput(currentModel, kind, mimeType),
    stageFile: (scope, attachment, bytes, signal) =>
        stageDesktopModelFile(runtime, scope, attachment, bytes, signal),
})

bindDesktopDocumentAttachments(service)
```

`authorizeDesktopDocumentScope` validates the exact local coworker/tab/session, deletion state and abort signal. `desktopDocumentBlobAuthority` implements create/reconcile/read/delete only for exact immutable `{attachmentId,sha256,byteLength,mimeType}` under root-owned storage; links, replacement files, traversal and remote paths are refused.

`extractDesktopPdfText` uses the accepted packaged helper and its existing byte/time/output bounds. `transcribeAudio` is optional and must use the explicitly configured Round32 voice-transcription authority when available. It must not select another backend or charge/download anything implicitly.

`supportsModelFileInput` and `stageDesktopModelFile` decide whether the current model can actually receive a staged file. A filename or MIME label alone is not proof of support. Staging is root-authorized, immutable and owner-bound. Video without such support is download-only.

`desktopDocumentReferenceExists` checks saved history plus drafts/queues/other tabs. Sent or referenced attachments cannot be deleted.

The canonical route already exists at `apps/ui/app/api/desktop/coworkers/[agentId]/document-attachments/route.ts`. Unbound requests return an explicit unavailable response rather than constructing a parallel runtime.

### Admission and existing send authority

Root calls the controller's `settle()` before send/queue/regeneration. The service returns:

```ts
type DesktopDocumentAdmission = {
    allowed: boolean
    reason?: string
    references: DesktopDocumentReference[]
    inputs: Array<
        | { mode: 'text'; text: string }
        | { mode: 'file'; reference: DesktopDocumentReference }
    >
}
```

`allowed` is true only when every attachment has a supported ready input. Pending/converting/failed/unsupported states return no admission and explain the limit before send. A successful admission durably sets `admitted`, so removal cannot race a queued send.

Root maps ordered `references` and `inputs` into the existing draft/queue/history/regeneration payload, preserving accepted text/image references and original filenames. Do not create another send marker or bypass the existing provider adapters. Text from PDF/audio conversion is actual model input; staged references are the only file inputs. Unsupported content is never replaced by a filename or a claim that the model read it.

### Picker and saved lightbox

```tsx
<DesktopDocumentAttachmentControls
    agentId={agent.id}
    tabUid={tabUid}
    sessionId={sessionId ?? undefined}
/>
```

Use `useDesktopDocumentAttachments` directly for `settle`, `retry`, and `remove`. The controller never edits typed text, existing attachments, voice recordings or round31 mention state.

`DesktopDocumentLightbox` receives `urlsFor(attachment)` from root. Each result is `{previewUrl,downloadUrl}` using the accepted native PDF/audio/video reader or download authority, exact owner and immutable identity. Root chooses the correct existing route and does not route these attachments through a new generic Files reader.

Opening history only renders metadata. Playback does not autostart. The lightbox preserves the original title, `index + 1 / count`, previous/next controls, original names and generic download.

## API formats

Base: `/api/desktop/coworkers/[agentId]/document-attachments`.

- GET `?tabUid=...&sessionId=...` → `{attachments: DesktopDocumentAttachment[]}`.
- GET `?tabUid=...&attachmentId=...&view=read` → exact immutable bytes/MIME with `nosniff`, no-store.
- POST `{operation:'upload',agentId,tabUid,sessionId?,attachmentId,name,mimeType,audioBase64}` → `{attachment}`. Base64 and decoded bytes are bounded; actual extension/MIME/magic is validated before reservation.
- POST `{operation:'convert',tabUid,sessionId?,attachmentId,expectedRevision}` → `{attachment}`.
- POST `{operation:'admission',tabUid,sessionId?}` → `{allowed,reason?,references,inputs}`.
- POST `{operation:'discard',tabUid,sessionId?,attachmentId,expectedRevision}` → `{discarded:true}`.

Upload reserves hash/owner/conversion state before publication, reconciles duplicate attempts without orphan blobs and refuses conflicting identity/scope/bytes. Conversion and admission are explicit operations, never restart hooks.

## Lifecycle and failure semantics

- Intake preserves order, original names, per-file 16 MiB and aggregate 48 MiB/ten-file caps. Empty/oversized selections are reported rather than silently dropped.
- Actual bytes are frozen and hashed before references can be admitted. Read/recovery verifies byte length and SHA-256.
- PDF uses accepted text extraction; audio uses optional configured transcription; staged files require explicit model support. Other combinations remain visible as unsupported and block send truthfully.
- Upload/conversion failures retain bytes for retry. Restart restores pending/failed outcomes without replaying conversion or send. Pending work is not claimed complete.
- Admission is ordered and preserves original-copy isolation. Text/image and voice behavior is not replaced.
- Discard aborts owned work and deletes only exact unreferenced staging. Sent, admitted or otherwise referenced bytes are retained.
- Stale owner/tab responses cannot update another chat. Lightbox identity changes release old previews/playback.

## Implemented / dependent / unsupported matrix

| Area | Owned implementation | Root dependency or unsupported remainder |
| --- | --- | --- |
| Contract, immutable upload and byte validation | Implemented | Central export and numbered migration |
| Picker/drop/paste, chips and retry/remove | Implemented | Composer mounting |
| PDF text conversion | Implemented | Packaged helper and real extraction QA |
| Audio transcription | Optional port and unavailable state | Round32 authorized backend |
| Model-staged files | Port and immutable reference | Current-model support and staging authority |
| Ordered admission and restart restore | Implemented | Existing draft/queue/history/provider mapping |
| Paged lightbox and generic download | Implemented | Canonical native reader/download URLs |
| Reference-safe cleanup | Implemented | Root’s complete reference checks |
| General Office parsing/video understanding | Unsupported | Must not be inferred |
| Automatic conversion/send on restart | Explicitly refused | Must remain unsupported |
| Real upload/conversion/send/playback/restart acceptance | Not run | Root performs all checks |

## Regression sources authored and unrun

- `apps/ui/lib/desktop/server/document-attachments/bytes.test.ts`: byte identity, magic/MIME, traversal and metadata refusal.
- `apps/ui/lib/desktop/server/document-attachments/service.test.ts`: duplicate/conflicting upload, PDF conversion/admission, unsupported combinations, conversion failure/restart, cleanup references and owner checks.
- `apps/ui/lib/desktop/document-attachments/useDesktopDocumentAttachments.test.tsx`: ordered intake, lost-upload retry and no restart conversion replay.
- `apps/ui/components/desktop/document-attachments/DesktopDocumentLightbox.test.tsx`: saved identity, paging, generic download and no autoplay.

No tests, typecheck, lint, builds, installs, servers, UI interactions, provider/API/network calls, media capture/playback, Docker, Keychain, push or merge were run. Root execution and native/restart acceptance remain pending.
