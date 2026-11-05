# Desktop lane H — Safe SVG previews for coworker Files

Owner: H (this lane). Scope: `apps/ui/lib/desktop/server/preview-svg/**`, the authored
fixtures, regressions, and this doc. Root owns and will edit `preview-image.ts`, the image
route, `DesktopFileImagePreview.tsx`, and `DesktopCoworkerFiles.tsx`; the exact wiring
fragments are below. G owns raster formats; this adapter never touches `image-bytes.ts`
(only reads its shared ceilings) and never widens other consumers.

Original Rerun behavior: in the pinned source (`a6d63a4b542674ddd002e51b39ba0df6e0807bcc`),
`apps/ui/lib/files/preview.ts` classifies `*.svg` as an image and `components/files/FilePreview.tsx`
renders it with `<img src={rawUrl}>`, where `rawUrl` is the cloud's hosted file URL. The Mac
desktop has no hosted URL: the desktop image route (root-owned) returns confined file bytes,
and `DesktopFileImagePreview.tsx` (a Mac port of the FileDetail header + FilePreview image
frame) shows them from a blob and gates on raster content types. Today the desktop image
dispatcher rejects `.svg` with `415`. This lane fills that gap **without ever serving an
active SVG document**: it rasterizes a validated strict subset to an inert PNG, so the
existing raster frame, header, sibling nav, and `image/png` content-type gate work unchanged.

## How the adapter works

`rasterizeDesktopSvg(bytes, signal)` runs four bounded stages, aborting (499) between them:

1. **Bounded forward-cursor XML tokenizer** (`xml-tokens.ts`) — one UTF-8 decode (fatal) and
   one linear scan, mirroring the existing `html-tokens.ts` precedent. It rejects, up front:
   DTDs (`<!DOCTYPE …`), any entity or bare `&` (so entity expansion, external entities, and
   character references are impossible), processing instructions (only a leading
   `<?xml version="1.0" …?>` declaration is allowed), CDATA, malformed tags, unquoted or
   duplicate attributes, unmatched end tags, unclosed documents, stray control characters,
   and a second root. Comments are consumed and dropped; whitespace-only text is skipped.
2. **Strict-subset validator** (`svg-subset.ts`) — a fixed allowlist of static elements and
   per-element attributes. Unknown elements, unknown attributes, `style` attributes/elements,
   `on*` handlers, `src`, non-fragment `href`/`xlink:href`, `javascript:`/`vbscript:`/`data:`/
   `blob:` schemes, and any `url(...)` that is not exactly `url(#id)` are rejected with an
   honest reason. Geometry (`width`, `height`, `viewBox`, unit conversion, percentages) is
   resolved and clamped to the shared ceilings before anything is rendered.
3. **Canonical re-serialization** — the file's own bytes are never handed to the rasterizer.
   The validator rebuilds a canonical XML document from the validated tokens: comments gone,
   every value XML-escaped, `id`s and in-document fragment refs preserved, root `width`/
   `height` replaced by the bounded render target. Scripts, DTDs, entities, event handlers,
   external styles/fonts/images, and resource URLs physically cannot appear in this output.
   *Sharp alone is not a sanitizer*; sharp/librsvg only ever sees this document.
4. **Rasterization** (`index.ts`) — `sharp(...).png()` with a 10 s timeout and
   `failOn: 'warning'`. The PNG is then validated by the root-owned
   `inspectDesktopImageBytes('png', …)` (ceiling + structure). If the PNG exceeds the 8 MB
   response ceiling, the target is halved (aspect preserved) and retried, at most 4 times,
   then fails with an honest `dimensions` error. The result is
   `{ bytes, contentType: 'image/png', width, height, frames: 1, animated: false }`.

The subset keeps static drawing, gradients, clipping, masking, filters (no `feImage`), text
with system fonts (no embedded fonts, no stylesheets), internal `use`/`symbol`/`marker`
references, and transparency. It rejects everything animated, scriptable, externally
referenced, or styled: `script`, `foreignObject`, `image`, `a`, `style`, `audio`, `video`,
`iframe`, `embed`, `object`, `animate*`, `set`, `textPath`, `font`/`glyph`, DTDs, entities,
processing instructions, CDATA, event handlers, and any resource URL.

## Budgets

Shared raster ceilings stay authoritative (imported from `image-bytes.ts`); SVG-specific
structure budgets are stricter:

| Budget | Value | Error reason |
| --- | --- | --- |
| Input / decoded chars | 8 MiB (`DESKTOP_SVG_MAX_BYTES`, `DESKTOP_SVG_MAX_CHARS`) | `dimensions` |
| Elements | 4096 (`DESKTOP_SVG_MAX_ELEMENTS`) | `complex` |
| Nesting depth | 128 (`DESKTOP_SVG_MAX_DEPTH`) | `complex` |
| Attributes per element / total | 64 / 16,384 | `complex` |
| Attribute value length | 65,536 chars | `complex` |
| Text content | 2 MiB (`DESKTOP_SVG_MAX_TEXT_CHARS`) | `complex` |
| Output edge / pixels | 8192 / 16,777,216 (shared ceilings) | `dimensions` (or downscaled) |
| Rendered PNG bytes | 8 MiB (`DESKTOP_SVG_MAX_PNG_BYTES`) | downscale + retry, else `dimensions` |

