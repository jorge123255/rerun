# Desktop PDF result cards (source handoff)

Branch `desktop/chat-pdf-cards`. Prepared base `bb45f3a99e2ae2fe2de8e944a9eb4ab329ef0055`. Source only. Tests, typecheck, lint, build, packaging, installation, live model requests, and native Mac/restart checks were not run. This handoff does not claim acceptance.

Existing coworker PDFs can be shown with `card_file` as document tiles. Opening one renders authenticated PNG pages from the installed Files PDF route. The browser does not receive an iframe, embed, or raw PDF.

## Original design

Reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/engine/src/tools/builtin/cards.ts` — `card_file` order and all-or-nothing output. A Mac card still refuses shared scope.
- `apps/ui/components/chat/FileCard.tsx` — an image/video set is an album. Any other file, including a PDF, uses the square tile row.
- `apps/ui/components/chat/AttachmentTile.tsx` — a PDF has no thumbnail. `fileTypeIcon` returns null for `pdf`, so the tile is the default document glyph (`FileIcon`) plus the file name.
- `apps/ui/components/chat/AttachmentLightbox.tsx` — title, `n / total`, Previous attachment, Next attachment.
- `apps/ui/components/files/FilePreview.tsx` — the original PDF branch is an unsandboxed iframe of `rawUrl`. This lane does not reuse that branch.

The installed Mac difference is `DesktopFilePdfPreview`: it fetches `GET /api/desktop/agents/:agentId/files/pdf?path=&identity=&page=&scale=` and shows a PNG. Page arrows, zoom, Fit width, and Retry stay on that component. `chrome="body"` omits the Files header and sibling-file arrows so the lightbox keeps one title bar. The Files viewer still uses the default `chrome="files"`.

## Implemented here

- `card-file.ts` admits a visible `.pdf` in this coworker’s persistent workspace, up to `DESKTOP_CARD_PDF_MAX_BYTES` (16 MiB), records `dev:ino`, and refuses an empty file, a link, a folder, a shared scope, a hidden or temporary path, and a missing grant through the existing `cardFile` checks. One failure still shows nothing. PDF bytes are not added to the 24 MiB image/video budget and are not returned to the model.
- `file-card.ts` accepts the same shape. A PDF without a matching identity, or over 16 MiB, is dropped instead of drawing a partial card. `desktopCardPdfSrc` builds the page route and does not fetch.
- `DesktopFileCard` leaves PDFs on the document-glyph row. It does not prefetch them and does not put them in an album.
- `DesktopFileLightbox` mounts `DesktopFilePdfPreview` with `chrome="body"` for the opened PDF only. Attachment arrows stay Previous/Next attachment. Page arrows stay Previous/Next page. Close, attachment change, and owner change unmount the preview, which aborts its request and revokes its blob. A missing identity shows “Send this PDF to preview again.” and does not fetch. The page route’s replaced-file error is shown as returned.

The PDF reader, route, native helper, and import backend were not edited. `coworker-files.ts` was not edited.

## Root wiring

No edit to `DesktopAssistantReply.tsx` or `publicDesktopHistory`. Both already call `desktopFileCardOf` and, for the reply, `DesktopFileCard`. A saved PDF card is kept on reopen because the parser now accepts it. A PDF entry without identity still does not become a preview card.

`apps/engine/src/agents/systemPrompt.ts` is unchanged. Replace `desktopCardsNote` with:

```ts
const desktopCardsNote =
    'Use card_file for existing .txt/.md documents, PDF files, static PNG, JPEG, WebP or single-frame GIF images, WAV or MP3 audio, and MP4 video already saved in this coworker’s persistent Files workspace: visible relative paths, up to 12 files, 32 KiB per document, 16 MiB per PDF, 8 MiB per image, 16 MiB per audio file, 16 MiB per video and 24 MiB of images and videos combined per card. PDFs are document tiles, not album entries, and a PDF page is fetched only when that PDF is opened. Group image and video choices in one album; mixed document/PDF/image/audio/video cards are supported. Animated images, SVG, other audio formats, other video formats and shared files are unavailable. Include those cards in the turn where you ask the user to review or choose among existing Files documents, PDFs, images, audio or video. Audio is fetched only when the file is opened and plays only after the user presses play. MP4 previews show the first frame and play only after the user acts; only the visible album previews are loaded, and the rest are fetched when opened. Native Codex commands and edits run in a separate temporary folder; their changes are discarded and card_file cannot save, import, publish or search them. A relative path shared by a temporary copy and a Files document displays the persistent original, not your temporary edits. Do not present it as a newly produced or updated deliverable; put temporary text results directly in your reply instead. A card reads no content back to you, including no PDF content, and opening it shows the file’s current contents, not a frozen snapshot. A moved or deleted file, or a replaced image, audio, video or PDF file, cannot be shown. Table cards are unavailable on this Mac.'
```

In `apps/engine/src/agents/systemPrompt.test.ts`, replace the assertion that PDF is unavailable:

```ts
expect(cards).toContain('16 MiB per PDF')
expect(cards).toContain('PDFs are document tiles, not album entries')
expect(cards).toContain('a PDF page is fetched only when that PDF is opened')
expect(cards).toContain('Animated images, SVG, other audio formats, other video formats and shared files are unavailable')
expect(cards).not.toContain('Animated images, SVG, PDF, other audio formats')
```

In `packages/contracts/src/desktop-tool-grants.ts`, replace the `cardFile` catalog sentence with:

```ts
supported('cardFile', 'Show result files', 'Show this coworker’s existing text, Markdown, PDF, static images, WAV/MP3 audio or MP4 video as preview tiles in chat.', 'card_file'),
```

No shared `FileCardEntry` change. The local caps are `DESKTOP_CARD_PDF_MAX_BYTES` in `card-file.ts` and `file-card.ts`. They match `DESKTOP_PDF_MAX_BYTES`.

## Limits

- Admission checks the name, size, single link, owner workspace, and grant. It does not parse PDF bytes. The page route rejects a bad, replaced, or oversized file when a page is opened, and the lightbox shows that error.
- The card does not import a PDF, publish one, search its text, or send its bytes to the model.
- A fetched PNG and an image `load` event are not proof the page is the document the user expects. Root’s native check is a real PDF with two pages, a mixed card, attachment switching, a replaced identity, return to the same chat, and a restart.
- Until the prompt and catalog lines above are applied, the model-facing system prompt and the Tools label still say PDF result cards are unavailable. The tool description in `card-file.ts` already admits them when the `cardFile` grant is on.

## Checks

Tests, lint, typecheck, build, packaging, and Mac acceptance were not run in this lane.
