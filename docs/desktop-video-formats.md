# Desktop video formats — WebM, MOV, M4V (lane handoff)

Branch `desktop/round28-video-formats`, base `15dce4a9dcefeb95b0042d01d8b2afc9bbe5c3f6`. Source
only. Root runs tests, typecheck, lint, build, packaging, install and native Mac QA; this lane
did not run them and does not claim acceptance.

## Upstream

`origin/main` is the pinned original `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. There is no
`FileVideoPreview.tsx` upstream: the hosted video surface is the `<video controls>` branch of
`apps/ui/components/files/FilePreview.tsx` inside `FileDetail`'s `PanelEditorHeader`, and
`apps/ui/lib/files/preview.ts` lists `VIDEO_EXTS = mp4, webm, mov, m4v`. The desktop adapter
`DesktopFileVideoPreview.tsx` already ports that layout (header + sibling controls + the same
player frame and skeleton), so this lane only widened its gates; layout, controls and sibling
navigation are unchanged. Playback stays user-started (`controls`, no `autoPlay`), the blob URL
lifecycle, abort and `stopVideo` cleanup are untouched, and a stream Electron cannot decode still
lands on `This video can’t be played.` — container recognition never claims codec support.

## Changed files

- `apps/ui/lib/desktop/server/video-bytes.ts` — `DesktopVideoKind`/`DesktopVideoContentType`
  widened to `mp4 | mov | m4v | webm`; `desktopVideoKind` maps the four extensions; BMFF brands
  are per-kind (`mov` adds `qt  `); new bounded EBML inspector for WebM.
- `apps/ui/lib/desktop/server/video-bytes.test.ts` — authored, not run.
- `apps/ui/components/desktop/DesktopFileVideoPreview.tsx` — `VIDEO_NAME` and `VIDEO_TYPES`
  accept the three new extensions/content types. `isDesktopVideoName` feeds the existing
  `DesktopCoworkerFiles` dispatch unchanged.
- `apps/ui/components/desktop/DesktopFileVideoPreview.test.tsx` — authored, not run.
- `apps/ui/app/api/desktop/agents/[agentId]/files/video/route.test.ts` — real per-format
  fixtures and assertions; authored, not run.
- `docs/desktop-video-formats.md` — this note.

`route.ts` needed no change: it already returns whatever `readCoworkerVideo` inspects.

## Structural rules added

- MOV/M4V share the ISO BMFF box walk (ftyp + moov + mdat + `vide` handler, same 4096-box /
  depth-16 bounds). MOV accepts the MP4 brand set plus `qt  `; M4V accepts the MP4 brand set
  (`M4V ` was already in it). Content types: `video/quicktime`, `video/x-m4v`.
- WebM requires the EBML magic, an EBML header whose DocType is exactly `webm` (Matroska is
  refused as unsupported), a Segment, a TrackEntry with TrackType 1 (video; audio-only is
  unsupported), and at least one Cluster (the mdat analogue; missing means corrupt). The walker
  is bounded at 32768 elements, never descends into media payloads, and treats unknown-size
  elements as extending to their parent.
- Every refusal maps to the existing route errors: wrong container 415 `This file is not a
  supported video file.`, unrecognized brand/DocType/track 415 `This video format can’t be
  previewed.`, damaged structure 415 `This video is damaged and can’t be previewed.`

## Root integration fragment

`apps/ui/lib/desktop/server/coworker-files.ts`, in `readVideo`, the unsupported-extension
message still says MP4 only:

```ts
if (!kind) throw new DesktopHttpError(415, 'Only MP4 files can be previewed.')
```

Change to:

```ts
if (!kind) throw new DesktopHttpError(415, 'Only MP4, WebM, MOV and M4V files can be previewed.')
```

(The route test asserts that exact string.) Optionally update the `readCoworkerVideo` doc
comment from "one existing MP4" to "one existing video". `CoworkerVideoPreview.contentType`
follows the widened union with no other edit. `DesktopCoworkerFiles.tsx` needs nothing:
`isDesktopVideoName` now covers the new names and the same `srcUrl` shape is reused.

## Known limits

- Chat result cards (`file-card.ts`, `DesktopCardVideoTile`) still recognize `.mp4` only —
  chat-card contracts were left unchanged per the lane scope. A WebM/MOV/M4V produced inside a
  card falls back to the plain file entry.
- `video/x-m4v` and `video/quicktime` are the served types; Electron/Chromium sniffs the
  container for playback, and undecodable codecs surface the existing error state.
- No codec downloads, conversion, recording, or model video input.
- Tests, lint, typecheck, build and Mac playback acceptance were not run in this lane.
