# Round 33 C8 — shared and document result file cards

Source handoff only. Tests, typecheck, lint, build, and native Mac QA were not run. This is not Electron acceptance. C8 is not marked complete.

Worktree: `desktop/round33-result-file-cards`. Pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` was an ancestor of the base this lane started from. No other worktree was edited.

## Original behavior kept

Original `card_file` in `apps/engine/src/tools/builtin/cards.ts` (not edited): up to 12 files, all-or-nothing `Could not show that file/those files, nothing was shown:`, success `JSON.stringify({ kind: 'file', files })`. Its `scopeOf()` treats an absolute path inside `sharedDir()` as shared. This lane does not copy that inference. Omitted scope stays `agent`. Scope `shared` is the only way onto the shared folder.

Original `FilePreview` binary panel (not edited): the sentence `No preview available for this file type` and a Download control. The Mac control is a button, not an `<a href>` to a raw or absolute URL.

Accepted private image/video albums, captions, PDF tiles, and audio tiles still use `DesktopFileCard` and `DesktopFileLightbox`. Those files were not redesigned. `DesktopFileLightbox`, `AttachmentTile`, `FilePreview`, `FileCard`, contracts, grants, `engine-history.ts`, and uploaded-attachment code were not edited.

## What this lane owns

- `apps/engine/src/desktop/card-file.ts` — admission, explicit scope, shared read, generic files.
- `apps/ui/lib/desktop/file-card.ts` — `desktopFileCardOf` keeps new cards through the existing history parser.
- `apps/ui/components/desktop/DesktopFileCard.tsx` — chooses the dialog. Optional `saveResultFile`.
- `apps/ui/components/desktop/result-files/**` — dialog, pure download decisions.
- `apps/ui/lib/desktop/server/result-files/**` — ticket parser, response builder, `bindDesktopResultFileRead`, `handleDesktopResultFilePost`.
- Regression sources listed below. They were not executed.
- This handoff.

No `app/api` route was added. The handler does not start a model run or publish a tool result.

## Admission

`explicitDesktopCardScope(undefined | 'agent')` is `agent`. `explicitDesktopCardScope('shared')` is `shared`. An absolute path never selects shared. It stays on the private checker and fails the relative-path rule.

`desktopCardFilePublication` keeps input order. Any failure returns the original nothing-shown message and no card.

Ungranted shared, checked before the filesystem, throws `Shared files are not available in a Mac result card.` Both `cardFile` and `sharedFilesRead` are required. `sharedFilesRead` still goes through `requireDesktopToolGrant`, so `tools.shared === false` fails closed. After the whole set, `cardFile` is checked again, and `sharedFilesRead` is checked again when any shown file is shared. A dropped grant publishes nothing.

Granted shared files use `resolveEngineSharedDirectory(realpath(dataDir()))`, then `listSharedDirectory` on the parent (`.` at the top). The name must be a listed file whose size matches. `openWithoutLinks` runs only when `relative(root, target)` is exactly the requested relative path. The file must be a regular file, `nlink === 1`, and the same uid as the process. A second stat must show the same dev, ino, size, and ctime. `readSharedText` is not used, so a binary is not refused as non-UTF-8. A name past the 512-entry listing is unavailable. There is no second scan and no injected shared root.

Private files still use `cardRelativePath`, `workspacePath`, and `openWithoutLinks`. Private text stays `{ path, name, size, scope: 'agent' }` with no identity. Every shared entry, including text, stores `identity` as `dev:ino`. Generic private files store identity too. Preview kinds are unchanged: text 32 KiB, image 8 MiB, audio/video/PDF/generic 16 MiB. Empty generic files are refused. Private images and videos still share the 24 MiB album budget. Shared files and generic files do not.

Generic means a visible relative file that is not txt/md, PDF, or an accepted image, audio, or video. The bytes are not read into the tool result. They are not executed, unpacked, parsed, or converted. Office names are generic files.

The tool description no longer says shared files are unavailable. It does not contain the substring `shared space`. A shared file is included only when scope is `"shared"` and shared-files permission is on.

## Renderer

`desktopFileCardOf` still accepts the old private text, image, audio, video, and PDF shapes. Private text drops identity when one is present. One bad file rejects the card. Saved cards keep relative paths only. `publicDesktopHistory` already calls this function and sets `input: {}`, so history opening does not need an edit there and does not publish a new result.

Shared files and generic files are result files (`isDesktopResultFile`). They are not album entries and are not fetched through `/files/image` or the other private readers. A private-only image or video card is still the album. A mixed card keeps the square row. Opening a private preview still uses `DesktopFileLightbox`, with shared and generic files removed from that pager so it cannot read them as private text. Opening a result file uses `DesktopResultFilePreview` for that file only.

Shared PNG, JPEG, GIF, WebP, audio, video, and UTF-8 text can show from a verified read in that dialog. Shared SVG, AVIF, ICO, BMP, and PDF do not. Those private previews depend on converters and the PDF page renderer, which this dialog does not call. GIF and WebP frame caps are not applied on this path. A failed UTF-8 decode shows the no-preview panel instead of a partial string.

The no-preview panel says `No preview available for this file type`. Download sends `POST /api/desktop/coworkers/<agentId>/result-files` with `{ path, scope, identity, size }` only. The response must be `application/octet-stream`, `cache-control: no-store`, `content-length` equal to the saved size, and `x-rerun-result-identity` equal to the saved identity. A missing length, a short body, an identity mismatch, an abort, or a save callback that returns false does not show Saved. Cancel shows `Download cancelled.` With no `saveResultFile`, a verified body is handed to the browser under the safe name and the card does not say Saved or Downloaded. Saved appears only when `saveResultFile` returns true. The callback receives the safe name and the bytes. It does not receive a renderer path.

`desktopResultFileName` rejects an empty name, a name over 255, a leading dot, a slash, a control, a quote, or a semicolon. It does not strip them. Content-Disposition is built from the path basename.

## Root integration

Do not treat downloads as live until these three edits land.

1. Mount the handler. This lane did not add the file.

```ts
// apps/ui/app/api/desktop/coworkers/[agentId]/result-files/route.ts
import { handleDesktopResultFilePost } from '@/lib/desktop/server/result-files/handler'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ agentId: string }> }

export function POST(request: Request, { params }: Context) {
    return desktopRoute(request, async runtime => handleDesktopResultFilePost(runtime, (await params).agentId, request))
}
```

The client calls that relative path. A host or port must not be stored on the card.

2. Bind the reader once at desktop startup. Leave it unbound and every read is 503 `{ error: 'Result file downloads are not available.', downloaded: false }` with no bytes. The handler resolves `engineAgentId` with `findDesktopAgent` and `assertCoworkerNotDeleting`. Do not take an engine id, root, or filename from the body.

```ts
import { bindDesktopResultFileRead } from '@/lib/desktop/server/result-files/handler'

bindDesktopResultFileRead({
    async read(input) {
        return readOwnedResultFile(input)
    },
})
```

`readOwnedResultFile` is root’s function. Recheck dev, ino, `nlink === 1`, size, and ctime before reading. `scope: 'agent'` may open only that `engineAgentId` workspace. `scope: 'shared'` may open only `resolveDesktopSharedDirectory(runtime.dataRoot)`. Do not follow a link. Return null when the file is missing, revoked, or no longer that identity. Return `{ bytes, identity, size }` only when `bytes.byteLength === size`. A pasted stub that always returns null would 404 every download.

`desktopResultFileResponse` turns a null into 404 and an identity or size mismatch into 409. Both set `downloaded: false`. A thrown `DesktopHttpError` is passed through `desktopRoute`. Any other throw is 503 and not a download.

3. Pass the native save callback. This lane did not edit `DesktopAssistantReply`.

```tsx
<DesktopFileCard agentId={agentId} card={card} saveResultFile={saveResultFile} />
```

`saveResultFile(name, bytes)` must choose the destination in root. Return true only after the saved bytes match. Return false for cancel. Ignore a call whose name fails `desktopResultFileName`.

Optional catalog sentence, in `packages/contracts/src/desktop-tool-grants.ts`, which this lane did not edit. Replace the `cardFile` blurb with: `Show this coworker’s existing files as preview tiles, or as download tiles when the type has no preview. A shared-folder file is included only when scope is shared and shared files permission is on.`

## Durable behavior

The card JSON is the projection: relative path, name, size, scope, and identity where required. It has no host and no port. After restart, `desktopFileCardOf` accepts that JSON and the live routes read the current bytes. A replaced or deleted file fails the identity or size check and is not reported as downloaded. An old private card without a generic identity still parses as it did. A generic or shared card without a valid identity does not draw.

Closing the dialog or pressing Cancel aborts the read and does not call `saveResultFile` for that attempt. A callback that has already been entered belongs to root’s save UI.

## Tests that will disagree

Not edited. Root should update them when this lane is integrated.

`apps/engine/src/desktop/card-file.test.ts` cases `reports/image.tiff`, `shots/clip.avi`, and `voice/tone.aac` expect `/relative .* path/`. Those paths are now generic files. The fixtures do not create them, so the message is `That file is unavailable in this coworker’s workspace.` Shared-scope cases that only grant `cardFile` still match `/Shared files are not available/`. The description assertion `not.toContain('shared space')` still holds.

`apps/ui/lib/desktop/file-card.test.ts` currently expects these to be undefined, and they now parse when identity is present: `a shared image`, `a shared audio file`, `a shared video file`, `a shared pdf`, `an unsupported image` (`photo.heic`), `an unsupported video` (`clip.avi`), `an unsupported AAC audio` (`tone.aac`). `a shared file` (text, no identity) and `an unsupported document` (`image.tiff` via `file()`, no identity) stay undefined. A PDF without identity stays undefined.

## Regression sources

Authored and not run:

- `apps/engine/src/desktop/card-file.shared.test.ts` — scope and all-or-nothing publication. No server and no workspace data.
- `apps/ui/lib/desktop/file-card.result.test.ts` — mixed order, history JSON without a host, identity rules, album budget, hostile paths.
- `apps/ui/components/desktop/result-files/state.test.ts` — short reads, stale tickets, cancel, and Saved only after a true callback.
- `apps/ui/lib/desktop/server/result-files/response.test.ts` — hostile bodies, 404/409, disposition, and unbound 503. The unbound case returns before the database is opened.

## Matrix

| Behavior | Implemented | Depends on root | Unsupported |
| --- | --- | --- | --- |
| Explicit scope, omitted scope stays private | ✓ | — | — |
| Ungranted shared refusal, no partial card | ✓ | — | — |
| Shared read through the canonical shared folder | ✓ | — | — |
| Generic files admitted with identity, bytes not in the tool result | ✓ | — | — |
| Private album, captions, PDF, audio, and text lightbox | ✓ | — | — |
| Shared and generic dialog, original no-preview sentence, Download | ✓ | — | — |
| Failed, cancelled, short, or stale read is not Saved | ✓ | — | — |
| Relative card JSON kept by the existing history parser | ✓ | — | — |
| POST route mounted in `app/api` | — | ✓ | — |
| Filesystem read and native save panel | — | ✓ | — |
| Catalog sentence and the disagreeing tests above | — | ✓ | — |
| Infer shared scope from a path or URL | — | — | ✓ |
| Execute, unpack, or parse Office bytes | — | — | ✓ |
| Inline preview for shared SVG, AVIF, ICO, BMP, or PDF | — | — | ✓ |
| Checks, packaging, or Mac acceptance | — | — | ✓ |
