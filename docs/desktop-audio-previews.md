# Desktop file audio previews (lane handoff)

Branch `desktop/file-audio-previews`. Source only. The integration owner runs tests, typecheck, lint, build, packaging, and Mac QA, including playback from the board and after restart. This handoff does not claim those results.

The bundled Next docs directory was not present, so the route follows the existing desktop file routes: `dynamic = 'force-dynamic'` and `params` as a Promise. No dependencies were installed.

## Upstream

Reused from `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, without hosted file URLs or Supabase:

- `apps/ui/components/files/FilePreview.tsx`: the audio frame `flex h-full items-center justify-center p-4` and `<audio controls className="w-full max-w-md">`. No autoplay. Loading skeleton widths are the same as that file.
- `apps/ui/components/files/FileDetail.tsx`: `PanelEditorHeader` with the file name and Back, and the error line `p-3 text-xs text-destructive`.
- `apps/ui/lib/files/content-type.ts`: `audio/wav` and `audio/mpeg`. Responses use `nosniff`.

`apps/ui/lib/files/preview.ts` was not used for the allowlist. Its audio set also includes OGG, M4A, and FLAC. This route allows only WAV and MP3.

`AgentPanelFiles` hosted `rawUrl` is not used. `FileDetailActions` download, publish, and delete were not copied. The Mac list still does not add Download, Move, or New folder. Delete and Rename stay on the list.

## Changed files

- `apps/ui/lib/desktop/server/audio-bytes.ts` — structural WAV and MP3 checks.
- `apps/ui/lib/desktop/server/audio-bytes.test.ts` — authored, not run.
- `apps/ui/lib/desktop/server/coworker-files.ts` — `readCoworkerAudio`, using the same private confinement helpers as `readCoworkerImage`. Text read, image read, import, and attachment are unchanged. `image-bytes.ts` was not edited.
- `apps/ui/app/api/desktop/agents/[agentId]/files/audio/route.ts` — authenticated GET.
- `apps/ui/app/api/desktop/agents/[agentId]/files/audio/route.test.ts` — authored, not run.
- `apps/ui/components/desktop/DesktopFileAudioPreview.tsx` — desktop adapter.
- `apps/ui/components/desktop/DesktopCoworkerFiles.tsx` — opens the adapter for a WAV or MP3 name.
- `apps/ui/components/desktop/DesktopCoworkerFiles.audio.test.tsx` — authored, not run.
- `docs/desktop-runtime-contract.md` — Audio preview paragraph.
- `docs/desktop-audio-previews.md` — this note.

Not changed: `image-bytes.ts`, `DesktopApp.tsx`, `DesktopBoard.tsx`, `DesktopConversation.tsx`, `database.ts`, `store.ts`, the parity checklist, chat cards, workspace icons, and shell packaging.

## Integration contract

`DesktopCoworkerFiles` still takes `{ agent: DesktopAgentView }`. No parent prop or callback was added. `DesktopApp` does not need a change. The panel remounts when `agent.id` changes, which stops playback.

`DesktopFileAudioPreview` props:

- `name: string`
- `path: string` — workspace-relative path
- `identity?: string` — `dev:ino` from the list, when the list has it
- `srcUrl: string` — same-origin `GET /api/desktop/agents/:agentId/files/audio?path=&identity=`
- `onBack: () => void`

The adapter refuses a `srcUrl` that is not that route. It fetches with the desktop session cookie, checks the content type, and gives the bytes to `<audio controls>` as a blob URL. It does not accept a hosted URL or a `file:` URL. There is no `autoPlay`.

Blob URL, not a range response: the cap is 16 MB, a JSON error has to be visible before any player starts, and native controls can seek inside the blob. The route always returns the whole body with `200`. A `Range` header does not produce `206` or `Content-Range`.

Back, opening another file, switching coworker, closing Files, and unmount all pause the element, drop its src, and revoke the blob URL.

Chat file cards must not call `/files/audio`.

The preview replaces the list, as the text and image previews already do. Rename and Delete are available again after Back. Edit stays on UTF-8 `.txt` and `.md` only.

## Disposable fixtures

Do not write these into `~/Library/Application Support/Rerun Desktop Preview` or into a coworker that already has real files.

The route test creates its own temp data root. For a manual file, use a new disposable coworker and copy only into that coworker’s workspace: `workspaces/1/engine/agents/<engineAgentId>/workspace/`. The route test’s `wav()` helper writes a 46-byte mono 8-bit PCM WAV (`tone.wav`). `mp3Frame()` writes a 417-byte MPEG-1 Layer III header at 128 kbps, 44.1 kHz, mono (`tone.mp3`). A wrong-owner check needs a copy `chown`ed to another uid; the automated test does not do that.

## Behavior

The reader uses the existing workspace root, `containedPath` syntax checks, `openResolved`, and the pinned parent (`/.vol/dev/ino` or `/proc/self/fd`). Runtime `join` and `realpath` calls keep the existing `turbopackIgnore` annotations. It `lstat`s every path component and refuses a symlink, including one that stays inside the workspace. The file must be a regular file, `nlink` 1, and owned by the current user, as must its parent directories. When the list identity is sent, a different inode returns 409 and no audio bytes.

Magic and structure must match the extension. Outcomes:

- missing file: 404 `“name” was not found.`
- not a WAV or MP3 name: 415 `Only WAV and MP3 files can be previewed.`
- wrong magic: 415 `This file is not a supported audio file.`
- WAV that is not PCM or float, or an MP3 that is not Layer III: 415 `This audio format can’t be previewed.`
- damaged structure: 415 `This audio is damaged and can’t be previewed.`
- over 16 MB: 413 `Audio files can be up to 16 MB.`
- symlink: 400 `Choose an audio file, not a symlink.`
- extra hard link: 400 `This audio has another link. It was left unopened.`
- another uid: 403 `This file belongs to another user. It was left unopened.`
- playback failure after a valid response: `This audio can’t be played.`
- fetch failure: `Could not read this audio.`

A direct navigation to the route still gets an audio content type, `nosniff`, and a sandbox policy, not HTML.

## Limits

- WAV accepts PCM (8, 16, 24, or 32-bit) and IEEE float (32 or 64-bit), including WAVE_FORMAT_EXTENSIBLE when the subformat is one of those. One to eight channels. Sample rate 8000 through 192000 Hz. Block align and byte rate must match the header. The RIFF size must equal the file length minus 8. Sample values are not decoded.
- MP3 accepts MPEG-1, MPEG-2, and MPEG-2.5 Layer III, with an optional ID3v2 tag at the start (including a v2.4 footer) and ID3v1 at the end. Free bitrate and Layer I/II are refused. Frame payloads are not decoded. A file that passes structure and then fails in the browser shows the playback sentence.
- OGG, M4A, FLAC, AAC, video, and PDF are out of this slice. An SVG or HTML file is not sent to this route. If it is UTF-8, the existing text preview can still show its source in `<pre>`.
- There is no recording, model audio input, audio import, public link, or external-player launch.
- List rows are not audio waveforms. Chat attachments do not use this route.
- A backslash in a name is refused, matching rename and delete.
- Paths deeper than 64 components are refused.
- The final read is checked against the same inode, but it is not an atomic inode-conditional read.
- Tests and Mac acceptance were not run in this lane.
