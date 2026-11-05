# Desktop animated GIF and WebP previews (lane handoff)

Branch `desktop/round28-animated-images`. Base `15dce4a9dcefeb95b0042d01d8b2afc9bbe5c3f6`. Source only. The integration owner runs tests, typecheck, lint, build, packaging, install, and Mac QA, including a real animated GIF and animated WebP from Files and after restart. This handoff does not claim those results. The capability is not accepted.

No new dependency, native helper, manifest field, or packaging step. The bundled Next docs directory was not present, so the route keeps the existing image route: `dynamic = 'force-dynamic'` and `params` as a Promise.

## Upstream

Reused from `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, without hosted file URLs or Supabase:

- `apps/ui/components/files/FilePreview.tsx`: the image branch is `<img src={rawUrl} alt={fileName} className="max-h-full max-w-full object-contain" />` inside `flex h-full items-center justify-center overflow-auto bg-muted p-3`. The browser animates a GIF or animated WebP from those bytes. This slice does not draw frame 0 to a canvas, recode to PNG or JPEG, or use `<video>` or `<audio>`.
- `apps/ui/components/files/FileDetail.tsx`: `PanelEditorHeader` with the file name, sibling Previous/Next, and the error line `p-3 text-xs text-destructive`.
- `apps/ui/lib/files/preview.ts`: its image set also includes SVG, AVIF, ICO, and BMP. The Mac route still allows only PNG, JPEG, GIF, and WebP.

Mac adaptation: there is no hosted `rawUrl`. `DesktopFileImagePreview` already fetches the authenticated route and gives the response bytes to `<img>` as a blob. Files now asks for `animation=1`, and that response is the original file, including every frame. The header, frame, and Previous/Next controls are unchanged.

## Changed files

- `apps/ui/lib/desktop/server/animated-image.ts` — preview-only GIF and WebP inspection. It does not return replacement bytes.
- `apps/ui/lib/desktop/server/animated-image.test.ts` — authored, not run.
- `apps/ui/lib/desktop/server/preview-image.ts` — `readCoworkerPreviewImage`, with the same confinement as `readCoworkerImage`.
- `apps/ui/app/api/desktop/agents/[agentId]/files/image/route.ts` — `animation=1` uses the preview reader. Any other caller keeps `readCoworkerImage`.
- `apps/ui/app/api/desktop/agents/[agentId]/files/image/route.test.ts` — authored, not run. Existing animated-GIF and animated-WebP cases still omit `animation` and still expect 415.
- `apps/ui/components/desktop/DesktopFileImagePreview.tsx` — appends `animation=1` to the image route. Props are unchanged.
- `apps/ui/components/desktop/DesktopFileImagePreview.animation.test.tsx` — authored, not run.
- `docs/desktop-animated-image-previews.md` — this note.

Not changed: `image-bytes.ts`, `coworker-files.ts`, `DesktopCoworkerFiles.tsx`, `DesktopApp.tsx`, `DesktopBoard.tsx`, `DesktopConversation.tsx`, `file-card.ts`, `systemPrompt.ts`, composer and logo readers, workspace icons, result-card contracts, `docs/desktop-file-image-previews.md`, `docs/desktop-runtime-contract.md`, the parity checklist, packaging, and other lanes.

`image-bytes.ts` still refuses APNG, a second GIF frame, WebP `ANIM`/`ANMF`, and the VP8X animation bit. Composer snapshots, attachment, logos, and workspace icons keep that refusal.

## Integration

Root pastes this next to `bindCoworkerPdfFolder` in `apps/ui/lib/desktop/server/coworker-files.ts`. `recoverInterruptedCoworkerEdits` and `claimed` stay private to that module. Do not reuse `Symbol.for('rerun.desktop.pdfFolderBoundary')`. The preview symbol is `Symbol.for('rerun.desktop.previewImageFolder')`.

```ts
import { bindCoworkerPreviewImageFolder } from './preview-image'

