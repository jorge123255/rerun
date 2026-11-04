# Desktop image result cards

The installed opt-in `card_file` tool now also shows existing static PNG, JPEG, WebP and
single-frame GIF files from the same coworker's persistent Files workspace. Text, image and mixed
cards keep Rerun's original tile, album and paged-lightbox presentation.

## Original design reused

Reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/cards.ts` — `card_file` entries and all-or-nothing card output.
- `packages/contracts/src/chat-card.ts` — file card shape, bounds and legacy single-file card.
- `apps/ui/components/chat/FileCard.tsx` — all-image album versus mixed square-tile row.
- `apps/ui/components/chat/MediaAlbum.tsx` — single natural image, two-column album, captions and
  the `+N` cover.
- `apps/ui/components/chat/AttachmentTile.tsx` — square tile frame, image cover and glyph/text tile.
- `apps/ui/components/chat/AttachmentLightbox.tsx` — title bar, paging and preview dialog.

The Mac `DesktopFileCard` keeps the original layouts. `DesktopMediaAlbum` in that file mirrors
`MediaAlbum` exactly for the ready state and adds loading/error placeholders; mixed cards keep the
original flex row of square tiles. `DesktopFileLightbox` keeps the original title bar and paging but
has no raw URL or Download, because the Mac reads authenticated bytes rather than a public URL.

## Implemented

- **Card tool:** `apps/engine/src/desktop/card-file.ts` accepts visible `.txt`/`.md` documents and
  static `.png`/`.jpg`/`.jpeg`/`.webp`/`.gif` images in this coworker's persistent workspace. It
  keeps the current per-coworker `cardFile` grant and re-checks it before every call. The existing
  12-file limit, 32 KiB text limit, 8 MiB per-image limit and a new 24 MiB aggregate image budget
  apply. The tool stores the image endpoint's `${dev}:${ino}` identity. It does not read, import,
  publish, freeze or create files, and it never uses the native Codex temporary folder.
- **Validation:** an absolute path is accepted only when it resolves inside this coworker's
  workspace and is stored relative. Shared scope, foreign paths, traversal, hidden names, backslash
  or control characters, symlinks, hard links, directories, unsupported formats, empty images and
  oversized files are refused. One bad file means the whole card shows nothing.
- **Parser:** `apps/ui/lib/desktop/file-card.ts` validates live and saved output. Text keeps the
  32 KiB bound and needs no identity. Images require a supported extension, a positive size up to
  8 MiB, a valid endpoint identity, and the aggregate image budget. Old text cards without an
  identity still parse. A malformed, replaced or unsupported entry returns `undefined`, so the
  assistant keeps the honest tool-result step.
- **Album/tiles:** `DesktopFileCard` fetches each image through the authenticated image endpoint,
  sequentially, with an actual aggregate check. It produces released object URLs, shows a loading
  placeholder per tile, and exposes errors for replaced, deleted, animated, damaged or over-budget
  images. All-image cards use the original album layout, captions and `+N` cover; mixed cards keep
  the original square-tile row; text keeps the original tile and text lightbox.
- **Lightbox:** `DesktopFileLightbox` pages through the card's files, fetches the selected current
  file, aborts the previous request on paging or owner changes, ignores stale completions, revokes
  its object URL on replacement, unmount and image error, and shows the image endpoint's explicit
  unavailable message. It has no download control.
- **Saved history:** the existing `publicDesktopHistory` projection keeps the normalized card
  output (including an image identity), so the card remains on its assistant message after restart.
  Old text cards remain unchanged.

## Owner and replacement rules

The UI never reads an owner or raw URL from the card. `agentId` comes from the actual conversation
through `DesktopAssistantReply`, as before. The image URL is constructed locally from that id, the
validated relative path and the stored identity; the image endpoint remains authoritative for
containment, inode ownership, symlinks, bytes, dimensions and animation.

A card is a reference to the current persistent file, not a frozen attachment. If the path still
names the same inode, opening reads its current bytes. A renamed/deleted path returns 404 and a
replaced inode returns 409; both render an explicit unavailable state. Text cards have no identity,
so they continue to open the current text file at their path.

## Limits

- Only static PNG/JPEG/WebP/single-frame GIF images, `.txt` and `.md` documents. SVG, PDF, video,
  audio, AVIF/BMP, animated GIF/APNG/WebP, shared files, imported/generated files and the native
  Codex temporary folder are not supported.
- 12 files per card, 32 KiB per text file, 8 MiB per image, 24 MiB of images per card. The image
  endpoint rechecks actual bytes and decoded dimensions on open; a structurally valid card may
  therefore show its explicit unavailable state for an animated, corrupt or dimension-heavy image.
- No image inputs, vision, new grants, publication, downloads or image/PDF previews were added.
  `isDesktopAttachmentPath`, `coworker-files.ts` and `image-bytes.ts` are unchanged.
- Object URLs cover thumbnails and the lightbox separately. Both are revoked on replacement,
  paging, owner change and unmount; an image decode failure also revokes and clears its URL.

## Changed files

- `packages/contracts/src/chat-card.ts` — optional image `identity`, image byte bounds.
- `apps/engine/src/desktop/card-file.ts` — image paths, per-image/aggregate limits and identity.
- `apps/engine/src/desktop/card-file.test.ts` — text/image/mixed, owner, path, size and budget cases.
- `apps/ui/lib/desktop/file-card.ts` — image parser, endpoint fetch and error type.
- `apps/ui/lib/desktop/file-card.test.ts` — parser, bounds, identity and endpoint cases.
- `apps/ui/components/desktop/DesktopFileCard.tsx` — album/tile rendering and image lifecycle.
- `apps/ui/components/desktop/DesktopFileLightbox.tsx` — paged text/image preview.
- `apps/ui/lib/chat/engine-history.test.ts` — saved image card identity.

`apps/ui/components/desktop/DesktopAssistantReply.tsx` already passed the conversation's trusted
`agentId` into `DesktopFileCard`; no further assistant-rendering edit was needed.

## Root integration notes

- Rebuild `@rerun/contracts` first; the new image bounds and optional `identity` live there.
- No root-owned `DesktopApp`, `DesktopBoard`, `DesktopConversation`, workspace icon or engine
  registry edit is required.
- The already-installed authenticated `GET /api/desktop/agents/:agentId/files/image` route is reused
  unchanged even though its comment says chat cards do not use it yet. Root may update that comment
  in a later edit; this lane did not touch the route.

## Verification status

Authored, not executed by this lane: engine card tool tests, parser/bounds tests, image fetch tests
and saved-history projection tests. I did not run Vitest, `tsc`, lint, a build, packaging, an install,
live requests or Mac UI QA, and I did not touch real workspace data, credentials, the installed app
or another worktree.
