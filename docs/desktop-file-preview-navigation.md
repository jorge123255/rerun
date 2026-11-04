# Desktop file preview navigation (lane handoff)

Branch `desktop/file-preview-navigation`. Source only. The integration owner runs tests, typecheck, lint, build, packaging, installation, and native Mac QA. This handoff does not claim those results.

No route was added. `apps/ui/AGENTS.md` points at `node_modules/next/dist/docs/`, which this worktree does not have. The client-entry note was read from `codex-login-build/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`: `'use client'` stays on the existing Files client entry, and the new helper is imported from that client tree. That worktree was not modified. No dependencies were installed.

## Upstream

Reused from `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, without editing those files:

- `apps/ui/components/files/useSiblingFiles.ts`: non-directory names in `sortFileEntries` order (`localeCompare`), no arrows for one file or a name that is no longer listed, wrap with `(index ± 1 + total) % total`, `onOpen(name)` only.
- `apps/ui/components/files/sort-file-entries.ts`: directories first, then name. Directories are then dropped from the sibling list.
- `apps/ui/components/files/FileDetail.tsx`: Previous file / index / Next file controls, and the arrow-key effect (ignore defaultPrevented, meta, ctrl, alt, shift, typing targets, and a menu or dialog that does not contain the viewer).
- `apps/ui/components/agent/AgentPanelFiles.tsx`: siblings come from the current folder listing; Back clears the open file and leaves the folder.

## Changed files

- `apps/ui/components/desktop/DesktopFileSiblingNav.tsx`: the header cluster and the key effect. A focused audio or video control keeps its seek keys.
- `apps/ui/components/desktop/DesktopCoworkerFiles.tsx`: wires `useSiblingFiles` to the open preview, including loading and error. The same folder and hidden-file listing is the sibling set.
- `apps/ui/components/desktop/DesktopFileImagePreview.tsx`, `DesktopFileAudioPreview.tsx`, `DesktopFileVideoPreview.tsx`: header cluster only. Readers, caps, and formats are unchanged. A new path or identity drops the previous blob before paint; the existing effect still aborts, stops playback, and revokes.
- `apps/ui/components/desktop/DesktopCoworkerFiles.navigation.test.tsx`: authored, not run.

Not changed: reader routes, `image-bytes.ts`, `audio-bytes.ts`, `video-bytes.ts`, `FileDetail.tsx`, `useSiblingFiles.ts`, `ShortcutsDialog.tsx`, `DesktopShortcutsDialog.tsx`, `DesktopApp.tsx`, chat cards, imports, and shell packaging.

## Root wiring

`DesktopCoworkerFiles` still takes `{ agent, dialogControl? }`. No parent prop was added. `FilesPanel` still remounts on `agent.id`.

Shortcut help was not edited. `ShortcutsDialog.buildGroups` already says ← Previous file and → Next file. `DesktopShortcutsDialog` still omits that Files group, and `DesktopControlCenter.commands.integration.test.tsx` still expects the Mac shortcuts dialog not to contain those two phrases. The preview now handles the keys locally. Root can add that existing Files group to `DesktopShortcutsDialog` and update the assertion. This lane did not.

## Behavior

Arrows and `←` / `→` move through the current folder's files in `localeCompare` order, wrapping, skipping directories. Hidden names are included only while the listing was loaded with hidden files shown. Back clears the preview and leaves `currentPath`. There is no saved index.

No arrows while editing, saving, resolving a conflict, renaming, or deleting. The key effect also ignores typing targets, modifier keys, a stacked menu or dialog, and a focused audio or video control.

A name that is no longer in the listing gets no arrows and is not replaced with a neighbor. A new listing identity for an open image, audio, or video changes the reader URL so the old blob is revoked. A new listing identity for an open text preview refetches it. The preview does not poll; the listing updates on the existing reload paths. Switching coworker remounts the panel.

## Limits

Tests, typecheck, lint, build, packaging, and Mac QA were not run. One file has no arrows. The position is not persisted. Native seek stays on a focused media control; arrows still move when focus is elsewhere in the preview. Shortcut wording is unchanged until root adds the existing Files rows.
