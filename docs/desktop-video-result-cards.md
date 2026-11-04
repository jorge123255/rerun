# Desktop MP4 result cards (source handoff)

This source extends the opt-in `card_file` tool so existing MP4 files in the same coworker's
persistent Files workspace can be shown as result-card tiles and played from the paged lightbox. It
keeps the original album and square-tile design. Tests, typecheck, lint, build, packaging,
installation, live-model requests and native Mac/restart QA remain with the integration owner; this
handoff makes no acceptance claim.

Branch `desktop/file-video-cards`, prepared base `f8375b73191ad55ce88bf0ada19b83dfc4fab2ee`.

## Original design reused

Reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/cards.ts` — `card_file` entries, order and all-or-nothing output.
- `packages/contracts/src/chat-card.ts` — file card shape, legacy single-file card and identity.
- `apps/ui/components/chat/FileCard.tsx` — images and videos read as one media album; any other
  file switches the card to the original square tile row.
- `apps/ui/components/chat/MediaAlbum.tsx` — single natural tile, two-column album, three-file wide
  first cell, four visible tiles and the `+N` overlay.
- `apps/ui/components/chat/ChatVideoTile.tsx` — first frame via `#t=0.1`, `preload="metadata"`,
  muted/inline preview, click to play in place, pause on second click, duration pill, progress line,
  `Maximize2Icon` full-screen action, one-playing-tile event, `FilmIcon` error state.
- `apps/ui/components/chat/AttachmentTile.tsx` — square video tile: first frame with the play disc.
- `apps/ui/components/chat/AttachmentLightbox.tsx` — title bar, `n / total`, previous/next.
- `apps/ui/components/files/FilePreview.tsx` — video frame and `<video controls>` presentation.

The Mac base also already contains `apps/ui/components/desktop/DesktopFileVideoPreview.tsx` for the
Files panel. Its authenticated fetch, `stopVideo` (pause, remove source, `load()`) and object-URL
lifecycle were used as the pattern; its `PanelEditorHeader` is deliberately not reused inside the
result-card lightbox, so the card keeps one title bar. The existing audio card path
(`DesktopFileAudioPreview`) supplied the same callback-ref cleanup pattern.

## Implemented

- **Contract:** `packages/contracts/src/chat-card.ts` adds `CARD_MAX_VIDEO_BYTES` (16 MiB) and
  describes the identity field as the image/audio/video endpoint identity. Text cards still carry no
  identity. `CARD_MAX_IMAGE_TOTAL_BYTES` (24 MiB) is now the combined image-and-video preview budget.
- **Card tool:** `apps/engine/src/desktop/card-file.ts` accepts visible `.mp4` files with a 16 MiB
  bound and an empty-file error, records `${dev}:${ino}` identity, and charges images and videos to
  the same 24 MiB combined budget. Audio stays outside that budget. All-or-nothing validation is
  unchanged: one bad file means nothing is shown. The model-facing description states MP4 support,
  the 16 MiB per-file and combined limits, first-frame previews, load-only-visible previews and
  play-only-after-user-action.
- **Parser:** `apps/ui/lib/desktop/file-card.ts` accepts MP4 entries with a positive size up to
  16 MiB and a valid endpoint identity; it exposes `isDesktopCardVideo` and
  `readDesktopCardVideo`. Other video formats, missing/malformed identity, absolute/hidden/traversal
  paths and mismatched names are rejected. Image and video sizes share the 24 MiB aggregate check.
- **Album tiles:** the new isolated `DesktopCardVideoTile` mirrors `ChatVideoTile`: first frame,
  click to play with sound, second click to pause, duration and progress, `Maximize2Icon` that pauses
  and opens the lightbox, and a `FilmIcon` error state. It never autoplays. It uses a callback ref
  plus unmount cleanup to pause, remove `src` and `load()` before the card releases the object URL.
- **Mixed tiles:** `DesktopCardVideoFrame` mirrors the original square `AttachmentTile` video branch
  (first frame plus play disc, opening the lightbox rather than playing inline), with the same stop
  and detach cleanup and a loading skeleton.
- **Card loading:** `DesktopFileCard` collects images and videos in file order. An all-image/video
  card uses the original album and fetches at most four visible previews; the hidden ones are
  fetched by the lightbox when opened. A mixed card keeps the original square row and loads every
  visible image and video. Audio and documents still use the lazy original `AttachmentTile`. The
  combined fetched-byte budget is enforced while loading, and every object URL is revoked on owner,
  card, key or unmount change.
