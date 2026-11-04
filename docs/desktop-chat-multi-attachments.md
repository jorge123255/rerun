# Desktop chat: multiple existing text attachments (source handoff)

This source extends the Mac chat composer from one existing `.txt`/`.md` file to an ordered set of
1–10 files from the same coworker's Files workspace, with 32 KiB per file and 128 KiB combined.
The set travels through the picker, the per-tab draft, the queue, the send/retry path, the bridge
payload and saved history. Integration checks and native acceptance remain with root; this note
does not claim them.

Branch `desktop/chat-multi-attachments`, prepared base `927c5e17da6b6db84657261695a98e0533b264de`.
Original Rerun reference `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Original design reused

- `apps/ui/components/chat/ChatComposer.tsx` — `maxFiles=10`, the attachment row order, the
  paperclip and the rule that a refused send keeps the composer and its files.
- `apps/ui/components/chat/ChatAttachments.tsx` — ordered chips rendered as one header row.
- `apps/ui/components/chat/ChatAttachmentChip.tsx` — bordered chip, file glyph, truncated name,
  per-file remove button.
- `apps/ui/components/chat/AttachmentTile.tsx` / `AttachmentLightbox.tsx` — the saved message
  shows the attached files as compact tiles/chips; this slice keeps the existing desktop chip.
- `apps/ui/hooks/useComposerDraft.ts` and the original queue/composer draft code — draft identity
  per tab, a queued message that keeps the exact text and files, and a retry that reuses the same
  request identity.

The Mac boundary differs only where the original uploads bytes: attachments here are existing
workspace paths, read and snapshotted by the authenticated bridge at send time. The picker is a
folder browser (no drag/drop, clipboard media or new formats), and its dialog stages a selection
so Cancel cannot change the composer.

## Implemented

### Contract and payload

- `packages/contracts/src/desktop-attachment.ts` adds `DESKTOP_ATTACHMENT_MAX_FILES` (10) and
  `DESKTOP_ATTACHMENT_TOTAL_MAX_BYTES` (128 KiB), a paths-only schema (ordered, unique, valid
  `.txt`/`.md`), and an ordered snapshot schema enforcing per-file and combined byte limits.
- Helpers `desktopAttachmentPathsOf`, `desktopAttachmentFieldsOf` and
  `desktopAttachmentFingerprintOf` encode one compatibility rule: **one file keeps the original
  `attachmentPath`/`workspaceAttachment` shape, two or more use the ordered
  `attachmentPaths`/`workspaceAttachments` array**. Old single-file rows, queues, receipts and
  tab-start hashes therefore keep working without migration.
- `workspaceAttachmentPaths(content)` returns every attachment part in order;
  `workspaceAttachmentPath` stays as the first-path compatibility helper.

### Send path

- `apps/ui/app/api/desktop/chat/route.ts` accepts either `attachmentPath` or
  `attachmentPaths` (never both), validates order/uniqueness/count and passes them to the bridge.
- `apps/ui/lib/desktop/server/engine.ts` reads and validates every file for a new send, fails the
  whole request on the first missing/replaced/oversized/non-UTF-8 file, enforces the 128 KiB
  combined total from the actual bytes, and then sends either one `workspaceAttachment` or the
  ordered `workspaceAttachments` snapshot. Nothing is sent partially and no file is dropped.
- Tab starts (`tab-starts.ts`) hash the ordered path set; one path hashes exactly like the old
  single-attachment hash. A retry of an accepted first turn recovers the session before reading
  any file again.
- Queued turns carry the ordered set; the bridge probes the engine receipt (fingerprint = ordered
  paths) **before** reading files, so an accepted request keeps its accepted bytes even if the
  files changed. A new attempt re-reads and revalidates.
- `apps/ui/lib/engine/client.ts` gains the narrow `workspaceAttachments`/`attachmentPaths` body
  fields; this is the only shared serialization type touched.

### Composer and picker

- `DesktopAttachmentPicker` now browses, toggles files in click order, shows
  `n of 10 selected`, disables unsupported/oversized/over-count/over-total rows, and applies the
  staged order on Done. Cancel discards the staged edits.
- `AttachmentChips` renders the ordered row with one remove button per file. A path that is part of
  the in-flight submitted set is locked; adding or removing other files cannot change that sent
  request. `DesktopConversation` keeps the array through `ComposerDraft` (`attachments`, with the
  legacy `attachment` field still accepted for existing callers/tests).
- Failure keeps the text and every selected chip. Success clears only the draft version that was
  actually accepted (and only the exact attachment set still in the composer).

### Drafts, queue and history

- Draft schema/API keep `attachmentPath` and add `attachmentPaths`; the server stores the first
  path in the legacy `attachment_path` column and the ordered JSON in `attachment_paths`.
  `draftOf` prefers the JSON array and falls back to the old column, so every existing row still
  restores.
- Draft write fingerprints use the same one-or-array rule, keeping old receipts valid. File bytes
  are revalidated only when the path set changes, and the combined total is enforced then.
- Queue items keep one `attachmentPath` or an ordered `attachmentPaths`; previews list every file,
  and send-now/reconcile replay the same fields.
- `transformEngineMessages` emits `metadata.attachmentPath` for one file and
  `metadata.attachmentPaths` for several, in the persisted part order. The Mac transcript renders
  every path as a chip and never exposes the stored content.

## Shared-file integration (root)

The central database file is root-owned. Apply this additive migration in
`apps/ui/lib/desktop/server/database.ts` after the `desktop_composer_drafts` table is created
(the draft module also applies it defensively at first use, so an un-migrated development DB keeps
working):

```sql
ALTER TABLE desktop_composer_drafts ADD COLUMN attachment_paths TEXT;
```

Or, matching the file's existing guarded style:

```ts
const draftColumns = await client.execute('PRAGMA table_info(desktop_composer_drafts)')
if (!draftColumns.rows.some(row => String(row.name) === 'attachment_paths'))
    await client.execute('ALTER TABLE desktop_composer_drafts ADD COLUMN attachment_paths TEXT')
