# Desktop shared workspace text files

D handoff `565edb3fd11635ce11320145aa683507f1a36f3a` is integrated into the coding tree with the corrections below. The integration helper authored regression cases but ran no tests, typecheck, lint, build, packaging, app, model or network calls. Root owns all execution and Mac/restart acceptance. Source implementation is not checklist acceptance.

## Original Rerun provenance

Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- `apps/engine/src/tools/builtin/shared.ts` wraps `makeFsTools` with prefix `shared` and `sharedDir()` as its root. The desktop adapter preserves shared read/list names and shared-folder semantics; it does not register the hosted write/edit/search family.
- `apps/engine/src/tools/builtin/fsTools.ts` establishes the 100,000-character read page size.
- `apps/ui/components/brain/BrainFiles.tsx` supplies the presentation reused here: `BrainTopBar`, `FileList`, and `FilePreview`. `useSiblingFiles` keeps alphabetical text-file navigation. Hosted `FileDetail` is not mounted because it offers unsupported mutations.
- `apps/ui/components/brain/useSharedFilesTree.ts` and `apps/ui/app/api/_actions/workspace-file.actions.ts` show hosted folder navigation and the `/shared/files` route. Desktop uses authenticated local routes instead; the hosted route remains denied.

## Scope and permissions

Workspace Shared files supports folder browsing, `.txt`/`.md` preview, and human create-only imports. Two permitted coworkers read the same files with `shared_read` and `shared_list`. This does not provide shared write, edit, search, rename, delete, media preview, download, or publication tools.

The independent grant is `tools.desktopToolGrants.sharedFilesRead === true`. It defaults off, requires an enabled coworker and `tools.shared !== false`, and is separate from private workspace reads and shared-database access. Contracts, the desktop catalog, prompt instructions, and desktop-only registry are wired. Importing a file does not enable a model grant. The adapter checks current configuration and deletion lifecycle before work and before returning, combines tool/run cancellation, and bounds execution to 30 seconds. No host path enters the prompt.

## Storage and publication

Both UI and engine resolve `<dataRoot>/workspaces/1/engine/shared`. HTTP and tool inputs can supply only relative paths; `root`, `engineId` and `scope` fields never select storage. Private Files retain their existing per-coworker implementation. Import can create `shared` and missing relative child folders, but cannot create the trusted engine directory.

Directories and files must belong to the current user. Symlinks, hidden path components, traversal, and multiply linked files are refused. Darwin uses canonical paths plus `O_NOFOLLOW_ANY` and pinned `/.vol/<dev>/<ino>` directories; Linux walks components with `O_NOFOLLOW` and pins directory descriptors. Reads validate named identity, single-link status, size, and change stamps before returning bytes. Fatal streaming UTF-8 decoding tolerates an incomplete final code point at the bounded read window without accepting malformed bytes.

Imports accept one text/Markdown file up to 1 MiB, no NUL bytes, and valid UTF-8. The HTTP route bounds the entire multipart stream to 1 MiB plus a 64 KiB envelope before parsing, including requests without Content-Length. Duplicate file/folder fields are refused. Browser, request, native publication and tool operations are bounded and cancellable.

Publication reuses the existing bundled identity-bound `RERUN_DESKTOP_RENAME_HELPER` and root directory lease. A hidden staging file is fsynced and atomically renamed without replacing an arrival. The helper validates exact source and parent identity before and after the native move. A crash cannot leave two hardlinks to the published document. Import's directory checks permit its own entry changes while preserving inode, owner and no-follow validation; this fixes the original ctime rejection after a successful import.

Pre-publication cleanup removes only this attempt's exact staging inode. Once native publication is attempted, uncertain source/final/recovery names are preserved. A lost acknowledgement may leave a complete readable file; refresh before retrying, and a duplicate name never overwrites it. There is no automatic orphan recovery. A folder with 128 unfinished staging names refuses additional imports for review rather than accumulating more. Shared Files errors do not expose Skills wording from the reused helper.

## UI and root integration

`DesktopSharedFiles({ dialogControl?, hideTrigger?, onCloseAutoFocus? })` is the shared-files dialog. Root mounts it and owns workspace-menu/Control Center wiring plus board, hotkey, notification visibility and Quit gates.

Shared files retains the original folder title, list, breadcrumbs, text preview and previous/next header. The shared `FileList` now accepts optional action callbacks and optional empty copy/upload-disable flags; existing hosted consumers keep their current behavior. The Mac view omits unavailable Rename, Delete and Download actions and describes only import/read capabilities. Listing and preview failures remain visible with Retry instead of claiming an empty folder.

Imports run sequentially, at most 100 files per selection, into the selected folder plus relative drop subdirectories. An in-flight request holds desktop draft admission. Closing, navigating, unmounting or quitting aborts that attempt and stops subsequent queued files. Completion updates only the still-visible folder. Native publication can already have succeeded when cancellation arrives; reopening/refreshing reconciles that result.

List returns at most 512 entries after visiting at most 1024 names and exposes truncation. Preview returns the first 100,000 characters; model reads can request subsequent character offsets with an 8 MiB byte-window ceiling. A missing root lists empty; a missing child is an error. Hidden entries, symlinks, other owners and multiply linked files are omitted.

## Authored regression coverage, not executed by the integration helper

- `apps/engine/src/desktop/shared-workspace-files.test.ts`: root/nested import acknowledgement, native single-link publication, no-clobber collision, lost response/reload, moved parent refusal, private isolation, symlink/hardlink refusal, changed reads, UTF-8 window boundaries.
- `apps/engine/src/desktop/shared-file-grant.test.ts`: explicit/default-off grant, schema round trip, independent private/database permissions, read-only prompt/catalog.
- `apps/engine/src/desktop/shared-file-tools.test.ts`: two coworkers reading one import, current grant revocation, run/tool cancellation.
- `apps/ui/app/api/desktop/shared-files/route.test.ts`: authenticated confined import/list/read, no-clobber, oversized multipart stream, aborted stream, duplicate fields, private isolation.
- `apps/ui/lib/desktop/shared-workspace-files.test.ts`: relative client requests, early size/type refusal, merged caller cancellation.
- `apps/ui/components/desktop/DesktopSharedFiles.test.tsx`: original list/preview, omitted unsupported actions, folder imports, close/navigation/Quit queue cancellation and released admission, visible errors and retry, truthful empty state.

Filesystem/import suites prepare the existing native helper fixture only when root runs those tests. Wrong-UID and Linux behavior and process-kill crash boundaries remain unverified. Root verified packaged helper availability through actual native import, live Codex shared_list/shared_read calls by two coworkers, distinct private contents/chats and successful fresh reads after full Mac restart in `adfb47d`. This accepts D6’s recorded shared-read/isolation scope without claiming the unsupported mutations or formats listed above. Keep `/shared/files` denied; add no hosted engine, raw-byte or media route for this slice.
