# Desktop shared workspace text files

Unintegrated lane handoff for branch `desktop/shared-workspace-files`. Root applies the wiring in this document. Checks, typecheck, lint, build, packaging, installation, live model or network calls, and Mac or restart acceptance were not run. Nothing here is accepted. Do not mark a checklist item accepted from this lane.

Shared files belong to the workspace. Two coworkers with the grant read the same imported `.txt` or `.md` document. Private Files stay on the existing per-coworker publisher. This slice is browse, bounded preview, and create-only import, plus `shared_read` and `shared_list`. Shared editing, deletion, media, and publication are out.

## Original Rerun provenance

Original source pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

- `apps/engine/src/tools/builtin/shared.ts` wraps `makeFsTools` with prefix `shared` and root `sharedDir()`. That hosted set includes write, edit, and search. Desktop does not register it.
- `apps/engine/src/tools/builtin/fsTools.ts` is the hosted read, list, write, edit, and search behavior. Hosted `shared_read` slices text to 100,000 characters. This lane keeps that page size and does not port write, edit, or search.
- `apps/ui/components/brain/BrainFiles.tsx` is the hosted folder and file presentation: `BrainTopBar`, `FileList`, and a text preview. Desktop reuses those pieces and does not mount `FileDetail`, because that view always offers Delete.
- `apps/ui/components/brain/useSharedFilesTree.ts` walks the hosted tree through `listWorkspaceFilesAction`.
- `apps/ui/app/api/_actions/workspace-file.actions.ts` calls the hosted engine at `/shared/files` for list, read, write, head, delete, and rename. Desktop does not call that base and does not expose it.

The hosted empty-state sentence inside `FileList` is broader than this slice. `FileList` is left unchanged.

## Mac storage

The trusted root is the engine data shared directory. Tool arguments and HTTP fields cannot choose a root, a host path, an engine id, or a private/shared selector.

`apps/engine/src/cli/commands/desktop-run.ts` requires `realpath(RERUN_DATA_DIR)` to equal `realpath(<dataRoot>/workspaces/1/engine)`. Engine `sharedDir()` is `resolve(dataDir(), 'shared')`. The UI data root is `RERUN_DESKTOP_DATA_DIR`. The UI does not call engine `dataDir()`.

Both sides resolve the same directory:

`<dataRoot>/workspaces/1/engine/shared`

`resolveDesktopSharedDirectory(dataRoot)` and `resolveEngineSharedDirectory(engineDataDir)` return that path. They do not create it and they do not follow a linked engine directory or a linked `shared` directory. Import may create `shared` and missing relative folders under it. Import does not create `workspaces/1/engine`. Private Files remain `<engine>/agents/<id>/workspace` through the untouched `apps/ui/lib/desktop/server/coworker-files.ts`.

On Darwin, `O_NOFOLLOW_ANY` refuses a path that still contains `/var` because `/var` is a symlink to `/private/var`. Callers `realpath` the parent first. `O_NOFOLLOW_ANY` is not combined with `O_NOFOLLOW`. Identity `lstat` and `fstat` use `{ bigint: true }`. A file with `nlink !== 1n` is refused. Directories are allowed to have a higher link count. The owner must be `process.getuid()`. Linux opens by walking from `/` with `O_NOFOLLOW` and pins `/proc/self/fd/<fd>`. That walk is implemented and was not exercised here. A wrong-uid refusal is implemented and was not exercised here.

Pinned directories use `/.vol/<dev>/<ino>` on Darwin. Reads re-check device, inode, link count, size, and `ctimeNs`. A change during the read is `409` `This file changed while it was being read.` Cancellation throws `AbortError` rather than a path error. A coworker that is being deleted is refused by `beginDesktopAgentWork` with `This coworker is being deleted. Try again.`

## Lane source