bindCoworkerPreviewImageFolder({
    recoverInterruptedEdits: (directory, workspaceRoot) => recoverInterruptedCoworkerEdits(directory, workspaceRoot),
    claimed,
})
```

Until that bind exists, `animation=1` falls back to `readCoworkerImage`. Animated GIF and WebP then still return 415 `Animated images can’t be previewed yet. Choose a static image.` Static PNG, JPEG, WebP, and single-frame GIF still preview. An already aborted `animation=1` request returns 499 `Image preview was closed.` before that fallback.

`DesktopCoworkerFiles.tsx` needs no edit. `openListed` already opens `DesktopFileImagePreview` for a PNG, JPEG, GIF, or WebP name and clears audio, video, and PDF. The preview appends `animation=1` itself. Do not set `autoPlay`. Do not point this preview at `/files/video` or `/files/audio`.

Closing Files still unmounts `FilesPanel` (`{open && <DialogContent>}`), so the selected file does not survive closing the dialog. That is existing behavior. While Files stays open, the open image path remains. Remounting the preview fetches that same path again. Opening the raster clears audio and video, and this preview never mounts `<audio>`, `<video>`, or `<canvas>`.

Chat and table cards call `/files/image` without `animation`. Leave those URLs, `readDesktopCardImage`, and the system-prompt sentence that animated images are unavailable. A card must not receive animated bytes from this slice.

## Behavior

`animation` must be a single query value `1`. More than one `animation`, or any other value, is 400 `Send the image to preview.` Omitting it keeps the static reader, including its animation refusal. The response headers and body shape are unchanged: original bytes, content type, content length, inline `filename*`, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, same-origin CORP, and `no-store`.

The preview reader copies `readImage`: lexical relative path, depth 64, reserved `.rerun-edit-` / `.rerun-backup-` / `.rerun-publish-` / `.rerun-rename-` / `.rerun-delete-` / `.rerun-import-` / `.rerun-retire-` names, no symlink, regular file, current uid, `nlink === 1`, optional `dev:ino` identity, pinned parent, and the post-read identity check. It does not add the PDF ctime/mtime check. Outcomes that match the static reader stay the same, including symlink 400, extra hard link 400, wrong uid 403, and a replaced inode 409 with no image bytes.

Animation-specific outcomes, curly apostrophes included:

- edge over 8192, or one frame or canvas over 16,777,216 pixels: 413 `This image is too large to preview.`
- more than 256 frames: 413 `This animation has too many frames to preview.`
- canvas width × height × frame count, or the sum of frame rectangles, over 48 × 1024 × 1024 pixels: 413 `This animation is too large to preview.`
- APNG (`acTL`, `fcTL`, or `fdAT`): 415 `Animated PNG can’t be previewed.`
- a GIF or WebP container that signals animation but is incomplete, or a frame that does not fit the canvas: 415 `This image is damaged and can’t be previewed.` The body is JSON, not the file.
- preview closed or aborted: 499 `Image preview was closed.`

A static GIF is one frame. A GIF with more than one image separator is served whole. One ANMF is still an animated WebP container: `animated` is true and the body is the original file, not a bare VP8 payload. GIF comments and WebP ICC, EXIF, and XMP chunks are skipped inside the file. A comment or metadata value that looks like `http://` is not fetched. There is no remote URL, no external-resource resolution, no OCR, and no upload of the image or its frames to a model.

VP8X on this path must be the first chunk, with the animation bit `0x02` set, reserved bits `0xC1` clear, and bytes 1–3 zero. ICC `0x20`, alpha `0x10`, EXIF `0x08`, and XMP `0x04` may be set. ICC comes before the frames; EXIF and XMP may also follow the last frame. `ANIM` is six bytes and comes before `ANMF`. Each `ANMF` has one `VP8 ` or `VP8L` whose dimensions equal that frame rectangle, and at most one `ALPH` before it.

## Limits

- The 8 MiB, 8192-edge, and 16,777,216-pixel caps are the static image caps. 256 frames and 48 Mi aggregate pixels apply only to this preview reader. They are not an OS memory quota. Pixel payloads are not fully decoded; a file that passes structure and then fails in the browser shows the damaged message.
- SVG, AVIF, ICO, and BMP stay out. APNG stays out.
- List rows are not thumbnails. Composer attach, logos, workspace icons, and result cards do not gain animation.
- Paths deeper than 64 components are refused. A backslash in a name is refused.
- There is no byte-range response. The final read checks the same inode and size; it is not an atomic inode-conditional read.
- Tests, typecheck, lint, build, packaging, and Mac acceptance were not run. Do not mark this capability accepted.
