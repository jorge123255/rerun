# Round 30 G — bounded own-file image cards (source handoff)

Branch: `desktop/round30-image-cards`.
Base: `c9acacf82d6964890d57bc007346e78481ea3773`.
Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

Checks and native acceptance are pending root. No tests, type checks, lint, builds, servers, installations, model/API calls, playback, restart or UI QA were executed. No dependencies installed, credentials accessed, push or merge. This handoff is not capability acceptance or checklist completion.

## Source changes

- `apps/engine/src/desktop/card-file.ts`: add SVG/AVIF/ICO/BMP to own-file image admission and describe the bounded Files path. Existing visible workspace confinement, current inode recheck, grants, 12 files, source byte caps and all-or-nothing metadata admission remain in place. No engine decoding or model-visible image content.
- `apps/engine/src/desktop/card-file.test.ts`: extend confined own-file format cases; replace obsolete SVG refusal with TIFF refusal.
- `apps/ui/lib/desktop/file-card.ts`: accept the four additional image extensions; request the existing `animation=1` preview path with identity and an abortable five-second deadline; require inspected returned bytes.
- `apps/ui/lib/desktop/image-card-response.ts`: stream at most 8 MiB; cancel on invalid MIME/overflow/abort; require extension-appropriate raster MIME, including PNG only for converted formats; reuse existing pure Files structural inspectors. Return actual display frame count and composited pixel cost. Shared thumbnail accounting bounds 24 MiB image/video bytes, 256 image frames and 48 Mi pixels. No new codec, parser or rasterizer.
- `apps/ui/lib/desktop/image-card-response.test.ts`: conversion response, raw SVG refusal, corrupt output, expanded byte cap, cancellation, aggregate accounting and animated GIF frame cases. Structural GIF fixtures are not proof of browser decoding.
- `apps/ui/lib/desktop/file-card.test.ts`: update obsolete format refusals, actual valid PNG fixture, bounded request expectations and safe route-error expectation.
- `apps/ui/components/desktop/DesktopFileCard.tsx`: retain albums/captions/mixed tile order, four visible previews for both album and mixed cards, current response accounting. Owner/card content changes remount the owned subtree. Opening a lightbox aborts/releases thumbnails; closing deliberately reloads current previews. Thus lightbox bytes never sit beside four retained thumbnail blobs. Remaining mixed tiles explicitly offer opening instead of fetching hidden bytes.
- `apps/ui/components/desktop/DesktopFileCard.images.test.tsx`: valid PNG fixture, lazy mixed-card and corrupt response expectations.
- `apps/ui/components/desktop/DesktopFileLightbox.tsx`: key its owned subtree by owner/card/index, preserving original paging and labels; ignore late error handlers for released URLs. Existing text/audio/video/PDF readers and controls remain unchanged.
- This handoff.

## Original references and necessary Mac adaptations

Read using `git show` at the original pin:

- `apps/engine/src/tools/builtin/cards.ts`, `card_file`: ordered arrays, metadata-only references, all-or-nothing failure. Mac keeps this design, limits references to granted persistent own Files, and leaves hosted/shared paths unavailable.
- `packages/contracts/src/chat-card.ts`, `FileCardEntry`/`FileCard`/`CARD_MAX_FILES`: retain existing snapshot payload and ordered entries. No contract or export edits.
- `apps/ui/components/chat/FileCard.tsx`: album-vs-mixed rendering and ordered lightbox selection retained. Mac substitutes authenticated current-source reads for raw hosted URLs.
- `apps/ui/components/chat/MediaAlbum.tsx`: one natural image, responsive two-column multi-image album, captions and four-tile overflow retained.
- `apps/ui/components/chat/AttachmentTile.tsx`: mixed square tiles and opening semantics retained; hidden preview bytes stay lazy.
- `apps/ui/components/chat/AttachmentLightbox.tsx`: title, counter and Previous/Next attachment controls retained. Mac retains authenticated blob previews and explicit lifecycle cleanup instead of direct raw links.
- `apps/ui/lib/files/preview.ts`: original image extension set is the target set; raw SVG is never displayed. Static SVG and additional raster formats must pass accepted Files conversion to inert PNG.

Read current `preview-image.ts`, `animated-image.ts`, `image-bytes.ts`, `preview-svg/index.ts` and `preview-raster-formats/index.ts`, and their existing cases. Those implementations are unchanged. The pure structural inspectors imported by the browser helper have no server-only marker or Node dependency; root must verify the client bundle boundary.

