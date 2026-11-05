# D5 AVIF, ICO and BMP Files preview handoff

Branch: `desktop/round29-raster-formats`.
Prepared base: `447fb9f03cd1113d50d199a1ec4c433198dc0ef9`.
Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

Source only. No tests, type checks, lint, builds, packaging, installs, app servers, live model requests, external services, installed app/live workspace/Keychain changes, or Mac/restart QA were executed. Root execution and native acceptance are pending. This does not mark D5 accepted.

## Original design and current boundaries

Read at the original pin before editing:

- `apps/ui/lib/files/preview.ts`: original `IMAGE_EXTS` includes AVIF, ICO and BMP.
- `apps/ui/components/files/FilePreview.tsx`: existing image frame is a centered `<img>`, `overflow-auto bg-muted p-3`, `max-h-full max-w-full object-contain`.
- `apps/ui/components/files/FileDetail.tsx`: `PanelEditorHeader`, title/Back, previous/next sibling controls, position, and local keyboard navigation.

Read the current `preview-image.ts`, `animated-image.ts` (this base's preview byte inspector), shared `image-bytes.ts`, image route, `DesktopFileImagePreview.tsx`, `DesktopCoworkerFiles.tsx`, and `docs/desktop-round29-interfaces.md`. Read installed Next runtime documentation and Sharp's staged `lib/index.d.ts`, including supported buffer inputs, metadata, pixel/channel limits, timeout and PNG output. No file named `preview-image-bytes.ts` exists at this base; the corresponding modules are `animated-image.ts` and `image-bytes.ts`.

The Mac adaptation supplies inert bounded PNG bytes through the existing authenticated Files reader/blob image frame. No new layout, file URL, navigation model, image MIME expansion, or upload policy is needed. Header, sibling navigation, original names/paths and identity remain owned by the existing components/reader.

## Exported server-only interface

Module: `apps/ui/lib/desktop/server/preview-raster-formats/index.ts`.

```ts
export type RasterPreviewFormat = 'avif' | 'ico' | 'bmp'
export type RasterPreviewInspection = {
    format: RasterPreviewFormat
    width: number
    height: number
    frames: 1
    animated: false
    sourceFrames: number
    aggregatePixels: number
    selectedFrame?: number
}
export type RasterPreviewDisplay = RasterPreviewInspection & {
    bytes: Uint8Array
    contentType: 'image/png'
}
export function inspectRasterPreviewImage(
    bytes: Uint8Array, extension: string, signal: AbortSignal,
): RasterPreviewInspection
export function convertRasterPreviewImage(
    bytes: Uint8Array, extension: string, signal: AbortSignal,
): Promise<RasterPreviewDisplay>
export function rasterPreviewFailure(error: unknown): {
    status: number
    message: string
}
```

`extension` is `avif`, `ico` or `bmp`, optionally with a leading dot; it is not a filename/path. Inspection proves admitted structure and geometry, not successful native entropy decoding. Conversion snapshots the bounded input, performs the actual selected decode, checks returned geometry/channels/length, encodes fresh PNG without source metadata, and validates PNG CRC/chunks/dimensions through unchanged `inspectDesktopImageBytes('png', ...)` before returning. No original AVIF/ICO/BMP bytes reach Chromium.

`frames` describes the display (one static frame). `sourceFrames` counts ICO directory images, not an animation; `selectedFrame` is the zero-based directory index. AVIF's optional alpha item contributes to `aggregatePixels`, not frame count.

## Supported subsets and bounds

- Input and output each at most 8 MiB; width/height at most 8192; each image and the sum of AVIF item/ICO frame canvases at most 16,777,216 pixels. Raw RGBA is consequently at most 64 MiB. Encoded PNG allocation is bounded by that raw canvas, then rejected if it exceeds the existing 8 MiB display ceiling; no resize silently bypasses a ceiling.
- BMP: Windows 40/108/124-byte DIB headers, uncompressed BI_RGB 1/4/8-bit palettes and 16/24/32-bit pixels; 16/32-bit BI_BITFIELDS/BI_ALPHABITFIELDS with nonoverlapping contiguous masks. Row padding and top-down/bottom-up orientation are explicit. Standalone 32-bit BI_RGB's reserved byte is opaque; alpha requires explicit masks. File size, offsets, stride, palette and pixel extent are checked before allocation. V4/V5 linked/embedded profiles and profile offsets are refused. Calibrated color-space endpoints are not color-managed; pixels are treated as sRGB.
- ICO: at most 64 directory entries, every directory/frame extent and declared dimension validated, with contiguous disjoint payloads. Supported payloads are static PNG and BI_RGB DIB with the same indexed/16/24/32-bit handling; AND masks are required. Selection is largest area, then greater bits per pixel, then earlier directory index. Only that frame is entropy/pixel decoded. Meaningful 32-bit alpha takes precedence over the AND mask; zero-alpha legacy icons use the mask. Monochrome inversion pixels are refused because their background-dependent operation cannot be represented in PNG. CUR files, compressed DIBs, PNG animation, absent masks, overlapping/gapped payload layouts and inconsistent directory depths are refused.
- AVIF: bounded ISO BMFF walk (256 boxes), one primary `av01` item and optionally one same-size alpha `av01` item. Primary associations, `ispe`, `av1C`, self-contained `iloc` extents, IDs and alpha `auxl` references are validated. Item extents must lie in `mdat` with no overlaps or external data references. Supported properties are `ispe`, `av1C`, `pixi`, nclx `colr` and the standard alpha `auxC`. No grids, overlays, thumbnails, Exif/XMP items, ICC profiles, transforms, `idat` construction, general temporal containers, or unknown essential layouts are forwarded to the decoder.
- AV1: before Sharp metadata/decode, bounded OBU parsing checks the sequence canvas against each associated `ispe` and the same dimension/pixel ceilings. This slice accepts reduced still-picture sequence headers with no super-resolution/spatial layers, one coded key frame and bounded frame/tile OBUs. General sequence headers, redundant frames and unsupported OBU layouts are refused. Sharp validates the remaining AV1 codec syntax during actual decoding; inspection alone is not a decoder verdict.
- Animated AVIF is truthfully unavailable. `avis`, `moov`, additional coded frames, or native animation metadata are refused, never flattened into an apparently successful still preview. Non-primary non-alpha image items are unavailable even if they could be a still collection.
- Sharp receives only Buffer input (admitted AVIF or selected PNG) or explicitly described raw RGBA. It never receives an ICO/BMP buffer, path, URL, SVG or shell command. There is no filesystem, network, process or shell decoder API in the adapters. Unsupported layouts remain errors rather than falling through to a general native loader.
- Native processing uses `failOn: 'warning'`, `unlimited: false`, explicit pixel/channel ceilings, ignored ICC, one page and three-second libvips timeouts. A five-second operation deadline includes queue time. Abort destroys active Sharp streams and discards any result; bitmap loops yield and check abort every 16 rows. The native library may still drain in-flight work after stream destruction; this is not a worker-process hard-kill guarantee. Root must verify packaged cancellation/decoder behavior.

## Exact root wiring fragments

Do not change shared upload/logo `image-bytes.ts`, `desktopRasterKind`, `readCoworkerImage`, composer/import/result-card allowlists, or H's SVG module.

In `apps/ui/lib/desktop/server/preview-image.ts`, import:

```ts
import {
    convertRasterPreviewImage, RasterPreviewError, rasterPreviewFailure,
} from './preview-raster-formats'
```

Inside the existing confined `readPreviewImage`, replace only its filename gate:

```ts
const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
const extraRaster = extension === 'avif' || extension === 'ico' || extension === 'bmp'
const kind = desktopRasterKind(name)
if (!kind && !extraRaster) {
    throw new DesktopHttpError(415, 'This file is not a supported image.')
}
```

Root should compose this gate with H's independent SVG gate. Do not modify any path, owner, regular-file, link-count, identity, byte-read, directory-pin or changed-file checks. Keep conversion inside the existing roster/folder boundary, after all current read/identity/parent rechecks and `assertPreviewOpen(signal)`. Replace the current final inspect/readback block with:

```ts
const fileBytes = new Uint8Array(buffer.subarray(0, got))
try {
    const display = extraRaster
        ? await convertRasterPreviewImage(
            fileBytes, extension, signal ?? new AbortController().signal,
        )
        : {
            ...inspectDesktopPreviewImageBytes(kind!, fileBytes),
            bytes: fileBytes,
        }
    assertPreviewOpen(signal)
    return {
        path: rel, name, bytes: display.bytes,
        contentType: display.contentType,
        identity: `${listed.dev}:${listed.ino}`,
        width: display.width, height: display.height,
        frames: display.frames, animated: display.animated,
    }
} catch (error) {
    if (error instanceof DesktopHttpError) throw error
    if (error instanceof RasterPreviewError) {
        const failure = rasterPreviewFailure(error)
        throw new DesktopHttpError(failure.status, failure.message)
    }
    throw previewFailure(error)
}
```

This keeps GIF/WebP behavior unchanged. H's SVG dispatch must be a separate branch before the `kind!` fallback, so an SVG cannot reach either native buffer decoder. Keep the current static-reader fallback when folder closures are unbound; new previews require the existing real folder binding. Do not create an alternate file reader to bypass a missing binding.

In root-owned `DesktopFileImagePreview.tsx`, change only the Files name classifier:

```ts
const RASTER_NAME = /^.+\.(?:png|jpe?g|gif|webp|avif|ico|bmp)$/i
```

Its existing slash/backslash/NUL refusal stays. Root composes H's SVG classification separately. Leave `RASTER_TYPES` unchanged: these adapters return `image/png`. `DesktopCoworkerFiles.tsx` already calls this classifier and passes its existing header/siblings/ref props to `DesktopFileImagePreview`, so it needs no separate routing or layout change for G's formats.

Keep the image route's `animation=1` preview dispatch and forwarded `request.signal`; callers without that preview flag keep `readCoworkerImage` and cannot gain new formats. Retain no-store, no-sniff, same-origin/CSP headers and 8 MiB response checks. Ensure this route uses Node (the installed Next docs specify `runtime = 'nodejs'`; the current default is Node). No additional client MIME or CSP allowance is required because output is normal PNG.

## Dependencies and root execution

No new dependency or installation is requested. `apps/ui/package.json` already declares `sharp: ^0.35.1`; root must package the pinned/native 0.35.1 implementation and its libheif/AV1 capability and validate on the target Mac. Sharp's input type documentation lists AVIF and PNG; it does not establish ICO/BMP input support, which this lane does not assume. If root's packaged Sharp cannot load AVIF, report that actual decoder prerequisite; do not use a host-installed image tool as a fallback.

New files:

- `apps/ui/lib/desktop/server/preview-raster-formats/index.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/common.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/bitmap.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/ico.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/avif.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/av1.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/fixtures.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/inspection.test.ts`
- `apps/ui/lib/desktop/server/preview-raster-formats/codec.test.ts`
- `docs/desktop-round29-raster-formats-handoff.md`

Fixtures are authored source factories. The synthetic AVIF container has deliberately invalid entropy data; it is only a geometry/structure fixture. The codec regression generates real RGB and alpha AVIF with Sharp during root's test execution and must demonstrate decode, PNG output and pixel content. Other focused regression sources cover BMP orientation/padding/palettes/bitfields, ICO selection/alpha/masks/PNG, duplicate extents, malformed offsets, oversized container/coded dimensions, multiple AV1 frames, external references, linked-profile refusal and abort. None were run by this lane.

Root must execute those regressions plus integration checks for existing PNG/JPEG/GIF/WebP behavior, swapped identity, wrong owner, symlink/hardlink and parent confinement, cancellation/stale blob cleanup, header and sibling navigation, unsupported-layout error UI, decoder time/output ceilings, unchanged upload/logo/composer/card policy, and packaged Chromium PNG display. Then build/package/install and perform Mac/restart QA. No source-only or screenshot-only acceptance claim is made.