| Path | Role |
| --- | --- |
| `apps/engine/src/desktop/shared-workspace-files.ts` | Confined list, read, and create-only import. No relative engine imports, so the UI server and the engine can both load it. |
| `apps/engine/src/desktop/shared-file-grant.ts` | Local grant predicate. Unknown `shared` is not defaulted on. |
| `apps/engine/src/desktop/shared-file-tools.ts` | `desktopSharedFileTools(ctx)` returns `shared_read` and `shared_list`, or `{}`. |
| `apps/ui/lib/desktop/server/shared-workspace-files.ts` | Maps confinement errors to `DesktopHttpError`. Root comes only from `runtime.dataRoot`. |
| `apps/ui/app/api/desktop/shared-files/route.ts` | `GET` list, `POST` one file. `dynamic = 'force-dynamic'`, `runtime = 'nodejs'`. |
| `apps/ui/app/api/desktop/shared-files/read/route.ts` | `GET` one bounded text page. No raw, media, or download route. |
| `apps/ui/lib/desktop/shared-workspace-files.ts` | Browser client. Requests are only the three relative URLs above. |
| `apps/ui/components/desktop/DesktopSharedFiles.tsx` | Dialog panel. Not mounted. Root mounts it. |
| `docs/desktop-shared-workspace-files.md` | This handoff. |

Regression sources, not executed:

- `apps/engine/src/desktop/shared-workspace-files.test.ts`
- `apps/engine/src/desktop/shared-file-grant.test.ts`
- `apps/engine/src/desktop/shared-file-tools.test.ts`
- `apps/ui/app/api/desktop/shared-files/route.test.ts`
- `apps/ui/lib/desktop/shared-workspace-files.test.ts`

The tool regression mocks `readAgentConfig`. `agentConfigSchema` strips an unknown `shared` key until the contract enum includes it, so a round trip through `writeAgentConfig` cannot see the grant yet.

Untouched on purpose: `coworker-files.ts`, `workspace-read.ts`, `registry.ts`, `tool-grants.ts`, `systemPrompt.ts`, `policy.ts`, `proxy.ts`, `packages/contracts/src/desktop-tool-grants.ts`, `DesktopApp.tsx`, `DesktopWorkspaceMenu.tsx`, `DesktopControlCenter.tsx`, `apps/ui/lib/desktop/control-center.ts`, and `FileList.tsx`.

## Exported contracts

`apps/engine/src/desktop/shared-workspace-files.ts`

- `SHARED_IMPORT_BYTES` is `1024 * 1024`. `SHARED_LIST_LIMIT` is `512`.
- `SharedWorkspaceFileError` has `status` and `message`. `name` is `SharedWorkspaceFileError`.
- `SharedDirectoryEntry`: `{ name, type: 'file' | 'dir', size, modifiedAt }`.
- `SharedDirectoryListing`: `{ path, entries, truncated }`.
- `SharedTextPage`: `{ path, content, size, truncated, offset, nextOffset }`.
- `SharedImportResult`: `{ path, name }`.
- `SharedFileAccess`: `{ signal?: AbortSignal; beforeCommit?: () => Promise<void> | void }`.
- `desktopEngineSharedDirectory(dataRoot)` joins `workspaces/1/engine/shared`. It does not touch disk.
- `resolveDesktopSharedDirectory(dataRoot, signal?)` and `resolveEngineSharedDirectory(engineDataDir, signal?)`.
- `listSharedDirectory(root, path, access?)`, `readSharedText(root, path, offset?, access?)`, `importSharedText(root, folder, name, bytes, access?)`.

`apps/engine/src/desktop/shared-file-grant.ts`

- `desktopSharedFilesAllowed(config)` is true only when the coworker is enabled, `tools.shared !== false`, and `tools.desktopToolGrants.shared === true`. A missing grant is false. The hosted default of `tools.shared` is not the Mac grant.

`apps/engine/src/desktop/shared-file-tools.ts`

- `desktopSharedFileTools(ctx: RunContext): ToolSet`.

`apps/ui/lib/desktop/server/shared-workspace-files.ts`

- `listDesktopSharedFiles`, `readDesktopSharedFile`, `importDesktopSharedFile`, and re-exported `SHARED_IMPORT_BYTES`.

