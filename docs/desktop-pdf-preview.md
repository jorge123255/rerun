# Desktop file PDF previews (lane handoff)

Reviewed lane `desktop/file-pdf-preview`, commits `6d2e177a9c6e4377935bf87479822873683c10c7` and `fe69cc12ddca10d4f341f0f27d3be4d772efc6c6`, integrated into the coding `desktop/m1` worktree with the shared recovery binding below. Source only: root runs all checks and native Mac acceptance, including whether the packaged viewer can display the iframe. This handoff does not claim those results.

The author worktree had no `node_modules`; its route follows the installed Next route-handler guide read from `codex-login-build`. Integration also read `apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` and `01-directives/use-client.md` in the coding worktree: `GET(request, { params })` awaits the promised params, and the interactive preview starts with `'use client'`. No dependencies were installed by the lane or integration helper.

## Upstream

Reused from `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, without hosted file URLs, PDF.js, or Supabase:

- `apps/ui/components/files/FilePreview.tsx`: a PDF is `<iframe src={rawUrl} title={fileName} className="h-full w-full bg-white" />`. There is no PDF.js renderer. Loading skeleton widths are the same as that file.
- `apps/ui/components/files/FileDetail.tsx`: the desktop header is the existing `PanelEditorHeader` (file name, Back). Sibling arrows stay the ones already wired in `DesktopCoworkerFiles`.
- `apps/ui/components/files/useSiblingFiles.ts` and `AgentPanelFiles.tsx`: previous/next, one-file folders, and keyboard guards were already on this base. This lane only adds PDF as another preview kind. It does not sort files again.
- `apps/ui/lib/files/preview.ts`: extension `pdf` is the PDF kind. The desktop name check is the same extension, case-insensitive.
- `apps/ui/lib/files/content-type.ts`: `pdf` is `application/pdf`. That map was not edited. The desktop route sets `application/pdf` itself.

The Mac difference from `rawUrl`: the preview fetches `GET /api/desktop/agents/:agentId/files/pdf`, and the iframe `src` is a `blob:` URL of those bytes. That matches the image, audio, and video previews, so a JSON error is visible before the frame and an in-flight read can be aborted. It is not a `file:` URL and not a hosted URL. The blob document does not inherit the route's `Content-Security-Policy` header. The iframe itself is the document boundary: `sandbox=""` and `csp="default-src 'none'; sandbox"`. The `csp` attribute is set before `src`, so that blob navigation is covered.

`readCoworkerVideo` is the confinement pattern. The PDF reader copies the open path into `pdf-read.ts`, but does not copy journal recovery or the claim set. Both are mandatory through `bindCoworkerPdfFolder`. Coding integration binds the real closures in `coworker-files.ts`; an incorrectly imported, unbound reader still fails closed with 503.

## Changed files

- `apps/ui/lib/desktop/server/pdf-bytes.ts` — header and EOF marker checks. No page parser.
- `apps/ui/lib/desktop/server/pdf-bytes.test.ts` — authored, not run.
- `apps/ui/lib/desktop/server/pdf-read.ts` — `readCoworkerPdf`. Does not change text, image, audio, or video readers.
- `apps/ui/lib/desktop/server/coworker-files.ts` — coding integration binds the existing recovery and claim closures, then re-exports the PDF reader/type.
- `apps/ui/app/api/desktop/agents/[agentId]/files/pdf/route.ts` — authenticated GET. The directory name is `agentId`, same as `files/video`.
- `apps/ui/app/api/desktop/agents/[agentId]/files/pdf/route.test.ts` — authored, not run.
- `apps/ui/components/desktop/DesktopFilePdfPreview.tsx` — iframe adapter.
- `apps/ui/components/desktop/DesktopCoworkerFiles.tsx` — PDF state, dispatch, folder-away, identity adopt, delete clear, and the early return after video. Text, image, audio, and video branches only gain `setPdf(null)`.
- `apps/ui/components/desktop/DesktopCoworkerFiles.pdf.test.tsx` — authored, not run.
- `docs/desktop-pdf-preview.md` — this note.

Not changed by this slice: `image-bytes.ts`, `audio-bytes.ts`, `video-bytes.ts`, `content-type.ts`, `DesktopApp.tsx`, `DesktopBoard.tsx`, `DesktopControlCenter`, `DesktopConversation.tsx`, database, store, runtime bootstrap, shortcut catalog, chat cards, tool registry, shell packaging, and Electron settings. The author worktree remains untouched by integration; unrelated coding changes remain preserved.

## Integrated shared boundary

The author lane left `coworker-files.ts` untouched; coding integration adds only the import, shared closure binding and re-export. `pdf-read.ts` does not import it, so there is no circular dependency. Chat file cards must not call `/files/pdf`. There is no PDF result card in this slice.

The PDF route imports `readCoworkerPdf` through `coworker-files.ts`, which installs the real binding before GET runs. Routine route regressions now use that production binding. Two narrow probe cases temporarily replace it to inspect ordering and claimed-name refusal, then restore it.

The following binding is now present in `apps/ui/lib/desktop/server/coworker-files.ts` after `const claimed`; the recovery function declaration is hoisted and called only by later reads. There is no second `activeNames` set or journal implementation.

```ts
import { bindCoworkerPdfFolder, readCoworkerPdf, type CoworkerPdfPreview } from './pdf-read'

