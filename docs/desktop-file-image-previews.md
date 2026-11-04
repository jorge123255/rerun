# Desktop file image previews (lane handoff)

Branch `desktop/file-image-previews`. Source only. The integration owner runs tests, typecheck, lint, build, packaging, and Mac QA. This handoff does not claim those results.

## Upstream

Reused from `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, without hosted file URLs or Supabase:

- `apps/ui/components/files/FileDetail.tsx`: `PanelEditorHeader` with the file name, Back, and the error line `p-3 text-xs text-destructive`.
- `apps/ui/components/files/FilePreview.tsx`: loading skeleton widths, and the image frame `flex h-full items-center justify-center overflow-auto bg-muted p-3` with `img` classes `max-h-full max-w-full object-contain`.
- `apps/ui/lib/files/content-type.ts`: PNG, JPEG, GIF, and WebP are the inline raster types. SVG stays out. Responses use `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.

`apps/ui/lib/files/preview.ts` was not used for the allowlist. Its image set also includes SVG, AVIF, ICO, and BMP. The Mac route allows only PNG, JPEG, WebP, and GIF.

`FileDetailActions` download, publish, and delete were not copied. The Mac list still does not add Download, Move, or New folder. Delete and Rename stay on the list.

## Changed files

- `apps/ui/lib/desktop/server/image-bytes.ts` — structural PNG, JPEG, WebP, and GIF checks.
- `apps/ui/lib/desktop/server/coworker-files.ts` — `readCoworkerImage`. Text read, import, and attachment are unchanged.
- `apps/ui/app/api/desktop/agents/[agentId]/files/image/route.ts` — authenticated GET.
- `apps/ui/app/api/desktop/agents/[agentId]/files/image/route.test.ts` — authored, not run.
- `apps/ui/components/desktop/DesktopFileImagePreview.tsx` — desktop adapter.
- `apps/ui/components/desktop/DesktopCoworkerFiles.tsx` — opens the adapter for a raster name.
- `apps/ui/components/desktop/DesktopCoworkerFiles.image.test.tsx` — authored, not run.
- `docs/desktop-runtime-contract.md` — Image preview paragraph.
- `docs/desktop-file-image-previews.md` — this note.

Not changed: `DesktopApp.tsx`, `DesktopBoard.tsx`, `DesktopConversation.tsx`, `database.ts`, `store.ts`, the parity checklist, chat cards, and the text editor.

## Integration contract

`DesktopCoworkerFiles` still takes `{ agent: DesktopAgentView }`. No parent prop or callback was added. `DesktopApp` does not need a change.

`DesktopFileImagePreview` props:

- `name: string`
- `path: string` — workspace-relative path
- `identity?: string` — `dev:ino` from the list, when the list has it
- `srcUrl: string` — same-origin `GET /api/desktop/agents/:agentId/files/image?path=&identity=`
- `onBack: () => void`

The adapter refuses a `srcUrl` that is not that route. It fetches with the desktop session cookie, checks the content type, and gives the bytes to `<img>` as a blob URL. It does not accept a hosted URL or a `file:` URL.

Chat file cards (Agent B) must not call `/files/image`.

The preview replaces the list, as the text preview already does. Rename and Delete are available again after Back. Edit stays on UTF-8 `.txt` and `.md` only.

## Disposable fixtures

Do not write these into `~/Library/Application Support/Rerun Desktop Preview` or into a coworker that already has real files.

The route test creates its own temp data root. For a manual file, use a new disposable coworker and copy only into that coworker’s workspace: `workspaces/1/engine/agents/<engineAgentId>/workspace/`. One PNG body:

```
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
```

Decode that base64 into `shot.png` in the disposable workspace, then open it from Files. GIF, JPEG, and WebP fixtures are the constants in `files/image/route.test.ts`. A wrong-owner check needs a copy `chown`ed to another uid; the automated test does not do that.

## Behavior

The reader uses the existing workspace root, `containedPath` syntax checks, `openResolved`, and the pinned parent (`/.vol/dev/ino` or `/proc/self/fd`). It `lstat`s every path component and refuses a symlink, including one that stays inside the workspace. The file must be a regular file, `nlink` 1, and owned by the current user, as must its parent directories. When the list identity is sent, a different inode returns 409 and no image bytes. The parent inode is checked again after the read.

Magic and structure must match the extension. Outcomes:

- missing file: 404 `“name” was not found.`
- not a PNG, JPEG, WebP, or GIF name: 415 `Only PNG, JPEG, WebP, and GIF files can be previewed.`
- wrong magic: 415 `This file is not a supported image.`
- damaged structure: 415 `This image is damaged and can’t be previewed.`
- over 8 MB: 413 `Images can be up to 8 MB.`
- edge over 8192, or more than 16,777,216 pixels: 413 `This image is too large to preview.`
- symlink: 400 `Choose an image file, not a symlink.`
- extra hard link: 400 `This image has another link. It was left unopened.`
- another uid: 403 `This file belongs to another user. It was left unopened.`

A direct navigation to the route still gets an image content type, `nosniff`, and a sandbox policy, not HTML or SVG.

## Limits

- PNG chunks and CRCs are checked. JPEG markers, GIF blocks, and WebP chunks are checked. Pixel payloads are not fully decoded; a file that passes structure and then fails in the browser shows the damaged message.
- JPEG is 8-bit with 1 or 3 components (baseline, extended, or progressive). GIF87a and GIF89a are accepted, including animation whose blocks fit. WebP is VP8, VP8L, or VP8X with a following image chunk.
- An SVG or HTML file is not sent to this route. If it is UTF-8, the existing text preview can still show its source in `<pre>`. That path was left unchanged. Scripts do not run there.
- List rows are not image thumbnails. Image import, model vision, chat attachments, shared files, PDF, and media playback are out of this slice.
- A backslash in a name is refused, matching rename and delete.
- Paths deeper than 64 components are refused.
- There is no byte-range response.
- The final read is checked against the same inode, but it is not an atomic inode-conditional read.
- Tests and Mac acceptance were not run in this lane.
