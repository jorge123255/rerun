# Desktop composer image input (Agent B / C3)

Real PNG/JPEG/WebP attachments for the desktop composer, alongside the existing .txt/.md
flow. Images are validated, imported into the selected coworker's visible Files workspace, and
pinned as content-addressed snapshots so a sent turn can never silently read replacement bytes.

## What this lane owns (new files)

| File | Role |
| --- | --- |
| `apps/ui/lib/desktop/composer-image.ts` | Accept list, limits, kinds, snapshot schema, ordered attachment union, preflight, dataTransfer extraction, import client, request/provider part builders |
| `apps/ui/lib/desktop/composer-image-attempts.ts` | Image-shaped attempt records against the shared `/upload-attempts` endpoint |
| `apps/ui/lib/desktop/use-composer-image-uploads.ts` | Owner-scoped upload hook: reserve → import → confirm → dismiss, retry/cancel/settle, thumbnail object URLs |
| `apps/ui/components/desktop/DesktopImageUploadChips.tsx` | Thumbnail chips with truthful queued/importing/error/unresolved states |
| `apps/ui/lib/desktop/server/composer-image-files.ts` | Server validation (structure + sharp pixel decode), visible import, snapshot store, verified reads, prune |
| `apps/ui/app/api/desktop/agents/[agentId]/images/route.ts` | `POST` image import route |
| `apps/ui/lib/desktop/composer-image.test.ts`, `apps/ui/lib/desktop/server/composer-image-files.test.ts` | Regressions (authored, not run here) |

## Flow

1. Picker/drop/paste → `desktopImageFilesFromDataTransfer` / file input yields `File`s; text
   files keep flowing to `useDesktopComposerUploads`, images to `useDesktopComposerImageUploads`.
2. `preflightDesktopImages` refuses bad names, non-PNG/JPEG/WebP, wrong magic, >8 MiB, >4 files,
   >16 MiB aggregate, and (when `createImageBitmap` exists) over-dimensioned images.
3. `POST /api/desktop/agents/:id/images` → `importDesktopComposerImage`:
   - name/extension/size checks, `inspectDesktopImageBytes` (CRC'd PNG chunks, JPEG marker walk,
     WebP RIFF chunks; rejects APNG/ANIM/ANMF/VP8X-animation/multi-frame), then a real pixel
     decode via `sharp().stats()`; animated or corrupt data → 415, oversize → 413.
   - writes the visible file create-only into the coworker's workspace (same temp+link pattern
     as text imports; 409 on name clash).
   - writes `<dataRoot>/workspaces/1/engine/agents/<engineAgentId>/chat-images/<sha256>.<ext>`
     create-only — private, outside the Files tree.
   - returns `{ path, name, image: DesktopImageSnapshot }` where the snapshot is
     `{ sha256, name, path, mediaType, width, height, byteLength }`.
4. `onConfirmed(image)` attaches the snapshot to the draft's ordered attachment list.
5. Send: UI server resolves each image snapshot via `readDesktopImageSnapshots` (re-hashes bytes;
   mismatch → 409), builds `dataBase64`, and sends ordered `attachmentItems` to the engine.
6. Engine builds AI SDK `file` parts (`desktopImageProviderParts` shape) in attachment order.
   The Codex app-server provider writes each part's bytes to its own temp file and emits a
   `localImage` turn input — no host path, workspace path, or URL reaches the model.
7. `pruneDesktopImageSnapshots(agentId, keep)` garbage-collects snapshots no draft/queue item
   references. Sent messages persist the resolved bytes, so history/regeneration never need the
   store.

## Limits

- Per image: 8 MiB (`DESKTOP_IMAGE_MAX_BYTES`), 8192 px edge, 16,777,216 px (`image-bytes.ts`).
- Composer: 4 images, 16 MiB aggregate (`DESKTOP_IMAGE_ATTACHMENT_*`), independent of the
  10-file/128 KiB text budget. GIF and every other type are refused.

## Required root wiring (additive fragments)

### 1. `apps/ui/lib/desktop/composer-upload-attempts.ts` — accept image attempts

The shared attempts endpoint stores whatever the zod schema allows. Widen it so image names and
sizes validate (text rules unchanged):

```ts
import { DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES, desktopImageKindForName } from './composer-image'
// in desktopUploadAttemptSchema:
name: z.string().min(1).max(255).refine(name =>
    new TextEncoder().encode(name).length <= 255 && !/[\\/\p{Cc}]/u.test(name) && !name.startsWith('.')
    && (/\.(?:txt|md)$/i.test(name) || !!desktopImageKindForName(name))),
size: z.number().int().min(0).max(DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES),
```

Until this lands, image reservations POST fine but the client-side response parse fails, so
image uploads surface the generic "could not save upload status" notice. Text uploads are
unaffected.

### 2. `apps/ui/components/desktop/DesktopConversation.tsx` — mount