- **Lightbox:** `DesktopFileLightbox` adds a video kind. It fetches only the selected file, through
  the authenticated `/files/video` route, with the trusted conversation owner and the card's inode
  identity, and renders `<video controls>` in the original frame. No autoplay and no `play()` call.
  Paging, closing, owner change, playback error and unmount abort the read, stop and detach the
  player, and revoke the object URL; a late response cannot replace the current page.
- **Wording:** `desktopCardsNote` and the `cardFile` catalog description now mention MP4 video,
  16 MiB per video, the 24 MiB combined image-and-video budget, first-frame previews, visible-only
  loading and play-only-on-user-action.

## Constraints

- Only existing `.mp4` files are supported. No shared files, other video formats, PDF, recording,
  uploads, publication, model video input, downloads in the lightbox or temporary Codex output.
- No new grant: video uses the existing `cardFile` permission.
- Limits preserved: 12 files per card, 32 KiB text, 8 MiB image, 16 MiB audio, 16 MiB video, and
  24 MiB combined images and videos per card. Audio is not part of the combined media budget.
- A card is a reference to the current persistent file. The video endpoint rechecks ownership,
  confinement, single-link inode identity, byte size and MP4 structure when opened; a
  renamed/replaced/deleted/corrupt/oversized video shows an explicit error.
- The installed authenticated video route, `readCoworkerVideo` and `video-bytes.ts` are unchanged.
  The Files-panel video preview, reader APIs, shell, dependencies, `DesktopApp` and chat state were
  not edited.
- Root owns the video-route comment update that names chat result cards as a consumer.

## Changed files

- `packages/contracts/src/chat-card.ts` — `CARD_MAX_VIDEO_BYTES`, combined media comment, identity
  wording.
- `packages/contracts/src/desktop-tool-grants.ts` — `cardFile` catalog description.
- `apps/engine/src/desktop/card-file.ts` — MP4 paths, empty/16 MiB checks, identity and combined
  media budget.
- `apps/engine/src/desktop/card-file.test.ts` — MP4 acceptance, mixed order, combined budget, path,
  link, folder, size and format cases.
- `apps/engine/src/agents/systemPrompt.ts` — `desktopCardsNote` MP4, limits and loading wording.
- `apps/ui/lib/desktop/file-card.ts` — MP4 parser, identity/size checks, combined budget and
  authenticated video fetch.
- `apps/ui/lib/desktop/file-card.test.ts` — MP4 parser, bounds, identity, budget and endpoint cases.
- `apps/ui/components/desktop/DesktopCardVideoTile.tsx` — isolated album and mixed video tiles with
  stop/detach cleanup.
- `apps/ui/components/desktop/DesktopFileCard.tsx` — images and videos in one media load/render
  path, visible-preview only loading and revocation.
- `apps/ui/components/desktop/DesktopFileLightbox.tsx` — paged video preview and lifecycle.
- `apps/ui/components/desktop/DesktopFileCard.video.test.tsx` — authored MP4 regression cases.
- `apps/ui/lib/chat/engine-history.test.ts` — saved MP4 identity across a reopened chat.
- `docs/desktop-video-result-cards.md` — this note.

`DesktopAssistantReply.tsx` already passes the conversation's trusted `agentId` to
`DesktopFileCard`; no assistant-rendering edit was needed.

## Root wiring and proposed verification

- Rebuild `@rerun/contracts` first so the video bound and parser consumers see the source change.
- No root-owned `DesktopApp`, `DesktopBoard`, `DesktopConversation`, Files panel, workspace icon,
  audio reader or video preview edit is required. Root retains chat state, drafts, queues and
  bootstrap integration.
- The installed `/api/desktop/agents/:agentId/files/video` route is reused unchanged. Root updates
  its consumer comment to name chat result cards; behaviour stays the same.
- Proposed verification: a real Codex `card_file` reply with one MP4, then an all-video album of more
  than four files, then a mixed text/image/audio/video card. Assert the first frame renders, only
  four album previews are requested before opening, video requests do not occur for hidden tiles or
  before the lightbox opens, playback starts only on user action, the full-screen action opens the
  paged lightbox, paging/closing/owner changes/unmount stop playback and revoke URLs, replaced,
  deleted or corrupt MP4 shows an explicit error, and the saved card still renders after restart.
  Re-run the existing text, image and audio card tests to confirm no regression, including the
  12-file, 32 KiB, 8 MiB image, 16 MiB audio and 24 MiB image budget rules.

## Verification status

Authored, not executed by this lane: engine card-tool tests, parser/bounds tests, video endpoint
fetch tests, saved-history projection and video tile/lightbox lifecycle tests. I did not run Vitest,
`tsc`, lint, a build, packaging, an install, live requests or Mac UI/restart QA. I did not touch real
workspace data, credentials, the installed app, the shared video reader, the Files-panel video
preview or another worktree.