Read `apps/ui/AGENTS.md` and `CLAUDE.md`, root `CLAUDE.md`, and `docs/desktop-round30-interfaces.md`. This lane has no node_modules; read the installed Next 16.2.6 use-client guide from the packaging worktree, at `node_modules/.pnpm/next@16.2.6_@babel+core@7.29.7_@opentelemetry+api@1.9.1_react-dom@19.2.4_react@19.2.4/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`. No installation performed.

## Root integration

No new route, migration, registry family or shared contract is required. Keep the existing authenticated `files/image` dispatcher. Its typed branch is already present in this base:

```ts
const image = animation.length === 1
    ? await readCoworkerPreviewImage(runtime, agentId, path, identity === null ? undefined : identity, request.signal)
    : await readCoworkerImage(runtime, agentId, path, identity === null ? undefined : identity)
```

Root must preserve its no-store, nosniff, sandbox and same-origin response headers. `animation=1` applies only to the own-file result reader changed here; do not extend logos, composer, shared cards, upload dispatch or native scratch outputs.

The accepted reader needs the root-owned recovery/claim binding; an unbound reader intentionally falls back to static-only:

```ts
import { bindCoworkerPreviewImageFolder, type CoworkerPreviewImageFolder } from '@/lib/desktop/server/preview-image'
function bindResultCardImageAuthority(boundary: CoworkerPreviewImageFolder): () => void {
    return bindCoworkerPreviewImageFolder(boundary)
}
```

Call with root's existing real recovery/claim closures at bootstrap, retain disposer with bootstrap teardown, and reuse the binding already installed for Files rather than replacing it per request. Those authority closures cannot be invented in this lane.

Existing UI wiring remains:

```tsx
<DesktopFileCard agentId={localCoworker.id} card={parsedOwnFileCard} />
```

Use authoritative local coworker identity and `desktopFileCardOf` for saved results. Existing mounted board/chat ownership remains root's responsibility. Tool catalog/registry descriptions should list bounded GIF/WebP animation and static SVG/AVIF/ICO/BMP through Files conversion, with existing limits; no new capability grants.

## Dependencies and honest limits

- Accepted Files `readCoworkerPreviewImage`, recovery binding, owner/path/current inode checks, SVG subset rasterization, raster conversion, and runtime sharp support are prerequisites. They exist as source in this base; no decoder execution was attempted.
- **Shared-reader limitation requiring root attention before acceptance:** existing GIF/WebP inspector enforces 256 frames, canvas/aggregate pixel bounds and source size, but exports no duration metadata or duration limit. This lane does not invent a second animation parser. Five-second response deadline bounds fetch/read/inspection wall time, not animation timeline or browser frame decode time. Root must extend the accepted shared reader/inspector to enforce the desired duration/decode policy and run adversarial GIF/WebP playback acceptance. This handoff does not claim those requirements are verified or newly satisfied.
- Browser decoders still perform actual PNG/JPEG/GIF/WebP decoding after structural inspection. A failed decode releases its URL. No new codec exists here.
- Engine admission validates source metadata only. Invalid content produces an explicit unavailable tile when opened; it never substitutes another source or mutates saved attachments. Conversion expansion is checked from actual streamed bytes before a URL exists.
- Source metadata keeps the original inode identity design; opening reads the current persistent file under that identity, not a historical byte snapshot. Existing Files protection against same-inode concurrent mutation is root's authority, unchanged here.
- Combined accounting covers the four live thumbnails, or the sole lightbox preview while thumbnails are released. It does not eagerly convert hidden pages. Source-size admission still conservatively bounds the complete card. Decoded video constraints remain in the unchanged accepted video reader.
- Existing suites outside the owned image cases can use synthetic non-image HTTP fixtures; root should update such fixtures to real bounded image responses when they exercise this stricter reader. No suite was executed here.
- Root must run type/lint/tests and real card calls, malformed/mismatched/unsafe format cases, conversion expansion, animated GIF/WebP rendering, SVG refusal, aggregate preview bounds, mixed hidden pages, owner/card changes during requests, late errors, close/unmount, responsive album/lightbox views, playback and restart checks. Text/audio/video/PDF behavior requires regression execution by root.
