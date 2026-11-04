# Desktop file video previews (lane handoff)

Branch `desktop/file-video-previews`. Source only. The integration owner runs tests, typecheck, lint, build, packaging, installation, and native Mac QA, including MP4 playback from the board and after restart. This handoff does not claim those results.

The bundled Next docs directory was not present, so the route follows the existing desktop file routes: `dynamic = 'force-dynamic'` and `params` as a Promise. No dependencies were installed.

## Upstream

Reused from `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, without hosted file URLs or Supabase:

- `apps/ui/components/files/FilePreview.tsx`: the video frame `flex h-full items-center justify-center overflow-auto bg-muted p-3` and `<video controls className="max-h-full max-w-full">`. No autoplay. Loading skeleton widths are the same as that file.
- `apps/ui/components/files/FileDetail.tsx`: `PanelEditorHeader` with the file name and Back, and the error line `p-3 text-xs text-destructive`. Sibling arrows and `FileDetailActions` were not copied.
- `apps/ui/lib/files/content-type.ts`: `mp4` is `video/mp4`. Responses also send `nosniff`, a sandbox content-security policy, and `no-store`.
- `apps/ui/lib/files/preview.ts`: the original video set also includes WebM, MOV, and M4V. This route allows only `.mp4`.

`AgentPanelFiles` hosted `rawUrl` is not used. The Mac list still does not add Download, Move, or New folder. Delete and Rename stay on the list.

## Changed files

- `apps/ui/lib/desktop/server/video-bytes.ts` — structural MP4 checks.
- `apps/ui/lib/desktop/server/video-bytes.test.ts` — authored, not run.
- `apps/ui/lib/desktop/server/coworker-files.ts` — `readCoworkerVideo`, using the same private confinement helpers as `readCoworkerAudio`. Text read, image read, audio read, import, and attachment are unchanged.
- `apps/ui/app/api/desktop/agents/[agentId]/files/video/route.ts` — authenticated GET.
- `apps/ui/app/api/desktop/agents/[agentId]/files/video/route.test.ts` — authored, not run.
- `apps/ui/components/desktop/DesktopFileVideoPreview.tsx` — desktop adapter.
- `apps/ui/components/desktop/DesktopCoworkerFiles.tsx` — opens the adapter for an MP4 name. `dialogControl` is unchanged.
- `apps/ui/components/desktop/DesktopCoworkerFiles.video.test.tsx` — authored, not run.
- `docs/desktop-runtime-contract.md` — Video preview paragraph.
- `docs/desktop-video-previews.md` — this note.

Not changed: `image-bytes.ts`, `audio-bytes.ts`, `DesktopApp.tsx`, `DesktopBoard.tsx`, `DesktopConversation.tsx`, database, store, runtime bootstrap, the parity checklist, chat cards, workspace icons, and shell packaging. Other worktrees, including workspace-logo-upload, were not touched.

## Root wiring

`DesktopCoworkerFiles` still takes `{ agent: DesktopAgentView; dialogControl?: DesktopDialogControl }`. No parent prop was added. `DesktopApp` and `DesktopConversation` do not need a change. The existing `dialogControl('files')` hook stays the owner of open state. The panel remounts when `agent.id` changes, which stops playback.

`DesktopFileVideoPreview` props:

- `name: string`
- `path: string` — workspace-relative path
- `identity?: string` — `dev:ino` from the list, when the list has it
- `srcUrl: string` — same-origin `GET /api/desktop/agents/:agentId/files/video?path=&identity=`
- `onBack: () => void`

The adapter refuses a `srcUrl` that is not that route. It fetches with the desktop session cookie, checks `video/mp4`, and gives the bytes to `<video controls>` as a blob URL. It does not accept a hosted URL or a `file:` URL. There is no `autoPlay`.

Blob URL, not a range response: the cap is 16 MB, a JSON error has to be visible before any player starts, and native controls can seek inside the blob. The route always returns the whole body with `200`. A `Range` header does not produce `206` or `Content-Range`.

Back, opening another file, a folder change while the preview is up, switching coworker, closing Files, and unmount all pause the element, drop its src, and revoke the blob URL. A fetch still in flight is aborted.

Chat file cards must not call `/files/video`.

The preview replaces the list, as the text, image, and audio previews already do. Rename and Delete are available again after Back. Edit stays on UTF-8 `.txt` and `.md` only. Import stays `.txt` and `.md`.

## Disposable fixtures

Do not write these into `~/Library/Application Support/Rerun Desktop Preview` or into a coworker that already has real files.

The route test creates its own temp data root. For a manual file, use a new disposable coworker and copy only into that coworker’s workspace: `workspaces/1/engine/agents/<engineAgentId>/workspace/`. `mp4()` in the route test writes a small ISO BMFF file (`clip.mp4`): `ftyp` brand `isom` / `mp42`, a `moov`/`trak`/`mdia`/`hdlr` of type `vide`, and a one-byte `mdat`. That file is a container fixture, not a decoded picture. A wrong-owner check needs a copy `chown`ed to another uid; the automated test does not do that.

Real Electron playback of a normal MP4, from the board and after restart, is the acceptance check. Container inspection does not prove the WebView can decode the codec.

## Behavior

The reader uses the existing workspace root, `containedPath` syntax checks, `openResolved`, and the pinned parent. Runtime `join` and `realpath` calls keep the existing `turbopackIgnore` annotations. It `lstat`s every path component and refuses a symlink, including one that stays inside the workspace. The file must be a regular file, `nlink` 1, and owned by the current user, as must its parent directories. Save and delete recovery run before the open, and a name claimed by an in-progress save is left unread. When the list identity is sent, a different inode returns 409 and no video bytes.

Outcomes:

- missing file: 404 `“name” was not found.`
- not an MP4 name: 415 `Only MP4 files can be previewed.`
- wrong container: 415 `This file is not a supported video file.`
- QuickTime-only, 3GPP, or audio-only MP4: 415 `This video format can’t be previewed.`
- damaged structure: 415 `This video is damaged and can’t be previewed.`
- over 16 MB: 413 `Video files can be up to 16 MB.`
- symlink: 400 `Choose a video file, not a symlink.`
- extra hard link: 400 `This video has another link. It was left unopened.`
- another uid: 403 `This file belongs to another user. It was left unopened.`
- playback failure after a valid response: `This video can’t be played.`
- fetch failure: `Could not read this video.`

A direct navigation to the route still gets `video/mp4`, `nosniff`, and a sandbox policy, not HTML.

## Limits

- Accepted `ftyp` brands are `isom`, `iso2`, `iso4`, `iso5`, `iso6`, `iso8`, `iso9`, `mp41`, `mp42`, `avc1`, `hvc1`, `hev1`, `dash`, `MSNV`, and `M4V `. One of those must be the major brand or a compatible brand. `qt  ` alone, `3gp*`, and `M4A ` are refused.
- The file must parse as boxes through the end, with one top-level `moov`, one top-level `mdat` of at least one byte, and a version-0 `hdlr` whose type is `vide`. At most 4096 boxes and a depth of 16. Sample tables and sample bytes are not decoded.
- A file can pass those checks and still fail in the browser. That shows `This video can’t be played.`
- WebM, MOV, M4V, PDF, recording, conversion, video import, and model video input are out of this slice.
- There is no public link or external-player launch.
- Paths deeper than 64 components are refused.
- The final read is checked against the same inode, but it is not an atomic inode-conditional read.
- Tests, lint, typecheck, build, packaging, and Mac acceptance were not run in this lane.
