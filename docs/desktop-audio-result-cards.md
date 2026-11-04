# Desktop audio result cards

The installed opt-in `card_file` tool now also shows existing WAV and MP3 files from the same
coworker's persistent Files workspace. Audio keeps the original square waveform tile and opens in
the paged result-card lightbox with standard controls.

## Original design reused

Reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/cards.ts` — `card_file` entries and all-or-nothing card output.
- `packages/contracts/src/chat-card.ts` — file card shape and legacy single-file card.
- `apps/ui/components/chat/FileCard.tsx` — audio is a normal square-file tile, not part of the
  image/video media album.
- `apps/ui/components/chat/AttachmentTile.tsx` — original square tile and waveform glyph for audio.
- `apps/ui/components/chat/AttachmentLightbox.tsx` — title bar and paging.
- `apps/ui/components/files/FilePreview.tsx` — original audio control dimensions and placement.

The Mac base also already contains `apps/ui/components/desktop/DesktopFileAudioPreview.tsx` for the
Files panel. Its byte fetch, `stopAudio` (pause, remove source, load) and object-URL lifecycle were
used as the implementation pattern, but its `PanelEditorHeader` is deliberately not reused inside
the card lightbox. That avoids a duplicate Files header above the player.

## Implemented

- **Card contract:** `packages/contracts/src/chat-card.ts` adds `CARD_MAX_AUDIO_BYTES` (16 MiB) and
  documents `identity` as the image/audio endpoint identity. Text cards still carry no identity.
- **Card tool:** `apps/engine/src/desktop/card-file.ts` accepts visible `.wav`/`.mp3` files, keeps the
  existing 12-file limit, uses a 16 MiB per-audio bound, stores `${dev}:${ino}` identity, and only
  applies the 24 MiB aggregate budget to images. Audio does not count against that image-thumbnail
  budget. The all-or-nothing rule is unchanged: one bad file means nothing is shown.
- **Parser:** `apps/ui/lib/desktop/file-card.ts` accepts WAV/MP3 entries with a positive size up to
  16 MiB and a valid endpoint identity. Other audio formats (`ogg`, `m4a`, `flac`, …), missing or
  malformed identity, absolute/hidden/traversal paths and mismatched names are rejected. Old text
  cards still parse.
- **Audio tile:** `DesktopFileCard` keeps the original non-image `AttachmentTile` path: the tile is
  a square waveform glyph with the file name. It performs no audio request. Audio works in static
  image albums, text cards and mixed cards without disturbing order or the existing single-image and
  multi-image album layouts.
- **Lightbox:** `DesktopFileLightbox` fetches the selected audio only when the lightbox is open,
  through the authenticated audio route, with the trusted conversation owner and the card's inode
  identity. It creates one object URL for the `<audio controls>` element. It never autoplays and
  never calls `play()`; playback starts only from the user pressing the browser control.
- **Stop and release:** paging, closing, owner change and unmount abort the current fetch, pause the
  player, remove its source, call `load()` where available, and revoke the object URL. A late or
  aborted response cannot replace the current page. A playback error removes the player and releases
  its URL.
- **Wording:** the `cardFile` catalog description and `desktopCardsNote` now mention WAV/MP3 audio,
  the 16 MiB limit, audio fetched only on open and play-only-on-user-action. The card tool description
  also states the same limits and that other audio formats are unavailable.

## Constraints

- Audio is limited to existing WAV and MP3 files. Uploads, recording, transcription, model audio
  input, generation, publication, shared files, multiple input attachments and other audio formats
  remain unavailable.
- Audio does not add a new grant. It uses the existing `cardFile` permission.
- 12 files per card, 32 KiB per text file, 8 MiB per image, 24 MiB of images per card, 16 MiB per
  audio file. Audio is not part of the image-thumbnail budget.
- A card is a reference to the current persistent file, not a frozen attachment. The audio endpoint
  checks inode identity, ownership, links, path confinement, bytes and WAV/MP3 structure when the
  player opens. A renamed/replaced/deleted/corrupt/oversized audio file shows an explicit unavailable
  state.
- The installed audio reader (`coworker-files.ts`, `audio-bytes.ts` and the `/files/audio` route) is
  unchanged. A owns the separate video Files preview.
- No download, image/PDF preview, transcription, audio generation or Files-panel header is added to
  the card lightbox.

## Changed files

- `packages/contracts/src/chat-card.ts` — `CARD_MAX_AUDIO_BYTES` and identity wording.
- `apps/engine/src/desktop/card-file.ts` — audio paths, 16 MiB bound and identity.
- `apps/engine/src/desktop/card-file.test.ts` — audio, mixed, path, size and budget cases.
- `apps/ui/lib/desktop/file-card.ts` — audio parser, authenticated audio fetch and error type.
- `apps/ui/lib/desktop/file-card.test.ts` — audio parser, bounds, identity and endpoint cases.
- `apps/ui/components/desktop/DesktopFileCard.tsx` — documents the original audio tile and keeps it
  on the no-eager-fetch path.
- `apps/ui/components/desktop/DesktopFileLightbox.tsx` — paged audio preview and lifecycle.
- `apps/ui/components/desktop/DesktopFileCard.audio.test.tsx` — audio-only regression cases.
- `apps/ui/lib/chat/engine-history.test.ts` — saved audio identity.
- `apps/engine/src/agents/systemPrompt.ts` and `packages/contracts/src/desktop-tool-grants.ts` —
  desktop card wording.

`DesktopAssistantReply.tsx` already passes the conversation's trusted `agentId` into
`DesktopFileCard`; no further assistant-rendering edit was needed.

## Root wiring and proposed verification

- Rebuild `@rerun/contracts` first so the audio bound and identity/parser consumers see the source
  change.
- No root-owned `DesktopApp`, `DesktopBoard`, `DesktopConversation`, Files panel, workspace icon or
  audio-reader edit is required. Root keeps the conversation/draft/queue/bootstrap wiring.
- The installed `/api/desktop/agents/:agentId/files/audio` route is reused unchanged even though its
  comment says chat cards do not use it yet. Root may update that comment in a later edit.
- Proposed verification: a real Codex `card_file` reply with one WAV or MP3, then a mixed
  text/image/audio card; assert the tile is a waveform glyph, no audio request happens before the
  tile opens, the lightbox has one title bar and standard controls, playback starts only on user
  action, paging/closing/owner changes stop playback and revoke URLs, replaced/deleted/invalid audio
  shows an explicit error, and the saved card still renders after restart. Check that image album
  and mixed-file order are unchanged and that the 12/32 KiB/8 MiB/24 MiB limits still hold.

## Verification status

Authored, not executed by this lane: engine card tool tests, parser/bounds tests, audio endpoint
fetch tests, saved-history projection tests and audio lightbox lifecycle tests. I did not run Vitest,
`tsc`, lint, a build, packaging, an install, live requests or Mac UI QA, and I did not touch real
workspace data, credentials, the installed app, the shared audio reader, the video preview or another
worktree.
