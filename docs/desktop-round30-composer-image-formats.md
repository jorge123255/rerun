# Round 30 — still-image composer formats (lane H handoff)

This source extends the Mac composer's still-image picker from PNG/JPEG/WebP to static GIF, AVIF,
ICO, BMP, and the accepted safe SVG subset. Every newly accepted format is converted to a bounded,
immutable PNG before it can enter a draft, queue, history row, or the provider. Raw SVG and other
source bytes never reach Codex. Root owns all checks, integration, installation, and native/restart
acceptance; this note does not claim them.

Branch `desktop/round30-composer-image-formats`, exact base
`c9acacf82d6964890d57bc007346e78481ea3773`.
Original Rerun reference `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Original sources read

- `apps/ui/components/chat/ChatComposer.tsx` — attachment limits, ordered chips, blocked-send rules.
- `apps/ui/components/chat/ChatAttachments.tsx` and `ChatAttachmentChip.tsx` — chip order, progress,
  retry, cancel, remove.
- `apps/ui/components/chat/AttachmentTile.tsx` and `AttachmentLightbox.tsx` — attachment presentation.
- `apps/ui/hooks/useFileUploads.ts` — per-file status, retry/cancel and completion semantics.
- `apps/ui/lib/chat/attachments-marker.ts` — marker/name contract.
- Local accepted converters reused unchanged: `apps/ui/lib/desktop/server/image-bytes.ts`,
  `preview-raster-formats/` (AVIF/ICO/BMP), `preview-svg/` (strict safe subset + rasterizer).

The local Mac boundary stores existing workspace files rather than uploading hosted bytes; the
composer keeps the existing Mac chips, durable attempt reservations, draft/queue receipts and
send/regenerate paths.

## Implemented

### Client selection and preflight (`apps/ui/lib/desktop/composer-image.ts`)

- `DesktopImageKind` now includes `png | jpeg | webp | gif | avif | ico | bmp | svg`.
- PNG/JPEG/WebP remain direct; every other format maps to a canonical `image/png` snapshot.
- The accept list covers `.gif`, `.avif`, `.ico`, `.bmp`, `.svg` and their browser MIME spellings.
- Preflight checks the safe filename, per-file 8 MiB source cap, 8 MiB aggregate reservation, four
  image slots, and format magic. It deliberately does **not** call `createImageBitmap` for SVG or
  any converted format; the server validates those bytes and dimensions.
- SVG preflight only checks a bounded text head for `<svg`; it never creates an object URL.
- Drop/paste extraction reuses the same extension gate.

### Upload lifecycle (`use-composer-image-uploads.ts`)

- Converted inputs get `previewUrl: null`, so a raw SVG/AVIF/ICO/BMP/GIF never becomes a client
  object URL; the chip shows the existing placeholder until the validated PNG snapshot returns.
- Ordered reservations, attempt IDs, uncertain outcomes, retry/cancel, atomic confirmation and
  draft attachment remain the existing lifecycle. A cancelled conversion cannot publish a chip.
- `composer-upload-attempts.ts` admits the new extensions in the shared reservation/hydration
  schema; `composer-image-attempts.ts` follows through `desktopImageKindForName`.

### Server conversion and snapshot publication

New `apps/ui/lib/desktop/server/composer-image-formats.ts`:

- `inspectComposerImageSource` validates the display name, source magic/format and source size.
  - PNG/JPEG/WebP stay byte-for-byte.
  - GIF must pass the existing static GIF structural reader (animated GIF refused), then is encoded
    to PNG with a 5 s deadline and caller-abort destruction.
  - AVIF/ICO/BMP delegate to `convertRasterPreviewImage` (existing bounded preview decoder, 5 s
    deadline, caller abort, output cap and dimension checks).
  - SVG delegates to `rasterizeDesktopSvg` (strict subset, 12 s deadline, output downscale, caller
    abort). Raw SVG is never stored or sent.
- `inspectStoredComposerImage` revalidates a snapshot by its canonical media type, never by the
  original display filename.
- Converted bytes are published under a canonical random `*.png` visible filename; the original
  filename is carried only as snapshot display metadata (`name`). The private snapshot file is
  `<sha256>.png`, and `mediaType` is `image/png`.
- `server/composer-image-files.ts` now imports this helper, checks the source and converted output
  caps, and keeps the existing content-addressed store, create-only visible publication and
  pre-publication snapshot verification.
- Existing `pruneDesktopImageSnapshots` remains a deliberate no-op: no draft/queue/history/sibling
  reference can lose its bytes, and an old snapshot is never rewritten under a new policy.

## Root wiring fragments (root-owned files; not edited here)

1. `apps/ui/lib/desktop/server/composer-uploads.ts` classifies image attempts with its own
   PNG/JPEG/WebP regex. Replace it with the shared kind predicate so GIF/AVIF/ICO/BMP/SVG reserve
   an image slot instead of a text slot:

```ts
import { desktopImageKindForName } from '../composer-image'
const isImage = (name: string) => desktopImageKindForName(name) !== null
```

2. `apps/ui/components/desktop/DesktopConversation.tsx` already renders
   `${DESKTOP_UPLOAD_ACCEPT},${DESKTOP_IMAGE_UPLOAD_ACCEPT}` in the file input and already groups
   dropped/pasted files with `desktopImageKindForName`. No code change is needed for the new
   extensions; keep the existing 14-file batch cap and the ordered drain.
3. `apps/ui/app/api/desktop/agents/[agentId]/images/route.ts` needs no preflight change: the
   multipart cap is one 8 MiB source file, and `importDesktopComposerImage` performs the format
   conversion. Update its comment from "PNG/JPEG/WebP" to "supported still image; converted to PNG"
   when root touches the file.
4. No contract, database, migration, registry/grant, provider, `DesktopApp` or `DesktopBoard` change
   is required.

## Changed files

- `apps/ui/lib/desktop/composer-image.ts`
- `apps/ui/lib/desktop/composer-image-attempts.ts`
- `apps/ui/lib/desktop/composer-upload-attempts.ts`
- `apps/ui/lib/desktop/use-composer-image-uploads.ts`
- `apps/ui/lib/desktop/server/composer-image-formats.ts` (new)
- `apps/ui/lib/desktop/server/composer-image-files.ts`
- `apps/ui/lib/desktop/composer-image.test.ts`
- `apps/ui/lib/desktop/composer-upload-attempts.mixed.test.ts`
- `apps/ui/lib/desktop/server/composer-image-files.test.ts`
- `docs/desktop-round30-composer-image-formats.md` (this note)

## Verification status and limits

- No tests, typecheck, lint, build, packaging, install, live model request, or Mac/restart QA was
  run by this lane. Authored cases are not executed.
- AVIF/ICO/BMP conversion is delegated to the existing accepted preview converters; the authored
  server import cases cover GIF, BMP, ICO and SVG, while a real AVIF codec/visual check remains
  root's.
- Client preflight checks magic and source caps only. Animated GIF/AVIF/WebP are refused by the
  server-side shared inspectors; client-side animation detection is intentionally absent.
- The 16 MiB image aggregate is enforced on final PNG snapshot bytes at draft save/send. Client
  preflight reserves source file sizes, so a conversion that grows substantially may fail later
  with the existing aggregate error.
- Provider media type and bytes are canonical `image/png`; the original display filename is still
  passed as provider `filename` metadata. No PNG bytes are stored under `.svg`, `.avif`, `.ico` or
  `.bmp` names.
- No raw SVG object URL, no `createImageBitmap` for SVG, no audio/video model input, no provider or
  native image-permission change.
- Earlier lane worktrees, the installed app, live workspace/Keychain, Docker and servers were not
  touched. No push or merge.