```

Other root wiring:

- Rebuild `@rerun/contracts` before the UI/engine packages.
- `apps/ui/lib/engine/client.ts` was edited only to widen the chat body type; root may keep that
  change or move it to its preferred serialization type.
- No `DesktopApp`, `DesktopBoard`, `DesktopControlCenter`, bootstrap, route-policy, tool
  registry/catalog/grant or startup/shutdown edit is required.
- Deploy the engine and UI together: the engine accepts both the legacy single field and the new
  ordered array, so a mixed-version rollout keeps old clients working.

## Changed files

- `packages/contracts/src/desktop-attachment.ts`
- `apps/ui/app/api/desktop/chat/route.ts`
- `apps/ui/lib/engine/client.ts`
- `apps/ui/lib/desktop/server/engine.ts`
- `apps/ui/lib/desktop/server/tab-starts.ts`
- `apps/ui/lib/desktop/server/composer-draft.ts`
- `apps/ui/lib/desktop/composer-draft.ts`
- `apps/ui/lib/desktop/draft-writes.ts`
- `apps/ui/lib/desktop/use-composer-draft.ts`
- `apps/ui/lib/desktop/queued-message.ts`
- `apps/ui/lib/desktop/use-queued-message.ts`
- `apps/ui/lib/chat/engine-history.ts`
- `apps/ui/components/desktop/DesktopAttachmentPicker.tsx`
- `apps/ui/components/desktop/DesktopConversation.tsx`
- `apps/engine/src/http/routes/chat.ts`
- `apps/engine/src/runtime/context.ts`
- `apps/engine/src/runtime/loop.ts`
- `apps/engine/src/db/repos/desktop-queued-turns.ts`
- Tests/fixtures: `apps/ui/components/desktop/DesktopConversation.attachment.test.tsx`,
  `DesktopConversation.queue.test.tsx`, `DesktopConversation.drafts.test.tsx`,
  `DesktopConversation.regenerate.test.tsx`, `apps/ui/components/desktop/DesktopChatTabs.test.tsx`,
  `apps/ui/lib/desktop/use-composer-draft.test.tsx`,
  `apps/ui/lib/desktop/draft-writes.test.ts`,
  `apps/ui/app/api/desktop/agents/[agentId]/draft/route.test.ts`,
  `apps/ui/app/api/desktop/routes.test.ts`,
  `apps/ui/lib/chat/engine-history.test.ts`,
  `apps/ui/test/desktop-draft-fixture.ts`,
  `apps/engine/src/http/routes/chat.test.ts`.
- `docs/desktop-chat-multi-attachments.md` — this note.

## Constraints and known limits

- Existing coworker-owned `.txt`/`.md` files only. No drag/drop, clipboard media, uploads, new
  formats, image/audio/PDF model input, shared files or multiple input messages. Those remaining
  C3 capabilities stay out of this slice.
- 10 files per message, 32 KiB per file, 128 KiB combined; the bridge rechecks the real bytes and
  refuses the whole message on any failure. Attachment order is click order.
- A message is a snapshot: later Files edits do not alter an accepted turn or a queued retry that
  the engine already accepted. A brand-new send reads the current bytes.
- The Mac lightbox still shows the existing text preview; this slice does not add an attachment
  gallery, download or upload.
- No push/merge; no tests, typecheck, lint, build, packaging, install, live model request or native
  Mac/restart check was run by this lane. The regression tests above are authored only.
- `DesktopCoworkerFiles` and the PDF preview files were not edited. Other worktrees were not
  touched.

## Root integration corrections

Root integrated `c7db894fee5ae05553dde98006ec13e969bb9e57` and added the central draft migration. Regenerate/fork draft transfer now moves and clears both legacy and ordered attachment columns and compares the full ordered set for collisions. Picker reopening resolves metadata for selected files across folders before accepting the total, and allows removal of unavailable selections.

Draft validation returns a typed rejection only after reconciling accepted receipts and revision ownership. The client can then correct the rejected selection while retaining text. Unknown failures retain the request identity; a concurrent accepted write cannot be misreported as rejected or cleared by a late validation error. Focused root regressions cover those cases. Packaging and native/restart acceptance are tracked separately from this source handoff.