`apps/ui/components/desktop/DesktopSharedFiles.tsx`

- `DesktopSharedFiles({ dialogControl?, hideTrigger?, onCloseAutoFocus? })`.

Browser client: `listDesktopSharedFolder`, `readDesktopSharedPreview`, `importDesktopSharedFile`. Listing entries use `modified`, mapped from `modifiedAt`.

Human import does not require the model grant. Model tools do. There is no coworker id on `/api/desktop/shared-files`.

Text is one `TEXT_FILE_PAGE_CHARS` page (`100_000` from `@rerun/contracts`). The byte window is `(offset + 100_000) * 4`, capped at 8 MiB. The read stops at the actual file size when that is smaller. NUL and invalid UTF-8 are refused. A partial window may drop the last 3 bytes once so a split code point does not fail a longer file. Truncation follows the bytes that were read, not a guess that the whole file was decoded.

Import accepts one `.txt` or `.md` name, at most 1 MB, with no NUL and fatal UTF-8. The bytes are written to a hidden `.rerun-shared-import-<hex>` file and published with `link(2)`. `EEXIST` keeps the existing file: `This folder already has a file named “<name>”. The existing file was kept; rename yours and import it again.` A wrong extension is `415` `Only .txt and .md files can be imported.`

List skips dot names, symlinks, other users’ entries, and files whose `nlink` is not 1. It returns at most 512 entries and stops after 1024 names. `truncated` is true when either cap hits. An absent `shared` directory lists as empty only at the root. A missing child folder is `404` `Folder not found`. A failed list in the panel stays an error line. It does not pass `[]` into `FileList`, because that component’s empty copy is `Nothing here yet`.

## Root wiring

Do not spread hosted `sharedTools(ctx)` inside the desktop branch. `apps/engine/src/tools/registry.ts` already returns before that hosted assignment. Add the adapter inside the existing `if (desktopApp())` tool object only:

```ts
import { desktopSharedFileTools } from '../desktop/shared-file-tools.js'
```

```ts
const tools: ToolSet = {
    ...desktopWorkspaceReadTools(ctx),
    // existing desktop adapters stay in this object
    ...desktopSkillTools(ctx),
    ...desktopSharedFileTools(ctx),
}
```

`packages/contracts/src/desktop-tool-grants.ts`: add `'shared'` to `desktopRerunGrantIds`. Replace the pending catalog row. Do not include `shared_write`. Do not default the grant to true.

```ts
supported('shared', 'Shared files', 'Read and list .txt and .md files in the workspace shared folder.', 'shared_read', 'shared_list'),
```

Until that id exists, `readAgentConfig` strips `desktopToolGrants.shared`, and `desktopSharedFileTools` returns `{}`. The adapter must not call `requireDesktopToolGrant(ctx, 'shared')` before the id is in the enum. It checks the loose predicate instead.

`apps/engine/src/desktop/tool-grants.ts`, after the grant record is false, same shape as Skills:

```ts
if (id === 'shared') return config.tools.shared !== false
```

`desktopToolInstruction` already feeds the desktop environment section in `systemPrompt.ts`. Leave `systemPrompt.ts` unchanged. When `enabled.has('shared')`, append:

`shared_read and shared_list use the workspace shared folder, the same files for every coworker. They do not write, rename, or delete. Pass a visible relative path. Private Files stay on fs_read and fs_list.`

Do not include `sharedDir()` or any absolute host path. The hosted `environmentNote` does, and the desktop prompt must not.

Chat labels for `shared_read` and `shared_list` are already in `packages/contracts/src/chat-tool-display.ts`. No label edit.

`apps/ui/components/desktop/DesktopWorkspaceMenu.tsx`: optional `onSharedFiles?: () => void` beside Shared database. Import `Folder` from `lucide-react`.

```tsx
{onSharedFiles && <DropdownMenuItem onSelect={() => { openingControlCenter.current = true; onSharedFiles() }}><Folder /> Shared files</DropdownMenuItem>}
```