## Error mapping for root

`DesktopSvgError` carries `reason` and an optional `detail` (the offending element or
attribute name, e.g. `script`, `onload`, `fill`, `metadata`). Suggested mapping, mirroring
`previewFailure()` in `preview-image.ts`:

| Reason | HTTP | Message |
| --- | --- | --- |
| `mismatch` | 415 | This file is not a supported image. |
| `corrupt` | 415 | This SVG is damaged and can’t be previewed. |
| `unsupported` | 415 | This SVG uses a feature that can’t be previewed safely. |
| `external` | 415 | This SVG references an external resource and can’t be previewed. |
| `dimensions` | 413 | This SVG is too large to preview. |
| `complex` | 413 | This SVG is too complex to preview. |
| abort | 499 | SVG preview was closed. (`assertSvgPreviewOpen` throws this itself) |

## Root integration fragments (exact edits root will make)

All file identity / owner / link / pinning discipline stays in the existing root-owned read
path; the adapter accepts the already-confined bytes and never re-opens paths.

**1. `apps/ui/lib/desktop/server/preview-image.ts`** — allow `.svg` through the kind gate
and dispatch to the adapter inside `readPreviewImage` (after `fileBytes` is read and all
identity checks passed, around line 175):

```ts
import { isDesktopSvgName, rasterizeDesktopSvg } from './preview-svg'
// ...
const kind = desktopRasterKind(name)
const svg = kind === null && isDesktopSvgName(name)
if (kind === null && !svg) throw new DesktopHttpError(415, 'Only PNG, JPEG, WebP, GIF, and SVG files can be previewed.')
// …all existing identity/owner/link checks and the confined read stay untouched…
assertPreviewOpen(signal)
const fileBytes = new Uint8Array(buffer.subarray(0, got))
if (svg) {
    const raster = await rasterizeDesktopSvg(fileBytes, signal)
    return {
        path: rel, name,
        bytes: raster.bytes, contentType: raster.contentType,
        identity: `${listed.dev}:${listed.ino}`,
        width: raster.width, height: raster.height,
        frames: 1, animated: false,
    }
}
let inspected: ReturnType<typeof inspectDesktopPreviewImageBytes>
// …existing raster path unchanged…
```

**2. `apps/ui/components/desktop/DesktopFileImagePreview.tsx`** — widen the name gate so
`.svg` files open in the existing raster preview (the response is `image/png`, which
`RASTER_TYPES` already admits):

```ts
const RASTER_NAME = /^.+\.(?:png|jpe?g|gif|webp|svg)$/i
```

`DesktopCoworkerFiles.tsx` already imports `isDesktopRasterName` from this module and needs
no further change.

**3. Route — no change.** The image route already sends `animation=1` to
`readCoworkerPreviewImage`, returns the adapter's bytes with
`content-type: image/png`, and sets `content-security-policy: default-src 'none'; sandbox`
plus `x-content-type-options: nosniff`, which is exactly right for a PNG preview.

**4. Tests** run with `apps/ui`'s vitest config, which already stubs `server-only` and
installs sharp as a direct dependency: `pnpm --filter ui test` (root runs them).

## Dependencies

**None added.** Rasterization uses `sharp@^0.35.1`, already a direct dependency of
`apps/ui/package.json` (and `apps/engine`) and already used by `composer-image-files.ts`.
`@xmldom/xmldom@0.8.15` stays what it is today — a transitive lockfile entry, not a direct
dependency — because this lane deliberately avoids an XML parser dependency: a general parser
brings entity expansion, external-entity, and DTD surfaces that the mandate excludes, and the
existing `html-tokens.ts` proves the owned bounded-tokenizer pattern. The tokenizer here is
stricter than a parser would need to be (any `&` is rejected outright), so the "exact need
without installing" clause does not apply.

## Mac adaptations

- The original cloud preview serves the file itself (`<img src={rawUrl}>`); the Mac has no
  hosted URL, so this adapter returns inert raster bytes over the existing authenticated
  route, keeping the original FileDetail header + FilePreview image frame in
  `DesktopFileImagePreview.tsx`.
- No network, shell decoder, or host-file resolution is reachable from the SVG: external
  references are rejected at validation, and the rasterizer only ever sees canonical XML.
- Text renders with system fonts through sharp/librsvg; embedded fonts are rejected.

## Remaining limits

- Strict subset by design: `style` attributes/elements, animation, `<image>`, `<a>`,
  `<foreignObject>`, `textPath`, external anything, entities, and DTDs are rejected with
  honest errors, never degraded rendering.
- Output is capped and, when the rendered PNG would exceed 8 MB, downscaled preserving
  aspect (bounded retries).
- Root execution/native acceptance is pending: tests, typecheck, lint, build, install, and
  live Mac preview QA are root's to run (`pnpm --filter ui test` for this lane).