bindCoworkerPdfFolder({
    recoverInterruptedEdits: (directory, workspaceRoot) => recoverInterruptedCoworkerEdits(directory, workspaceRoot),
    claimed,
})

export { readCoworkerPdf, type CoworkerPdfPreview }
```

The route now imports:

```ts
import { readCoworkerPdf } from '@/lib/desktop/server/coworker-files'
```

Loading that route then evaluates `coworker-files.ts`, which binds the real closures before `GET` runs. The read order, already implemented in `readPdf`, matches `readVideo`: assert parent directories, `recoverInterruptedEdits(parentPath, workspaceRoot)`, assert those directories again, then reject `claimed(parentPath, name)` before the open. A direct PDF read heals an interrupted rename or publish itself. It does not wait for a separate Files listing.

The open helpers still copied in `pdf-read.ts` are `coworkerWorkspace`, `containedPath`, `openResolved`, `pinnedDirectory`, `lexicalRelative`, `currentUid`, `fileStat`, `sameFile`, and the directory walk. The roster queue is `withRosterWrite` plus `assertCoworkerNotDeleting`, the same queue `withCoworkerFiles` uses. A later move of `readPdf` next to `readVideo` can delete those copies. It is not required for the shared claim and recovery state. Do not make `pdf-read.ts` import `coworker-files.ts`.

The former unbound-route 503 case was replaced with a real interrupted-publication fixture. With no probe and no previous Files listing, the PDF GET must retire a committed publication's extra temp hard link and journal before opening, preserve the original inode and bytes, and remain readable on a second GET. The separate recovery-order and claimed-name probe cases remain. These regressions are authored; root executes them.

`DesktopCoworkerFiles` still takes `{ agent: DesktopAgentView; dialogControl?: DesktopDialogControl }`. No parent prop was added. `FilesPanel` stays `key={agent.id}`. Previous/Next, the index, alphabetical order, hidden-file listing, the one-file case, keyboard guards, and Back are unchanged. One file still has no arrows. Arrow keys still do not steal seek from `audio` or `video`.

`DesktopFilePdfPreview` props:

- `name: string`
- `path: string` — workspace-relative path
- `identity?: string` — `dev:ino` from the list, when the list has it
- `srcUrl: string` — same-origin `GET /api/desktop/agents/:agentId/files/pdf?path=&identity=`
- `onBack: () => void`
- `siblings` and `viewerRef` — the same objects the video preview receives

The adapter refuses a `srcUrl` that is not that route. It fetches with the desktop session cookie, checks `application/pdf` and the 16 MB cap, and sets the iframe `src` to a blob URL only after `csp` is set. The iframe has `sandbox=""` and `csp="default-src 'none'; sandbox"` (`DESKTOP_PDF_FRAME_CSP`). The empty sandbox grants no scripts, same-origin access, popups, top navigation, downloads, or forms. Cleanup aborts the fetch, clears the iframe `src`, and revokes the blob on Back, another file, a folder change, an owner change, and unmount. The sandbox and `csp` attributes stay on the element until it unmounts. An iframe `load` event does not mark the preview as displayed.

No proxy allowlist entry was found for `/files/video`. This route is the sibling file `files/pdf/route.ts`. No global route-policy edit was made.

Paste this paragraph into `docs/desktop-runtime-contract.md` after the video preview paragraph. This lane did not edit that file. The video, audio, and image paragraphs stay true: those routes still do not serve PDF.

**PDF preview** in Files shows an existing PDF in the selected coworker’s own workspace. The frame reuses the original file-detail header, Back control, loading skeleton, error line, and an `<iframe title class="h-full w-full bg-white" sandbox="">`. The iframe also sets `csp="default-src 'none'; sandbox"` before the blob `src`. That is the embedded document policy. Bytes come from `GET /api/desktop/agents/:agentId/files/pdf?path=&identity=`, authenticated like the other desktop file routes. The response is the whole file, at most 16 MB, with `application/pdf`, `nosniff`, the same sandbox content-security policy as a response header, and `no-store`. The response header applies when something navigates to the route. It is not inherited by the blob URL in the iframe. The iframe src is that blob, not the original raw file URL, not a hosted URL, not a `file:` URL, and not a byte range. A fetch still in flight is aborted and the blob is released on Back, when another file or coworker is opened, when the folder changes, and when Files closes. A fetch success and an iframe load event do not prove the viewer displayed the file. The reader checks a `%PDF-` header at byte 0, version 1.0–1.7 or 2.0, and a later `%%EOF`. It does not parse pages. Before opening, it recovers the parent folder and refuses a name this process has claimed, using the same closures as the video reader through the integrated binding. Chat file cards must not call this route. Text read, text import, image preview, audio preview, video preview, and send-time attachment reads are unchanged. Edit remains the text preview. Rename and Delete remain on the list. `DesktopCoworkerFiles` keeps `{ agent, dialogControl? }`. Limits and the disposable-fixture setup are in `docs/desktop-pdf-preview.md`.

## Native viewer

Do not add PDF.js, change a package lock, change an Electron setting, or relax the app shell or a browser permission. The Electron process sandbox, context isolation, and disabled Node integration are not this document policy.

Two separate policies exist:

- Response header, on `GET /files/pdf` only: `content-security-policy: default-src 'none'; sandbox`, plus `nosniff`, `same-origin`, and `no-store`. This applies to a navigation to that URL.
- Embedded document, on the Files iframe: `sandbox=""` and `csp="default-src 'none'; sandbox"`. The blob URL does not carry the response header. `csp` is set before the blob `src`. The empty sandbox allows no `allow-scripts`, `allow-same-origin`, `allow-popups`, `allow-top-navigation`, `allow-downloads`, or `allow-forms`.

This lane does not claim the packaged viewer can display a PDF inside that iframe. A 200 response and an iframe `load` event are not display. The iframe `error` event is the only client signal that display failed, and some viewers fail without firing it.

Root’s acceptance check is whether the packaged Mac runtime can show the blob iframe under that exact boundary, from the board and after restart. If the built-in viewer needs any sandbox token, or needs the iframe `csp` attribute removed, that capability stays off. Record the failure and decide. Do not drop the response sandbox, set `webSecurity` off, or swap in another renderer from this result.

## Disposable fixtures

Do not write these into `~/Library/Application Support/Rerun Desktop Preview` or into a coworker that already has real files.

The route test creates its own temp data root. For a manual file, use a new disposable coworker and copy only into that coworker’s workspace: `workspaces/1/engine/agents/<engineAgentId>/workspace/`. `pdf()` in the route test writes a small `%PDF-1.4` body ending in `%%EOF` (`deck.pdf`). That file is a marker fixture, not a laid-out page. A wrong-owner check needs a copy `chown`ed to another uid; the automated test does not do that.

## Behavior

The reader checks a lexical relative path, walks every directory with `lstat`, and refuses a symlink, including one that stays inside the workspace. The file must be a regular file, `nlink` 1, and owned by the current user, as must its parent directories. The opened size must be from 1 byte through 16 MB before a buffer is allocated. The read loop fills only that buffer. After the read, the handle and the pinned name must still be the same inode and the same size. When the list identity is sent, a different inode returns 409 and no PDF bytes.

Outcomes:

- missing file: 404 `“name” was not found.`
- not a PDF name: 415 `Only PDF files can be previewed.`
- bytes that do not start with `%PDF-`: 415 `This file is not a supported PDF.`
- version other than 1.0–1.7 or 2.0: 415 `This PDF format can’t be previewed.`
- header without `%%EOF`, or an empty file: 415 `This PDF is damaged and can’t be previewed.`
- over 16 MB: 413 `PDF files can be up to 16 MB.`
- symlink: 400 `Choose a PDF file, not a symlink.`
- extra hard link: 400 `This PDF has another link. It was left unopened.`
- another uid: 403 `This file belongs to another user. It was left unopened.`
- folder recovery not bound: 503 `PDF preview cannot read a file until folder recovery is connected.` The file is not opened.
- name claimed in this process: 409 `This file is being saved. Try the preview again once that finishes.`
- no `getuid`: 400 `PDF preview is only available on this Mac.`
- display failure after a valid response, when the iframe fires `error`: `This PDF can’t be displayed.`
- fetch failure: `Could not read this PDF.`

A direct navigation to the route still gets `application/pdf`, `nosniff`, and a sandbox policy, not HTML. A `Range` header does not produce `206` or `Content-Range`. Import of a `.pdf` stays 415. Text import of `.txt` / `.md` is unchanged.

## Limits

- The header must be the first bytes. A byte-order mark or any prefix before `%PDF-` is refused as not a PDF. Version is the two characters at `%PDF-1.4`: major `1` with minor `0`–`7`, or major `2` with minor `0`.
- `%%EOF` must occur at or after byte 8. Pages, the cross-reference table, streams, and encryption are not parsed. An encrypted or truncated-but-marked file can pass and still fail in the viewer.
- Embedded PDF JavaScript is not stripped from the bytes. The iframe’s empty sandbox and `default-src 'none'` are what withhold script, same-origin, popup, navigation, download, and form capability. The response CSP does not do that for the blob document.
- The open helpers in `pdf-read.ts` are still a copy and can drift until root moves the reader. Journal recovery and `claimed` are not copied.
- The integrated route binds shared recovery and claims before reading. A claimed name returns 409 `This file is being saved. Try the preview again once that finishes.` The standalone unbound reader still returns 503.
- The direct-read recovery regression uses the real shared recovery implementation. The two temporary probe cases cover ordering and claim refusal only; they do not establish native acceptance.
- The final read is checked against the same inode, but it is not an atomic inode-conditional read.
- Paths deeper than 64 components are refused.
- There is no public link, download button, PDF import, model input, or chat card.
- Tests, lint, typecheck, build, packaging, and Mac acceptance were not run in this lane.