`apps/ui/components/desktop/DesktopApp.tsx`: add `sharedFilesOpen` next to every `sharedDataOpen` gate. That is the comma shortcut guard and its effect dependencies, `controlCenterDisabled`, `boardDisabled`, both `visibleSessionId` expressions, and the `CoworkerChat` `selected` expression. Pass `onSharedFiles={() => { if (!controlCenterDisabled && !isDesktopQuitting()) setSharedFilesOpen(true) }}` on `DesktopWorkspaceMenu`. Mount beside `DesktopSharedData`:

```tsx
<DesktopSharedFiles hideTrigger dialogControl={{ open: sharedFilesOpen, onOpenChange: setSharedFilesOpen }} onCloseAutoFocus={event => {
    const target = boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
    if (target && !isDesktopQuitting()) { event.preventDefault(); target.focus({ preventScroll: true }) }
}} />
```

`apps/ui/lib/desktop/control-center.ts`: add `'shared_files'` to `DESKTOP_CONTROL_COMMAND_IDS`. Add `sharedFiles?: boolean` to `DesktopControlCommandOptions`. When that option is set, push:

```ts
{ id: 'shared_files', group: 'actions', label: 'Shared files', keywords: ['documents', 'import', 'markdown', 'txt'] }
```

`DesktopControlCenter.tsx`: add `FolderIcon` from `@/lib/icons` to `COMMAND_ICONS`, add `onSharedFiles?: () => void` to the props, pass `sharedFiles: !!onSharedFiles` into `buildDesktopControlCommands`, and add `shared_files: current.onSharedFiles` to the `commandRow` action map. The existing `close(); action()` path is enough. Do not call the hosted `openKnowledgeBase('files')`.

`DesktopApp` passes `onSharedFiles` into `DesktopControlCenter` with the same disabled and quitting guard as the menu callback.

Route policy: leave `desktopRouteAllowed` false for `/shared/files`. `apps/engine/src/desktop/policy.test.ts` already asserts that denial. Do not add an engine HTTP route. `apps/ui/proxy.ts` already continues `/api/desktop/`, which covers `/api/desktop/shared-files` and `/api/desktop/shared-files/read`. Do not add a raw-byte, media, or publication route. Do not change the VNC bridge or the Codex native grant catalog. `card_file` stays on private Files.

## Panel behavior

The dialog title is Shared files. Breadcrumbs use `BrainTopBar` with root label `Files`. Folder rows use `FileList`. A `.txt` or `.md` file uses `FilePreview` with an empty `rawUrl`, so the text branch renders the page and no media element is created. Other names show `Only .txt and .md files can be previewed.` Sibling previous and next include only `.txt` and `.md`. A truncated page shows the same orange `Truncated` badge as the hosted file view. The server’s error string is shown as returned.

`FileList` still draws Rename, Delete, and Download, and Delete still opens its confirm dialog (`deleted from the box`). Those handlers toast and make no request:

- Rename: `Shared files can’t be renamed here.`
- Delete: `Shared files can’t be deleted here.`
- Download: `Open a .txt or .md file to preview it. Download isn’t available for shared files.`

Upload imports each dropped file in order into the current folder plus the drop’s relative subdirectory. A collision toasts the server message and leaves the existing bytes. The hosted `FileList` empty sentence still says coworkers’ downloads and edits land in the folder. That sentence is not true for this slice. It remains because `FileList` is shared with the hosted product and was not edited.

## Limits

- No shared write, edit, search, rename, delete, media preview, download, or publication.
- The model grant stays off until root adds `'shared'` and replaces the pending catalog row. Leaving the pending row in place would advertise `shared_write` once the id is granted, because `desktopToolInstruction` lists catalog tool names without checking `available`.
- Linux open and wrong-uid refusal were not run.
- The deletion-marker tool path was not covered by a regression.
- `FileList` menus and copy remain the hosted ones.
- Checks and Mac acceptance were not run.
