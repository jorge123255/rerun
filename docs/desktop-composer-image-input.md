# Desktop composer image input

The desktop composer accepts PNG/JPEG/WebP images alongside `.txt`/`.md` references. It follows
Rerun's existing composer attachment chips, upload states, image preview, and Codex app-server
file-part path. Desktop ownership, saved drafts, acknowledgement receipts, and private snapshots
are explicit because this app has local coworkers rather than the hosted upload store.

Original design sources are `components/chat/ChatComposer.tsx`, `ChatAttachments.tsx`,
`ChatAttachmentChip.tsx`, and the existing image/lightbox rendering. The engine continues through
its existing `codexAppServerProvider`; these attachments do not enable shell or file-tool grants.

## Integrated data path

1. The picker/drop/paste import is create-only. Server validation checks the image structure,
   supported format, size, dimensions, animation, and actual pixel decode. A private snapshot is
   staged before the visible Files copy is published using the mature coworker file admission
   and publication path.
2. The returned `DesktopImageSnapshot` names the content hash, visible name/path, media type,
   dimensions, and byte length. The private snapshot lives at
   `workspaces/1/engine/agents/<engineAgentId>/chat-images/<sha256>.<ext>`, outside Files.
3. Contracts export `DesktopAttachmentSelection = string | DesktopImageSnapshot`.
   `desktopAttachmentFieldsOf` retains `attachmentPath`/`attachmentPaths` and the exact old
   fingerprint for text-only input. Mixed input uses the ordered `attachmentItems` union:
   `{type:'text', path}` or `{type:'image', image}`. `desktopAttachmentSelectionsOf` reads both.
   The old `desktopAttachmentPathsOf` intentionally retains its legacy text-only behavior.
4. Drafts save `attachment_items` in a separate additive database column. Draft CAS, clear
   receipts, tab transfer during regeneration, and restart preserve the same ordered identities.
   Queued messages save the union in their existing JSON payload. Draft writes validate each
   selected snapshot against the owning coworker; queue sends validate it before execution.
5. The UI server resolves the private snapshots, verifying hashes and declared metadata. It
   sends ordered `desktopAttachments` to the engine: text entries carry `path` and `content`;
   image entries carry `image` and canonical `dataBase64`. The engine checks the bytes against
   the declared length and hash before admission. Legacy text requests keep their old shape.
6. The engine persists image bytes as AI SDK `file` parts, interleaved with text references in
   selection order. First-turn and queued-turn snapshots are committed atomically with their
   run and receipt. Context enrichment changes the same user row, without rereading Files.
   Codex receives real image parts through its existing app-server provider.
7. Exact retries reconcile the saved receipt. Queued replay needs only the immutable selected
   identities, not another snapshot read. Regeneration copies the original persisted user
   content byte-for-byte. History exposes image file parts as `data:` URLs, so saved chat
   previews and replay remain independent of the visible file and private snapshot lifetime.
8. Draft thumbnails use authenticated
   `/api/desktop/agents/<id>/images?snapshot=<encoded full JSON snapshot>` reads.

## Capability and limits

- Image turns require a ChatGPT / Codex provider. Another provider is refused before creating a
  run. This also covers a text follow-up or regeneration whose saved history includes images;
  the history check holds the session claim while deciding admission.
- A written message is still required. Image-only sends remain a later parity item.
- Per image: 8 MiB, 8192 pixels per edge, 16,777,216 pixels total. Per selection: four images,
  16 MiB combined, independently of ten text files and 128 KiB of combined text references.
- PNG/JPEG/WebP only; animated images and GIF are refused. The existing workspace file picker
  continues to list text references; local images enter through picker/drop/paste.
- The private store is bounded to 256 MiB / 512 entries per coworker. Automatic pruning is
  intentionally disabled; the compatibility prune function returns zero. A stale keep-set
  cannot delete images referenced by a newer draft, queue item, or pending send. Future pruning
  must derive all authoritative references under the same admission lock.

## Regression sources and validation boundary

Additional regression sources cover mixed first-turn and queue snapshots, ordered receipt
identity, database reopen, copied regeneration bytes, capability refusal before run creation,
corrupt-byte rejection, draft ownership/transfer/restart, and durable history image parts.

Implementation agents did not run tests, type checks, builds, model requests, or the Mac app.
Root owns all automated checks and Mac acceptance, including sending from the board and checking
saved chats after restart. This document describes source behavior, not a completed QA verdict.