```ts
import { useDesktopComposerImageUploads } from '@/lib/desktop/use-composer-image-uploads'
import { DesktopImageUploadChips } from './DesktopImageUploadChips'
import { desktopImageFilesFromDataTransfer, DESKTOP_IMAGE_UPLOAD_ACCEPT, type DesktopImageSnapshot, type DesktopComposerAttachmentItem } from '@/lib/desktop/composer-image'

// ordered union state (replaces/augments attachmentPaths once images exist):
//   items: DesktopComposerAttachmentItem[]  — {type:'text',path} | {type:'image',image}
const imageUploads = useDesktopComposerImageUploads({
    agentId: agent.id, ownerKey: draftKey, tabUid,
    active: /* same gate as text uploads */,
    attachedImages: items.filter(i => i.type === 'image').map(i => i.image),
    onConfirmed: async image => setDraftItems(draftKey, [...composer.current.items, { type: 'image', image }]),
    onNotice: setUploadNotice,
})

// picker: second hidden input accept={DESKTOP_IMAGE_UPLOAD_ACCEPT} → imageUploads.start(files)
// drop/paste on the composer form:
const imageFiles = desktopImageFilesFromDataTransfer(event.dataTransfer)
const textFiles = Array.from(event.dataTransfer.files).filter(f => !desktopImageKindForName(f.name))
if (imageFiles.length) void imageUploads.start(imageFiles)
if (textFiles.length) beginUpload(textFiles)
// render <DesktopImageUploadChips items={imageUploadItems} .../> beside <DesktopUploadChips/>
// send gate: await imageUploads.settle() together with settleUploads(); blocked = imageUploads.hasBlocked()
```

Ordered mixed attachments: keep ONE ordered `DesktopComposerAttachmentItem[]` per draft. Text
entries keep flowing through the existing `attachmentPaths` draft field while a draft has text
only; once images are present, persist `attachmentItems` (fragment 3) so interleaving survives
reload/queue. `desktopAttachmentPathsOf`-style helpers derive the legacy fields for back-compat.

### 3. Draft / queue / chat schemas (root-owned)

Additive field on drafts, queued turns, and the chat send body:

```ts
attachmentItems: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), path: desktopAttachmentPathSchema }),
    z.object({ type: z.literal('image'), image: desktopImageSnapshotSchema }),
])).max(DESKTOP_ATTACHMENT_MAX_FILES + DESKTOP_IMAGE_ATTACHMENT_MAX_FILES).optional()
```

`desktopImageSnapshotSchema` is exported from `composer-image.ts` (apps/ui). The engine-side
mirror belongs in `packages/contracts` next to `desktop-attachment.ts`.

### 4. `apps/ui/lib/desktop/server/engine.ts` — resolve before send

```ts
import { readDesktopImageSnapshots } from './composer-image-files'
import { desktopImageRequestAttachments } from '@/lib/desktop/composer-image'

// for each image item, in order:
const resolved = await readDesktopImageSnapshots(runtime, agent.id, imageItems.map(i => i.image))
const imageAttachments = desktopImageRequestAttachments(
    imageItems.map(item => ({ image: item.image, dataBase64: Buffer.from(resolved.get(item.image.sha256)!).toString('base64') })))
// merge with text items preserving attachmentItems order → body.attachmentItems
```

`readDesktopImageSnapshot` re-hashes bytes and throws 409 on mismatch — replacement bytes fail
loudly instead of silently shipping.

### 5. Engine chat route / runtime / provider seam (root-owned)

- Accept `attachmentItems` (or equivalent ordered field) in `desktopChatRequest`; keep
  `attachmentPath(s)`/`workspaceAttachment(s)` working unchanged for text-only traffic.
- Build user content parts IN ORDER: text → existing workspace-attachment text part; image →
  `{ type: 'file', data: <bytes>, mediaType, filename }` (`desktopImageProviderParts` shape).
- Capability gate BEFORE building parts: if any image item exists and the resolved provider
  cannot accept image file parts, fail with a clear 4xx ("this coworker's model does not accept
  image attachments"). Codex app-server (`supportsImageUrls`, `localImage` conversion) accepts;
  Codex exec (`supportsImageUrls = false`) and text-only providers must refuse.
- Persisted message parts carry the resolved bytes, so retries/queue/history/regeneration replay
  identical content. Queued-turn reconcile paths must carry `attachmentItems` just like
  `attachmentPaths` today.

### 6. Snapshot cleanup

Call `pruneDesktopImageSnapshots(runtime, agentId, keep)` where `keep` = sha256 of every image
referenced by live drafts + queued turns for that coworker (sent history needs none — bytes are
persisted in the message). Safe points: after a successful send clears the draft, on draft
delete, on coworker deletion (cascade removes the agent dir anyway).

## Mac storage/runtime notes

- Snapshots live at `<dataRoot>/workspaces/1/engine/agents/<engineAgentId>/chat-images/` —
  sibling of `workspace/`, so they are private (never listed by Files routes, which are
  contained to `workspace/`) but on the same volume as the engine data dir. No new storage
  service; cleanup is explicit via `pruneDesktopImageSnapshots`.
- The visible import reuses the workspace path rules (contained realpath, pinned-dir
  temp+link, create-only). It does NOT run `recoverInterruptedCoworkerEdits`/save-lock checks
  that `importCoworkerFile` uses — a crashed text edit in the same folder is not awaited before
  an image import. Root may dedupe by exporting those helpers from `coworker-files.ts`.
- `sharp` is already an apps/ui dependency; the decode pass is bounded by the 8 MiB/16 MP caps.
- Client decode uses `createImageBitmap` when present (dimension pre-check only); authoritative
  validation is always server-side.

## Limitations

- Animated images are refused (APNG, animated WebP, multi-frame GIF — GIF is unsupported
  outright for attachments).
- Images attach only through picker/drop/paste of local files; the Files picker
  (`DesktopAttachmentPicker`) still lists text files only.
- Regeneration of a message sent before this feature, or with images, depends on root's
  engine-side part persistence — this lane supplies helpers and fragments only.
- No checks, typecheck, lint, build, or Mac acceptance were run in this lane.
